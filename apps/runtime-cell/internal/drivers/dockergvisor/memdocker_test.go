package dockergvisor

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

// memDocker is a Docker daemon in memory: it keeps the containers and
// networks the driver makes, filters them as `docker ps` does, and a
// compose down removes the project's containers. Enough for the
// conformance suite to create, list, renew and destroy.
type memDocker struct {
	// buildErr, when set, is what every RunBuild fails with.
	buildErr error
	// buildOutput is what every RunBuild prints, line by line, to the
	// context's output sink (BuildKit's progress on stderr).
	buildOutput []string
	// duringBuild, when set, runs inside every RunBuild, as if while the
	// builder runs.
	duringBuild func(dockercli.BuildRun)
	mu          sync.Mutex
	seq         int
	containers  map[string]dockercli.Container // by name
	networks    map[string]map[string]string   // name -> labels
	subnets     map[string]string              // name -> subnet
	builds      []dockercli.BuildRun           // every build run, in order
	images      map[string]bool                // loaded image tags
	// layers is each image's one layer, by tag: what its build wrote (the
	// build's tag), copied by a tag, saved by SaveImage, read back by a load
	// of a docker save archive.
	layers map[string]string
	// layerPrefix is what every build writes into its layer before the rest.
	layerPrefix string
	// saveErr, when set, is what every SaveImage fails with.
	saveErr     error
	volumes     map[string]memVolume // by name
	copyParents []string
	copies      []string  // every volume copy, "runtime from->to"
	execs       []memExec // every exec, in order
	ups         []string  // every compose up's project, in order
	// imageConfigs are what ImageConfig answers, by image reference.
	imageConfigs map[string]dockercli.ImageConfig
	execAnswer   kodyexec.Result
	// execFor, when set, answers each exec instead of execAnswer.
	execFor func(memExec) kodyexec.Result
	inputs  []memInput // every exec with input, in order
	// inputErr is what every ExecInput fails with.
	inputErr error
	// securityOptions are what docker info lists (none: no user namespace).
	securityOptions []string
	// registries are the registry containers run, in order; pushed the
	// digest each pushed build reported, by digest; pulls every pull.
	registries []dockercli.RegistrySpec
	pushed     map[string]string
	pulls      []string
	// pushBytes, when set, is what every push adds to the registry's storage.
	pushBytes int
	// servicePulls are the service images PullServiceImage was asked for,
	// "<ref> <maxBytes>" each, in order; imageSizes what each image weighs
	// (0 when unset), and pullErr what a pull of a ref fails with.
	// networkCreated is when each network was made, by name (zero: long
	// ago).
	networkCreated map[string]time.Time
	servicePulls   []string
	imageSizes     map[string]int64
	pullErr        map[string]error
	// diskUsage is what DiskUsage answers.
	diskUsage dockercli.DiskUsage
}

func (m *memDocker) DiskUsage(context.Context) (dockercli.DiskUsage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.diskUsage, nil
}

type memVolume struct {
	labels map[string]string
	data   string
	marker string
}

func (m *memDocker) CopyVolumeGeneration(ctx context.Context, runtime, helper, from, to string, labels map[string]string, parent, expected, write string) error {
	return m.copyGeneration(from, to, expected, write, func() error { return m.CopyVolumeBound(ctx, runtime, helper, from, to, labels, parent) })
}

func (m *memDocker) copyGeneration(from, to, expected, write string, copyFn func() error) error {
	if expected != "" {
		v, ok := m.volume(from)
		if !ok || v.marker != expected {
			return errors.New("generation marker missing")
		}
	}
	if err := copyFn(); err != nil {
		return err
	}
	if write != "" {
		m.mu.Lock()
		v := m.volumes[to]
		v.marker = write
		m.volumes[to] = v
		m.mu.Unlock()
	}
	return nil
}

func newMemDocker() *memDocker {
	return &memDocker{containers: map[string]dockercli.Container{}, networks: map[string]map[string]string{}, subnets: map[string]string{}, images: map[string]bool{}, volumes: map[string]memVolume{}}
}

// labelled reports whether c carries every label; an empty value asks only
// that the key be there, as `--filter label=key` does.
func labelled(c dockercli.Container, labels map[string]string) bool {
	for k, v := range labels {
		have, ok := c.Labels[k]
		if !ok || (v != "" && have != v) {
			return false
		}
	}
	return true
}

func (m *memDocker) plant(c dockercli.Container) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.containers[c.Name] = c
}

func (m *memDocker) APIVersion(context.Context) (string, error) { return "1.52", nil }

func (m *memDocker) Runtimes(context.Context) ([]string, error) {
	return []string{"runc", "runsc"}, nil
}

func (m *memDocker) SecurityOptions(context.Context) ([]string, error) {
	return m.securityOptions, nil
}

func (m *memDocker) RunHolder(_ context.Context, h dockercli.HolderSpec) (dockercli.Container, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.containers[h.Name]; ok {
		return dockercli.Container{}, fmt.Errorf("conflict: container %s exists", h.Name)
	}
	m.seq++
	c := dockercli.Container{
		CgroupParent: h.CgroupParent, PID: 1000 + m.seq, ID: fmt.Sprintf("c%04d", m.seq), Name: h.Name, Image: h.Image, Labels: maps.Clone(h.Labels),
		Networks: map[string]string{h.Network: fmt.Sprintf("172.30.0.%d", m.seq+1)},
	}
	m.containers[h.Name] = c
	return c, nil
}

// Remove takes a name or an id, as docker rm does.
func (m *memDocker) Remove(_ context.Context, name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for n, c := range m.containers {
		if n == name || c.ID == name {
			delete(m.containers, n)
		}
	}
	return nil
}

func (m *memDocker) IDs(_ context.Context, f dockercli.Filters) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var ids []string
	for _, c := range m.containers {
		ok := true
		for _, pattern := range f["name"] {
			if !regexp.MustCompile(pattern).MatchString("/" + c.Name) {
				ok = false
			}
		}
		for _, n := range f["network"] {
			if _, on := c.Networks[n]; !on {
				ok = false
			}
		}
		for _, l := range f["label"] {
			k, v, _ := strings.Cut(l, "=")
			if !labelled(c, map[string]string{k: v}) {
				ok = false
			}
		}
		if ok {
			ids = append(ids, c.ID)
		}
	}
	return ids, nil
}

func (m *memDocker) LabelsOf(_ context.Context, keys ...string) ([]dockercli.LabelledContainer, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []dockercli.LabelledContainer
	for _, c := range m.containers {
		lc := dockercli.LabelledContainer{ID: c.ID, Names: []string{strings.TrimPrefix(c.Name, "/")}, Labels: map[string]string{}}
		for _, k := range keys {
			lc.Labels[k] = c.Labels[k]
		}
		out = append(out, lc)
	}
	return out, nil
}

func (m *memDocker) Inspect(_ context.Context, ids ...string) ([]dockercli.Container, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []dockercli.Container
	for _, c := range m.containers {
		for _, id := range ids {
			if c.ID == id || c.Name == id {
				out = append(out, c)
			}
		}
	}
	return out, nil
}

func (m *memDocker) List(_ context.Context, labels map[string]string) ([]dockercli.Container, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []dockercli.Container
	for _, c := range m.containers {
		if labelled(c, labels) {
			out = append(out, c)
		}
	}
	return out, nil
}

func (m *memDocker) ComposeConfig(context.Context, dockercli.ComposeProject) ([]byte, error) {
	return nil, nil
}
func (m *memDocker) ComposeUp(_ context.Context, p dockercli.ComposeProject) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ups = append(m.ups, p.Name)
	return nil
}
func (m *memDocker) ComposeStop(context.Context, string) error { return nil }

func (m *memDocker) PullServiceImage(_ context.Context, ref string, maxBytes int64, fresh bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	how := " here"
	if fresh {
		how = " fresh"
	}
	m.servicePulls = append(m.servicePulls, ref+" "+strconv.FormatInt(maxBytes, 10)+how)
	if err := m.pullErr[ref]; err != nil {
		return err
	}
	if size := m.imageSizes[ref]; maxBytes > 0 && size > maxBytes {
		return fmt.Errorf("%w: %s", driver.ErrImageTooLarge, ref)
	}
	if m.images == nil {
		m.images = map[string]bool{}
	}
	m.images[ref] = true
	return nil
}
func (m *memDocker) ComposeStopServices(context.Context, string, ...string) error {
	return nil
}
func (m *memDocker) ComposeStart(context.Context, string) error { return nil }
func (m *memDocker) ComposeKill(context.Context, string, string, ...string) error {
	return nil
}

func (m *memDocker) ComposeDown(_ context.Context, project string, volumes bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for name, c := range m.containers {
		if c.Labels["com.docker.compose.project"] == project {
			delete(m.containers, name)
		}
	}
	if volumes {
		for name, v := range m.volumes {
			if v.labels["com.docker.compose.project"] == project {
				delete(m.volumes, name)
			}
		}
	}
	return nil
}

// plantVolume is a volume compose made for the project, holding data.
func (m *memDocker) plantVolume(project, key, data string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.volumes[project+"_"+key] = memVolume{labels: map[string]string{"com.docker.compose.project": project, "com.docker.compose.volume": key}, data: data}
}

func (m *memDocker) volume(name string) (memVolume, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.volumes[name]
	return v, ok
}

func (m *memDocker) Volumes(_ context.Context, labels map[string]string) ([]dockercli.Volume, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []dockercli.Volume
	for name, v := range m.volumes {
		if labelled(dockercli.Container{Labels: v.labels}, labels) {
			out = append(out, dockercli.Volume{Name: name, Labels: maps.Clone(v.labels)})
		}
	}
	return out, nil
}

func (m *memDocker) VolumeRemove(_ context.Context, names ...string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, n := range names {
		delete(m.volumes, n)
	}
	return nil
}

func (m *memDocker) CopyVolumeIn(_ context.Context, runtime, _, from, to string, labels map[string]string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	src, ok := m.volumes[from]
	if !ok {
		return fmt.Errorf("no such volume: %s", from)
	}
	dst, exists := m.volumes[to]
	switch {
	case labels != nil:
		dst = memVolume{labels: maps.Clone(labels)}
	case !exists:
		return fmt.Errorf("no such volume: %s", to)
	}
	dst.data = src.data
	m.volumes[to] = dst
	m.copies = append(m.copies, runtime+" "+from+"->"+to)
	return nil
}

func (m *memDocker) NetworkCreate(_ context.Context, n dockercli.NetworkSpec) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, dup := m.networks[n.Name]; dup {
		// As Docker: a second network of a name is refused, never relabelled.
		return fmt.Errorf("network with name %s already exists", n.Name)
	}
	for _, s := range m.subnets {
		if s == n.Subnet && s != "" {
			return fmt.Errorf("Pool overlaps with other one on this address space")
		}
	}
	m.networks[n.Name] = maps.Clone(n.Labels)
	m.subnets[n.Name] = n.Subnet
	return nil
}

func (m *memDocker) NetworkSubnet(_ context.Context, name string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.subnets[name]; s != "" {
		return s, nil
	}
	return "", fmt.Errorf("network %s has no subnet", name)
}

// NetworksLabelled lists the networks with every one of labels; each was
// made at networkCreated's time (the zero time when unset: long ago).
func (m *memDocker) NetworksLabelled(_ context.Context, labels map[string]string) ([]dockercli.Network, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []dockercli.Network
	for name, l := range m.networks {
		match := true
		for k, v := range labels {
			match = match && l[k] == v
		}
		if match {
			out = append(out, dockercli.Network{Name: name, Created: m.networkCreated[name], Labels: maps.Clone(l)})
		}
	}
	return out, nil
}

func (m *memDocker) NetworkLabels(_ context.Context, name string) (map[string]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.networks[name], nil
}

func (m *memDocker) NetworkRemove(_ context.Context, name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.containers {
		if _, on := c.Networks[name]; on {
			return fmt.Errorf("error while removing network: network %s has active endpoints", name)
		}
	}
	delete(m.networks, name)
	delete(m.subnets, name)
	return nil
}

func (m *memDocker) NetworkConnect(_ context.Context, network, container string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.containers[container]
	if !ok {
		return "", fmt.Errorf("no such container: %s", container)
	}
	if _, ok := m.networks[network]; !ok {
		return "", fmt.Errorf("network %s not found", network)
	}
	m.seq++
	addr := fmt.Sprintf("172.31.%d.2", m.seq)
	c.Networks = maps.Clone(c.Networks)
	if c.Networks == nil {
		c.Networks = map[string]string{}
	}
	c.Networks[network] = addr
	m.containers[container] = c
	return addr, nil
}

func (m *memDocker) NetworkDisconnect(_ context.Context, network, container string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.containers[container]; ok {
		c.Networks = maps.Clone(c.Networks)
		delete(c.Networks, network)
		m.containers[container] = c
	}
	return nil
}

func (m *memDocker) RunBuild(ctx context.Context, b dockercli.BuildRun) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.builds = append(m.builds, b)
	if sink := dockercli.OutputFrom(ctx); sink != nil {
		for _, l := range m.buildOutput {
			sink(l)
		}
	}
	if m.duringBuild != nil {
		m.duringBuild(b)
	}
	if m.buildErr != nil {
		return m.buildErr
	}
	if b.CacheTo != "" {
		if err := os.WriteFile(filepath.Join(b.CacheTo, "index.json"), []byte(b.Tag), 0o644); err != nil {
			return err
		}
	}
	if b.Push != nil {
		// A registry build: the digest in the metadata file, the layers in the
		// registry's storage.
		m.seq++
		digest := fmt.Sprintf("sha256:%064x", m.seq)
		if m.pushed == nil {
			m.pushed = map[string]string{}
		}
		m.pushed[digest] = b.Push.Repo
		if m.pushBytes > 0 && len(m.registries) > 0 {
			blob := filepath.Join(m.registries[len(m.registries)-1].StorageDir, "pushed-"+strconv.Itoa(m.seq))
			if err := os.WriteFile(blob, make([]byte, m.pushBytes), 0o600); err != nil {
				return err
			}
		}
		return os.WriteFile(filepath.Join(b.Out, dockercli.BuildMetadata), []byte(`{"containerimage.digest":"`+digest+`"}`), 0o644)
	}
	m.layer(b.Tag, m.layerPrefix+"built "+b.Tag)
	return os.WriteFile(filepath.Join(b.Out, dockercli.BuildTarball), []byte(b.Tag), 0o644)
}

func (m *memDocker) layer(tag, content string) {
	if m.layers == nil {
		m.layers = map[string]string{}
	}
	m.layers[tag] = content
}

// SaveImage writes what docker save writes: manifest.json naming the image's
// config and its one layer, each a blob under blobs/sha256 named by its digest.
func (m *memDocker) SaveImage(_ context.Context, ref, tarball string) error {
	m.mu.Lock()
	ok, layer, failed := m.images[ref], m.layers[ref], m.saveErr
	m.mu.Unlock()
	if failed != nil {
		return failed
	}
	if !ok {
		return fmt.Errorf("%w: %s", dockercli.ErrNoSuchImage, ref)
	}
	f, err := os.Create(tarball) //nolint:gosec // G304: the driver's own work file
	if err != nil {
		return err
	}
	tw := tar.NewWriter(f)
	add := func(name string, b []byte) {
		if err == nil {
			err = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(b)), Typeflag: tar.TypeReg})
		}
		if err == nil {
			_, err = tw.Write(b)
		}
	}
	blob := func(b []byte) string {
		s := sha256.Sum256(b)
		p := "blobs/sha256/" + hex.EncodeToString(s[:])
		add(p, b)
		return p
	}
	cfg := blob([]byte(`{"architecture":"amd64","os":"linux","rootfs":{"type":"layers"}}`))
	l := blob([]byte(layer))
	manifest, _ := json.Marshal([]map[string]any{{"Config": cfg, "RepoTags": []string{ref}, "Layers": []string{l}}})
	add("manifest.json", manifest)
	return errors.Join(err, tw.Close(), f.Close())
}

func (m *memDocker) RunRegistry(_ context.Context, s dockercli.RegistrySpec) (dockercli.Container, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.registries = append(m.registries, s)
	c := dockercli.Container{ID: s.Name, Name: s.Name, Image: s.Image, Labels: s.Labels, Networks: map[string]string{s.Network: "10.250.0.2", s.ClaimNetwork: s.ClaimIP}}
	m.containers[s.Name] = c
	return c, nil
}

// PullImage fetches the manifest through the address it is given (the
// cell's loopback forward), as Docker's pull does, and keeps the image.
func (m *memDocker) PullImage(ctx context.Context, ref string) error {
	host, rest, _ := strings.Cut(ref, "/")
	repo, digest, _ := strings.Cut(rest, "@")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+host+"/v2/"+repo+"/manifests/"+digest, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("pull %s: %d", ref, resp.StatusCode)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pulls = append(m.pulls, ref)
	m.images[ref] = true
	return nil
}

func (m *memDocker) UntagImage(_ context.Context, ref string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.images, ref)
	return nil
}

// LoadImage loads a build's tarball (its tag as text) or, as Docker does, a
// docker save archive, after the cell's own check of it (CheckImageTarball):
// the image named, with the layer its manifest names.
func (m *memDocker) LoadImage(_ context.Context, l dockercli.ImageLoad) error {
	tag, err := os.ReadFile(l.Tarball)
	if err != nil {
		return err
	}
	if !bytes.Contains(tag, []byte("manifest.json")) {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.images[string(tag)] = true
		return nil
	}
	if err := dockercli.CheckImageTarball(l); err != nil {
		return err
	}
	files := map[string][]byte{}
	tr := tar.NewReader(bytes.NewReader(tag))
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		files[h.Name], _ = io.ReadAll(tr)
	}
	var saved []struct{ Layers []string }
	if err := json.Unmarshal(files["manifest.json"], &saved); err != nil || len(saved) != 1 || len(saved[0].Layers) != 1 {
		return fmt.Errorf("memdocker: archive manifest %q", files["manifest.json"])
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.images[l.Tag] = true
	m.layer(l.Tag, string(files[saved[0].Layers[0]]))
	return nil
}

func (m *memDocker) RemoveImage(_ context.Context, ref string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.images, ref)
	return nil
}

func (m *memDocker) TagImage(_ context.Context, src, dst string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.images[src] {
		return fmt.Errorf("%w: %s", dockercli.ErrNoSuchImage, src)
	}
	m.images[dst] = true
	if l, ok := m.layers[src]; ok {
		m.layer(dst, l)
	}
	return nil
}

func (m *memDocker) ImageRefs(_ context.Context, repo string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for ref := range m.images {
		if strings.HasPrefix(ref, repo+":") {
			out = append(out, ref)
		}
	}
	return out, nil
}

// Exec records the command and answers what execAnswer says, or execFor
// when set.
func (m *memDocker) Exec(_ context.Context, e dockercli.ExecSpec, req, host kodyexec.Request) kodyexec.Result {
	m.mu.Lock()
	defer m.mu.Unlock()
	x := memExec{spec: e, req: req, host: host}
	m.execs = append(m.execs, x)
	if m.execFor != nil {
		return m.execFor(x)
	}
	return m.execAnswer
}

// ExecInput records the command and its input; it fails with inputErr.
func (m *memDocker) ExecInput(_ context.Context, container string, stdin []byte, argv ...string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.inputs = append(m.inputs, memInput{container: container, stdin: string(stdin), argv: argv})
	return nil, m.inputErr
}

type memInput struct {
	container, stdin string
	argv             []string
}

type memExec struct {
	spec      dockercli.ExecSpec
	req, host kodyexec.Request
}

func (m *memDocker) CopyVolumeBound(ctx context.Context, runtime, helper, from, to string, labels map[string]string, parent string) error {
	m.mu.Lock()
	m.copyParents = append(m.copyParents, parent)
	m.mu.Unlock()
	return m.CopyVolumeIn(ctx, runtime, helper, from, to, labels)
}

func (m *memDocker) CgroupInfo(context.Context) (dockercli.CgroupDaemonInfo, error) {
	return dockercli.CgroupDaemonInfo{Version: "2", Driver: "cgroupfs"}, nil
}

func (m *memDocker) DaemonEndpoint(context.Context) (string, error) {
	return "unix:///var/run/docker.sock", nil
}

func (m *memDocker) ImageConfig(_ context.Context, ref string) (dockercli.ImageConfig, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.imageConfigs[ref], nil
}

func (m *memDocker) ImageLabels(context.Context, string) (map[string]string, error) {
	return map[string]string{}, nil
}

// ComposePs, ComposeLogs and ComposeLogsWindow: the in-memory daemon runs
// no compose services, so a project lists none and logs nothing.
func (m *memDocker) ComposePs(context.Context, string) ([]byte, error) { return nil, nil }

func (m *memDocker) ComposeLogs(context.Context, string, string, int) ([]byte, error) {
	return nil, nil
}

func (m *memDocker) ComposeLogsWindow(context.Context, string, string, time.Time, time.Time, int) ([]byte, error) {
	return nil, nil
}

// DataRoot: the in-memory daemon has no data root on a disk, so no
// machine's writes are bound to one.
func (m *memDocker) DataRoot(context.Context) (string, error) {
	return "", errors.New("memdocker: no data root")
}
