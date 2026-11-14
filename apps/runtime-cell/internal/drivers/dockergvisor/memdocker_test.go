package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
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
	volumes     map[string]memVolume           // by name
	copyParents []string
	copies      []string  // every volume copy, "runtime from->to"
	execs       []memExec // every exec, in order
	execAnswer  kodyexec.Result
	// execFor, when set, answers each exec instead of execAnswer.
	execFor func(memExec) kodyexec.Result
	inputs  []memInput // every exec with input, in order
	// inputErr is what every ExecInput fails with.
	inputErr error
	// securityOptions are what docker info lists (none: no user namespace).
	securityOptions []string
}

type memVolume struct {
	labels map[string]string
	data   string
	marker string
}

func (m *memDocker) CopyVolumeGeneration(ctx context.Context, runtime, helper, from, to string, labels map[string]string, parent, expected, write string) error {
	return m.copyGeneration(from, to, expected, write, func() error { return m.CopyVolumeBound(ctx, runtime, helper, from, to, labels, parent) })
}

func (m *memDocker) copyGeneration(from, to, expected, write string, copy func() error) error {
	if expected != "" {
		v, ok := m.volume(from)
		if !ok || v.marker != expected {
			return errors.New("generation marker missing")
		}
	}
	if err := copy(); err != nil {
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
	c := dockercli.Container{CgroupParent: h.CgroupParent, PID: 1000 + m.seq, ID: fmt.Sprintf("c%04d", m.seq), Name: h.Name, Image: h.Image, Labels: maps.Clone(h.Labels),
		Networks: map[string]string{h.Network: fmt.Sprintf("172.30.0.%d", m.seq+1)}}
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
func (m *memDocker) ComposeUp(context.Context, dockercli.ComposeProject) error { return nil }
func (m *memDocker) ComposeStop(context.Context, string) error                 { return nil }
func (m *memDocker) ComposeStopServices(context.Context, string, ...string) error {
	return nil
}
func (m *memDocker) ComposeStart(context.Context, string) error { return nil }

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
	if sink := driver.OutputFrom(ctx); sink != nil {
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
	return os.WriteFile(filepath.Join(b.Out, dockercli.BuildTarball), []byte(b.Tag), 0o644)
}

func (m *memDocker) LoadImage(_ context.Context, tarball string) error {
	tag, err := os.ReadFile(tarball)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.images[string(tag)] = true
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

func (m *memDocker) ImageLabels(context.Context, string) (map[string]string, error) { return nil, nil }
