package k8ssandbox

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildfingerprint"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildmirror"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildprogress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/kube"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockerignore"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// Image builds (docs/runtime/kubernetes-environment-runs.md, "Image
// builds"): each build section of the project runs in a builder pod of its
// own (kube.BuilderPod: rootless BuildKit on the claim's RuntimeClass in the
// environment namespace, the claim's labels in the builder's role, so every
// cleanup by the claim's labels ends it too), one after the other and before
// any service pod. Through the pod's init container the cell writes its
// hosts file (EnvConfig.BuildHosts), copies the build's context (read
// through os.Root, .dockerignore applied, symlinks kept as links) and
// BuildKit's config, then opens the gate; once buildkitd answers, buildctl
// runs in it over pods/exec, its progress streamed line by line to the
// boot's output and read by buildprogress. The image is pushed to
// EnvConfig.BuildRegistry and the services run it by digest from
// BuildRegistryPull. The builder pod is deleted after its build.

// buildSock is where the rootless image's buildkitd listens.
const buildSock = "unix:///run/user/1000/buildkit/buildkitd.sock"

// buildMetadata is where buildctl leaves the pushed image's digest.
const buildMetadata = "/tmp/kodus-build-metadata.json"

var (
	registryHostPort = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$`)
	imageDigest      = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

// builtImage is one service's image the machine's builds pushed.
type builtImage struct{ fp, image string }

// buildsOn says the cell builds images: a builder image and a registry.
func (c *EnvConfig) buildsOn() bool { return c.BuilderImage != "" && c.BuildRegistry != "" }

func (c *EnvConfig) buildDefaults() error {
	if c.BuilderImage == "" && c.BuildRegistry == "" {
		return nil
	}
	if !c.buildsOn() {
		return errors.New("k8ssandbox: image builds need both the builder image and the build registry")
	}
	if c.BuildRegistryPull == "" {
		c.BuildRegistryPull = c.BuildRegistry
	}
	for _, r := range []string{c.BuildRegistry, c.BuildRegistryPull} {
		if !registryHostPort.MatchString(r) {
			return fmt.Errorf("k8ssandbox: build registry %q is not host[:port]", r)
		}
	}
	if c.BuildMirror != "" {
		if _, err := buildmirror.RegistryConfig(c.BuildMirror); err != nil {
			return err
		}
	}
	for name, ip := range c.BuildHosts {
		if !registryHostPort.MatchString(name) || strings.Contains(name, ":") || !validIP(ip) {
			return fmt.Errorf("k8ssandbox: build host %q at %q is not a name and an address", name, ip)
		}
	}
	if c.MaxContextBytes == 0 {
		c.MaxContextBytes = 256 << 20
	}
	return nil
}

func validIP(s string) bool {
	_, err := netip.ParseAddr(s)
	return err == nil
}

// prebuilt are placeholders for every build, so the whole file is checked
// (Render) before anything is built.
func prebuilt(builds []sandbox.Build) map[string]string {
	out := make(map[string]string, len(builds))
	for _, b := range builds {
		out[b.Service] = "kodus-build/unbuilt"
	}
	return out
}

// buildsAskingSecrets refuses a build that asks for an org secret the claim
// holds: on docker-gvisor only a builder trusting the cell CA gets them (as
// placeholders the injector swaps), and on Kubernetes the builder neither
// trusts the CA nor is a source of the claim's egress policy yet.
func buildsAskingSecrets(builds []sandbox.Build, claim map[string]string) error {
	var v []sandbox.Violation
	for _, b := range builds {
		for _, id := range slices.Sorted(maps.Keys(b.Secrets)) {
			if _, ok := claim[b.Secrets[id]]; ok {
				v = append(v, sandbox.Violation{Path: "services." + b.Service + ".build.secrets." + id,
					Reason: "a build that reads org secrets needs a builder that trusts the cell CA, not wired on Kubernetes yet"})
			}
		}
	}
	if len(v) > 0 {
		return fmt.Errorf("%w: %w", driver.ErrUnsupported, &kube.UnsupportedError{Violations: v})
	}
	return nil
}

// buildImages gives every build section an image in the registry, by
// digest. A build whose fingerprint (context, Dockerfile, target, args and
// the builder) the machine already pushed (a reset's next Up), or that
// another service of this Up shares, is not built again.
func (b *envBoot) buildImages(ctx context.Context, builds []sandbox.Build, opts kube.Options) (map[string]string, error) {
	e := b.e()
	if b.st.built == nil {
		b.st.built = map[string]builtImage{}
	}
	if pol := kube.BuildPolicy(opts, e.BuildEgress); pol != nil {
		if _, err := e.API.CreateObject(ctx, e.Namespace, ResourceNetworkPolicies, pol); err != nil && !IsConflict(err) {
			return nil, err
		}
	}
	out := map[string]string{}
	madeHere := map[string]string{}
	for _, bl := range builds {
		fp, err := buildfingerprint.Of(bl, e.BuilderImage)
		if err != nil {
			e.Log.Warn("build.fingerprint.failed", "machine", b.req.Ref.MachineID, "service", bl.Service, "err", err)
			fp = ""
		}
		if img := madeHere[fp]; fp != "" && img != "" {
			out[bl.Service] = img
			b.st.built[bl.Service] = builtImage{fp, img}
			e.Log.Info("build.done", "machine", b.req.Ref.MachineID, "service", bl.Service, "reused", true, "source", "service")
			continue
		}
		if had := b.st.built[bl.Service]; fp != "" && had.fp == fp {
			out[bl.Service] = had.image
			e.Log.Info("build.done", "machine", b.req.Ref.MachineID, "service", bl.Service, "reused", true, "source", "machine")
			continue
		}
		img, err := b.runBuild(ctx, bl, fp, opts)
		if err != nil {
			return nil, err
		}
		out[bl.Service] = img
		b.st.built[bl.Service] = builtImage{fp, img}
		if fp != "" {
			madeHere[fp] = img
		}
	}
	return out, nil
}

// buildRepo is the build's repository in the registry: per claim and
// service; its tag is the build's fingerprint.
func buildRepo(claim, service string) string {
	return "kodus-build/" + strings.ToLower(claim) + "/" + kube.ServiceSlug(service)
}

// runBuild runs one build in its builder pod and returns the image as the
// nodes pull it (BuildRegistryPull, by digest). The pod is deleted after it,
// whatever happened.
func (b *envBoot) runBuild(ctx context.Context, bl sandbox.Build, fp string, opts kube.Options) (string, error) {
	e := b.e()
	bp, err := kube.BuilderPod(opts, kube.BuildPod{Service: bl.Service, Image: e.BuilderImage, Storage: e.BuildStorage})
	if err != nil {
		return "", err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), e.StopTimeout)
		defer cancel()
		if err := b.d.deletePod(cleanup, bp.PodName); err != nil {
			e.Log.Warn("build.pod.delete.failed", "machine", b.req.Ref.MachineID, "service", bl.Service, "err", err)
		}
	}()
	ctxTar, err := contextTar(bl, e.MaxContextBytes)
	if err != nil {
		return "", err
	}
	conf, err := b.buildkitdConfig()
	if err != nil {
		return "", err
	}
	if _, err := e.API.CreatePod(ctx, e.Namespace, bp.Pod, false); err != nil {
		return "", fmt.Errorf("k8ssandbox: builder pod of %s: %w", bl.Service, err)
	}
	svc := kube.Service{Name: "the builder of " + bl.Service, PodName: bp.PodName, Container: kube.BuilderContainer}
	if _, err := b.waitPod(ctx, svc, "address"); err != nil {
		return "", builderFailed(err)
	}
	if _, err := b.init(ctx, bp.PodName, "hosts", nil, b.buildHostsFile()); err != nil {
		return "", builderFailed(err)
	}
	if _, err := b.init(ctx, bp.PodName, "copy", []string{kube.BuildConfigDir}, conf); err != nil {
		return "", builderFailed(err)
	}
	if _, err := b.d.initOp(ctx, bp.PodName, "copy", []string{kube.BuildContextDir}, ctxTar, 1<<20); err != nil {
		return "", builderFailed(err)
	}
	if _, err := b.init(ctx, bp.PodName, "open", nil, nil); err != nil {
		return "", builderFailed(err)
	}
	if _, err := b.waitPod(ctx, svc, "ready"); err != nil {
		return "", builderFailed(err)
	}
	b.say("$ build " + bl.Service)
	tag := fp
	if tag == "" {
		tag = "t" + strconv.FormatInt(b.d.cfg.Now().UnixNano(), 36)
	}
	push := e.BuildRegistry + "/" + buildRepo(b.claim, bl.Service) + ":" + tag
	steps := buildprogress.NewAt(b.d.cfg.Now)
	start := b.d.cfg.Now()
	code, err := e.Exec.StreamCommand(ctx, e.Namespace, bp.PodName, kube.BuilderContainer, buildctlArgv(bl, push, e.BuildRegistryInsecure), func(line string) {
		steps.Line(line)
		b.say(line)
	})
	ran := steps.Summary(8)
	e.Log.Info("build.steps", "machine", b.req.Ref.MachineID, "service", bl.Service, "ok", err == nil && code == 0, "steps", ran.Steps,
		"done", ran.Done, "cached", ran.Cached, "errored", ran.Errored, "slowest", ran.Slowest, "ms", b.d.cfg.Now().Sub(start).Milliseconds())
	if err != nil {
		return "", builderFailed(fmt.Errorf("build %s: %w", bl.Service, err))
	}
	if code != 0 {
		return "", b.buildFailure(ctx, bp.PodName, bl.Service, code, opts.Size.MemoryMB, steps)
	}
	res, err := e.Exec.RunCommand(ctx, e.Namespace, bp.PodName, kube.BuilderContainer, []string{"cat", buildMetadata}, nil, 64<<10)
	if err != nil || res.ExitCode != 0 {
		return "", builderFailed(fmt.Errorf("build %s: no metadata: %v %s", bl.Service, err, strings.TrimSpace(string(res.Stderr))))
	}
	var md struct {
		Digest string `json:"containerimage.digest"`
	}
	if err := json.Unmarshal(res.Stdout, &md); err != nil || !imageDigest.MatchString(md.Digest) {
		return "", builderFailed(fmt.Errorf("build %s: the metadata names no image digest", bl.Service))
	}
	img := e.BuildRegistryPull + "/" + buildRepo(b.claim, bl.Service) + "@" + md.Digest
	e.Log.Info("build.done", "machine", b.req.Ref.MachineID, "service", bl.Service, "reused", false, "source", "build", "digest", md.Digest)
	return img, nil
}

func builderFailed(err error) error {
	if errors.Is(err, driver.ErrBuilderFailed) {
		return err
	}
	return fmt.Errorf("%w: %w", driver.ErrBuilderFailed, err)
}

// buildFailure says how a build that ran failed: the builder passed its
// memory (the kubelet's OOM kill), BuildKit named the step that failed (the
// repository's), or the builder ended with no step failed (the platform's).
func (b *envBoot) buildFailure(ctx context.Context, pod, service string, code, memoryMB int, steps *buildprogress.Tracker) error {
	e := b.e()
	if p, err := e.API.GetPod(ctx, e.Namespace, pod); err == nil && oomKilled(p) {
		return fmt.Errorf("%w: build %s passed the claim's %d MB", driver.ErrOutOfMemory, service, memoryMB)
	}
	f, failed := steps.Failure()
	if !failed {
		if steps.SolveFailed() {
			return fmt.Errorf("k8ssandbox: build %s: buildctl exited %d", service, code)
		}
		return builderFailed(fmt.Errorf("build %s: the builder ended (exit %d) with no step failed", service, code))
	}
	var lead strings.Builder
	fmt.Fprintf(&lead, "k8ssandbox: build %s: step %s failed:", service, f.Step)
	for _, l := range f.Lines {
		lead.WriteString("\n  " + l)
	}
	return errors.New(lead.String())
}

func oomKilled(p Object) bool {
	st, _ := p["status"].(map[string]any)
	list, _ := st["containerStatuses"].([]any)
	for _, c := range list {
		cm, _ := c.(map[string]any)
		for _, key := range []string{"state", "lastState"} {
			s, _ := cm[key].(map[string]any)
			if t, ok := s["terminated"].(map[string]any); ok && str(t["reason"]) == "OOMKilled" {
				return true
			}
		}
	}
	return false
}

// buildctlArgv is the build: the Dockerfile frontend on the copied context,
// its target and args, pushed as an OCI image, the digest in buildMetadata.
// Every value is its own argument: nothing goes through a shell.
func buildctlArgv(bl sandbox.Build, push string, insecure bool) []string {
	argv := []string{"buildctl", "--addr", buildSock, "build", "--progress", "plain", "--frontend", "dockerfile.v0",
		"--local", "context=" + kube.BuildContextMount, "--local", "dockerfile=" + kube.BuildContextMount,
		"--opt", "filename=" + filepath.ToSlash(bl.Dockerfile)}
	if bl.Target != "" {
		argv = append(argv, "--opt", "target="+bl.Target)
	}
	for _, k := range slices.Sorted(maps.Keys(bl.Args)) {
		argv = append(argv, "--opt", "build-arg:"+k+"="+bl.Args[k])
	}
	out := "type=image,name=" + push + ",push=true,oci-mediatypes=true"
	if insecure {
		out += ",registry.insecure=true"
	}
	return append(argv, "--metadata-file", buildMetadata, "--output", out)
}

// buildkitdConfig is BuildKit's config as the tar the init container
// unpacks: the registry over plain HTTP when it is insecure, docker.io
// through the mirror when there is one.
func (b *envBoot) buildkitdConfig() ([]byte, error) {
	e := b.e()
	var conf []byte
	if e.BuildMirror != "" {
		m, err := buildmirror.RegistryConfig(e.BuildMirror)
		if err != nil {
			return nil, err
		}
		conf = append(conf, m...)
	}
	if e.BuildRegistryInsecure && e.BuildRegistry != e.BuildMirror {
		conf = append(conf, fmt.Appendf(nil, "\n[registry.%q]\n  http = true\n", e.BuildRegistry)...)
	}
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: filepath.Base(kube.BuildConfigFile), Mode: 0o644, Size: int64(len(conf))}); err != nil {
		return nil, err
	}
	if _, err := tw.Write(conf); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// buildHostsFile is the builder's /etc/hosts: the names of the registry and
// the mirror (its resolver is the cell's, which knows no cluster name).
func (b *envBoot) buildHostsFile() []byte {
	var s strings.Builder
	s.WriteString("127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n")
	hosts := b.e().BuildHosts
	for _, name := range slices.Sorted(maps.Keys(hosts)) {
		fmt.Fprintf(&s, "%s\t%s\n", hosts[name], name)
	}
	return []byte(s.String())
}

// contextTar is the build's context as the tar the init container unpacks:
// read through os.Root (nothing outside the context), what .dockerignore
// excludes left out but the Dockerfile and the ignore file, a symlink kept
// as a link (never followed: BuildKit reads it inside the context), at most
// limit bytes.
func contextTar(bl sandbox.Build, limit int64) ([]byte, error) {
	root, err := os.OpenRoot(bl.Context)
	if err != nil {
		return nil, fmt.Errorf("k8ssandbox: build context: %w", err)
	}
	defer func() { _ = root.Close() }()
	fsys := root.FS()
	var ignore *dockerignore.Matcher
	if data, err := fs.ReadFile(fsys, ".dockerignore"); err == nil {
		if ignore, err = dockerignore.Compile(data); err != nil {
			return nil, &sandbox.RefusedError{Violations: []sandbox.Violation{{Path: "services." + bl.Service + ".build", Reason: ".dockerignore: " + err.Error()}}}
		}
	}
	keep := map[string]bool{filepath.ToSlash(bl.Dockerfile): true, ".dockerignore": true}
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	var total int64
	err = fs.WalkDir(fsys, ".", func(p string, de fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == "." || (ignore != nil && !keep[p] && ignore.Matches(p)) {
			return nil
		}
		info, err := de.Info()
		if err != nil {
			return err
		}
		switch {
		case info.Mode()&fs.ModeSymlink != 0:
			target, err := root.Readlink(p)
			if err != nil {
				return err
			}
			return tw.WriteHeader(&tar.Header{Typeflag: tar.TypeSymlink, Name: p, Linkname: target, Mode: 0o777})
		case info.IsDir():
			return tw.WriteHeader(&tar.Header{Typeflag: tar.TypeDir, Name: p + "/", Mode: 0o755})
		case !info.Mode().IsRegular():
			return nil
		}
		if total += info.Size(); total > limit {
			return &sandbox.RefusedError{Violations: []sandbox.Violation{{Path: "services." + bl.Service + ".build.context",
				Reason: fmt.Sprintf("the build context passes %d MiB (it is copied into the builder through the API server)", limit>>20)}}}
		}
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		mode := int64(0o644)
		if info.Mode()&0o111 != 0 {
			mode = 0o755
		}
		if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: p, Mode: mode, Size: int64(len(data))}); err != nil {
			return err
		}
		_, err = tw.Write(data)
		return err
	})
	if err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
