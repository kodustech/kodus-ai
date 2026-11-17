package k8ssandbox

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/kube"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// The environment mode (docs/runtime/kubernetes-environment-runs.md, the
// gvisor backend): a claim's compose project runs as one pod per service in
// the cell's environment namespace, rendered by internal/compose/kube. The
// workload machine is still the holder pod Create made in the sandbox
// namespace: it carries the claim's tags, size and ceiling, and the lease,
// the sweep and the reaper keep and end it as before; the project's objects
// carry the claim's labels and go with it.
//
// Every service pod starts held by its init container's gate. Up, through
// that init container (pods/exec):
//
//  1. creates the claim's NetworkPolicy, its volume claims and every pod,
//     and waits until each pod has an address;
//  2. on a first boot with golden data to take: starts the services whose
//     data a reset restores (golden), waits until they are healthy, deletes
//     them (a clean stop), recreates them and copies their volumes out
//     (tar) through the new pods' init containers: the data the database
//     made at its first start, before anything that depends on it ran;
//  3. writes every pod's /etc/hosts with every pod's address, its decoy
//     file and its checkout copies, and restores its volumes from the
//     golden copy, or empties them (a reset is compose down -v), or keeps
//     what step 2 just copied;
//  4. opens the gates in depends_on order, each when what it depends on
//     meets its condition, and waits until every service is ready.
//
// Reset deletes the pods and keeps the claims, the policy and the golden
// copy; the agent's Up after it is step 1 to 4 again. A golden copy failing
// costs the machine the fast path (its resets start from empty volumes),
// never a round.
//
// A build section runs first, in a builder pod of its own (envbuild.go). With
// ObserverImage the claim's observer machine is a pod of its own beside the
// services (envobserver.go), and PrepareClaim takes the claim's expose ports.
//
// Not here yet, refused with driver.ErrUnsupported: expose ports on a cell
// with no observer image, the cell's trust files in the services (a claim
// with org secrets), bakes and snapshots.

// EnvConfig turns on environment Runs in Namespace.
type EnvConfig struct {
	API  EnvAPI
	Exec CommandRunner
	// Namespace is the cell's environment namespace (EnvironmentNamespace):
	// Pod Security privileged, the gate, default deny.
	Namespace string
	// RuntimeClass is the services' class (the driver's when empty).
	RuntimeClass string
	// HelperImage runs every pod's init container: sh, tar and find, by
	// digest (the driver's holder image when empty).
	HelperImage string
	// Egress is where a claim's pods may connect besides each other: the
	// cell's proxy and resolver pods.
	Egress []kube.EgressPeer
	// VolumeSize and StorageClass make each named volume's claim.
	VolumeSize, StorageClass string
	// MaxGoldenBytes bounds a machine's golden copy (256 MiB when zero);
	// MaxCopyBytes a claim's checkout copies (64 MiB when zero).
	MaxGoldenBytes int64
	MaxCopyBytes   int64
	// StopTimeout bounds a pod's deletion (its grace period included).
	StopTimeout time.Duration
	Log         *slog.Logger

	// Image builds (envbuild.go), on when BuilderImage and BuildRegistry
	// are both set; without them a build section is driver.ErrUnsupported.
	// BuilderImage is rootless BuildKit (the cell's builder image, by
	// digest). BuildRegistry is the host[:port] the builder pushes to;
	// BuildRegistryPull the one the nodes pull the same images from
	// (BuildRegistry when empty); BuildRegistryInsecure pushes over plain
	// HTTP (an in-cluster registry).
	BuilderImage          string
	BuildRegistry         string
	BuildRegistryPull     string
	BuildRegistryInsecure bool
	// BuildMirror is a docker.io pull-through mirror (host:port, plain
	// HTTP) BuildKit pulls base images through; empty: none.
	BuildMirror string
	// BuildHosts are the names the builder resolves, name to address (its
	// /etc/hosts: the registry's and the mirror's; its resolver is the
	// cell's, which knows no cluster name).
	BuildHosts map[string]string
	// BuildEgress is where builder pods may connect besides the claim's
	// peers: the registry and the mirror (kube.BuildPolicy).
	BuildEgress []kube.EgressPeer
	// BuildStorage bounds BuildKit's state on the node ("10Gi" when
	// empty); MaxContextBytes a build context's copy (256 MiB when zero).
	BuildStorage    string
	MaxContextBytes int64

	// The claim's observer (envobserver.go), on when ObserverImage is set:
	// cmd/observer at kube.ObserverBinary (the cell image), by digest.
	// ObserverTLSDir is the cell's directory with the observer's cert.pem
	// and key.pem (for the cell's -observer-server-name) and ca.pem, the CA
	// of the cell's observer client certificate (docker-gvisor's
	// -gvisor-observer-tls-dir). ObserverMemoryMB and ObserverMilliCPU are
	// its share of the claim's size (256 MiB and 250 mCPU when zero), taken
	// before the services split the rest.
	ObserverImage    string
	ObserverTLSDir   string
	ObserverMemoryMB int
	ObserverMilliCPU int
}

func (c *EnvConfig) defaults(cfg Config) error {
	if c.API == nil || c.Exec == nil || c.Namespace == "" {
		return errors.New("k8ssandbox: the environment mode needs its API, exec and namespace")
	}
	if c.Namespace == cfg.Namespace {
		return errors.New("k8ssandbox: environment Runs need their own namespace (Pod Security privileged, the gate), not the restricted sandbox one")
	}
	if c.RuntimeClass == "" {
		c.RuntimeClass = cfg.RuntimeClass
	}
	if c.HelperImage == "" {
		c.HelperImage = cfg.HolderImage
	}
	if c.MaxGoldenBytes == 0 {
		c.MaxGoldenBytes = 256 << 20
	}
	if c.MaxCopyBytes == 0 {
		c.MaxCopyBytes = 64 << 20
	}
	if c.StopTimeout == 0 {
		c.StopTimeout = 2 * time.Minute
	}
	if c.Log == nil {
		c.Log = slog.New(slog.DiscardHandler)
	}
	if err := c.observerDefaults(); err != nil {
		return err
	}
	return c.buildDefaults()
}

// RunsEnvironments says the driver runs environment Runs (Config.Env set):
// its Parts carry Composer, Recipes, Resetter and ServiceLogs, and Exec is
// the cell's transport (transport.Compose{Run: d.Exec}).
func (d *Driver) RunsEnvironments() bool { return d.cfg.Env != nil }

// envState is what the driver keeps of a machine's project between calls.
type envState struct {
	plan *kube.Plan
	sum  [32]byte
	up   bool
	// golden is the volumes' first-boot data, by volume key; goldenOff why
	// the machine has none (its resets start from empty volumes).
	golden    map[string][]byte
	goldenOff string
	exec      *envTarget
	targets   map[string]envTarget
	// addrs are the service pods' addresses while the project is up, by
	// service: the observer's targets.
	addrs map[string]string
	// built are the images the machine's builds pushed, by service.
	built map[string]builtImage
}

type envTarget struct{ pod, container, dir string }

type envStates struct {
	mu sync.Mutex
	m  map[string]*envState
}

func (s *envStates) get(machine string) *envState {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.m == nil {
		s.m = map[string]*envState{}
	}
	st, ok := s.m[machine]
	if !ok {
		st = &envState{}
		s.m[machine] = st
	}
	return st
}

// addresses are the machine's service pods' addresses while its project is
// up; nil otherwise.
func (s *envStates) addresses(machine string) map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.m[machine]
	if !ok || !st.up {
		return nil
	}
	return st.addrs
}

func (s *envStates) forget(machine string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, machine)
}

func envPrefix(claim string) string { return "env-" + strings.ToLower(claim) }

func (d *Driver) envSelector(claim string) map[string]string {
	return map[string]string{label(driver.TagCell): d.cfg.CellID, label(driver.TagClaim): claim}
}

// holder reads the machine's holder pod (this cell's, checked) and what the
// project is rendered with from it: the claim, its org, its size and its
// ceiling, as the cluster holds them rather than as the caller's ref says.
type holderFacts struct {
	claim, org string
	size       kube.Size
	ceiling    time.Time
}

func (d *Driver) holderFacts(ctx context.Context, ref driver.MachineRef) (holderFacts, error) {
	p, _, err := d.ownPod(ctx, ref)
	if err != nil {
		return holderFacts{}, err
	}
	if p == nil {
		return holderFacts{}, fmt.Errorf("k8ssandbox: machine %s is gone", ref.MachineID)
	}
	labels, _ := meta(p)["labels"].(map[string]any)
	if role := str(labels[label(driver.TagRole)]); role != string(driver.RoleWorkload) {
		return holderFacts{}, fmt.Errorf("k8ssandbox: machine %s is a %s, not a workload", ref.MachineID, role)
	}
	ann, _ := meta(p)["annotations"].(map[string]any)
	f := holderFacts{claim: str(labels[label(driver.TagClaim)]), org: str(labels[label(driver.TagOrg)])}
	if err := driver.ValidateClaimID(f.claim); err != nil {
		return holderFacts{}, err
	}
	ceiling, ok := driver.Ceiling(map[string]string{driver.TagHardExpires: str(ann[label(driver.TagHardExpires)])})
	if !ok {
		return holderFacts{}, fmt.Errorf("k8ssandbox: machine %s has no ceiling", ref.MachineID)
	}
	f.ceiling = ceiling
	spec, _ := p["spec"].(map[string]any)
	cs, _ := spec["containers"].([]any)
	if len(cs) > 0 {
		c, _ := cs[0].(map[string]any)
		res, _ := c["resources"].(map[string]any)
		lim, _ := res["limits"].(map[string]any)
		f.size.MemoryMB = quantityMB(str(lim["memory"]))
		f.size.CPUs, _ = strconv.Atoi(str(lim["cpu"]))
	}
	if f.size.MemoryMB <= 0 || f.size.CPUs <= 0 {
		f.size = kube.Size{MemoryMB: d.cfg.DefaultClaimSize.MemoryMB, CPUs: d.cfg.DefaultClaimSize.CPUs}
	}
	return f, nil
}

// quantityMB reads the "<n>Mi" and "<n>Gi" the driver writes.
func quantityMB(q string) int {
	switch {
	case strings.HasSuffix(q, "Mi"):
		n, _ := strconv.Atoi(strings.TrimSuffix(q, "Mi"))
		return n
	case strings.HasSuffix(q, "Gi"):
		n, _ := strconv.Atoi(strings.TrimSuffix(q, "Gi"))
		return n * 1024
	}
	return 0
}

// render is the machine's project as objects.
func (d *Driver) render(req driver.UpRequest, f holderFacts, built map[string]string) (*kube.Plan, error) {
	o, root, err := d.renderOptions(req, f)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	o.Built = built
	plan, err := kube.Render(req.Compose, o)
	if errors.Is(err, kube.ErrUnsupported) {
		return nil, fmt.Errorf("%w: %w", driver.ErrUnsupported, err)
	}
	return plan, err
}

// renderOptions are what the machine's project renders with; root is the
// checkout the options read, for the caller to close.
func (d *Driver) renderOptions(req driver.UpRequest, f holderFacts) (kube.Options, *os.Root, error) {
	e := d.cfg.Env
	root, err := os.OpenRoot(req.ProjectDir)
	if err != nil {
		return kube.Options{}, nil, fmt.Errorf("k8ssandbox: the checkout: %w", err)
	}
	deadline := int64(f.ceiling.Sub(d.cfg.Now()).Seconds())
	if deadline < 1 {
		_ = root.Close()
		return kube.Options{}, nil, errors.New("k8ssandbox: the claim's ceiling passed")
	}
	labels := map[string]string{label(driver.TagCell): d.cfg.CellID, label(driver.TagOrg): f.org, label(driver.TagClaim): f.claim, label(driver.TagRole): string(driver.RoleWorkload)}
	return kube.Options{
		Namespace: e.Namespace, Prefix: envPrefix(f.claim), Labels: labels, Selector: d.envSelector(f.claim),
		Annotations:  map[string]string{label(driver.TagHardExpires): driver.FormatTime(f.ceiling)},
		RuntimeClass: e.RuntimeClass, HelperImage: e.HelperImage, Size: f.size, Reserved: e.observerReserve(), DeadlineSeconds: deadline,
		Nameservers: []string{d.cfg.EgressAddress}, Egress: e.Egress, VolumeSize: e.VolumeSize, StorageClass: e.StorageClass,
		Checkout: root.FS(), Decoy: driver.CanaryFileOf(req.Canaries) != "",
	}, root, nil
}

// Up brings the machine's compose project up on the cluster and returns its
// pods' addresses (the claim's egress Sources).
func (d *Driver) Up(ctx context.Context, req driver.UpRequest) ([]string, error) {
	if d.cfg.Env == nil {
		return nil, errNoRuns
	}
	if req.CellTrust {
		return nil, fmt.Errorf("%w: the cell's trust files in environment pods (a claim with org secrets) are not wired on Kubernetes yet", driver.ErrUnsupported)
	}
	f, err := d.holderFacts(ctx, req.Ref)
	if err != nil {
		return nil, err
	}
	e := d.cfg.Env
	// The build sections, refused all at once (sandbox.Builds: inside the
	// checkout, no remote context); with a builder, the whole file is
	// checked with placeholders before anything is built.
	builds, err := sandbox.Builds(req.Compose, sandbox.Options{ProjectDir: req.ProjectDir, Root: req.WorkspaceRoot})
	if err != nil {
		return nil, err
	}
	var pre map[string]string
	if len(builds) > 0 && e.buildsOn() {
		pre = prebuilt(builds)
	}
	plan, err := d.render(req, f, pre)
	if err != nil {
		return nil, err
	}
	if err := buildsAskingSecrets(builds, req.BuildSecrets); err != nil {
		return nil, err
	}
	for _, v := range plan.Ignored {
		e.Log.Info("compose.kube.ignored", "machine", req.Ref.MachineID, "key", v.Path, "reason", v.Reason)
	}
	st := d.envs.get(req.Ref.MachineID)
	if st.up {
		return nil, fmt.Errorf("k8ssandbox: the project of %s is up already (Reset first)", req.Ref.MachineID)
	}
	if pods, err := e.API.ListPods(ctx, e.Namespace, d.envSelector(f.claim)); err != nil {
		return nil, err
	} else if n := len(withoutObserver(pods)); n > 0 {
		return nil, fmt.Errorf("k8ssandbox: claim %s still has %d pods in %s", f.claim, n, e.Namespace)
	}
	b := &envBoot{d: d, st: st, req: req, claim: f.claim}
	if pre != nil {
		o, root, err := d.renderOptions(req, f)
		if err != nil {
			return nil, err
		}
		built, err := b.buildImages(ctx, builds, o)
		_ = root.Close()
		if err != nil {
			return nil, err
		}
		if plan, err = d.render(req, f, built); err != nil {
			return nil, err
		}
	}
	sum := sha256.Sum256(req.Compose)
	if st.golden != nil && st.sum != sum {
		st.golden, st.goldenOff = nil, "the compose file changed"
	}
	st.plan, st.sum = plan, sum
	b.plan = plan
	if err := b.run(ctx); err != nil {
		return nil, err
	}
	st.addrs = b.addrs
	st.up = true
	return b.sources, nil
}

// envBoot is one Up.
type envBoot struct {
	d       *Driver
	st      *envState
	plan    *kube.Plan
	req     driver.UpRequest
	claim   string
	addrs   map[string]string
	kept    map[string]bool // volume keys whose data this boot copied out and keeps
	sources []string
}

func (b *envBoot) e() *EnvConfig { return b.d.cfg.Env }

func (b *envBoot) say(line string) { b.req.Emit(line) }

func (b *envBoot) run(ctx context.Context) error {
	e := b.e()
	if err := b.d.replaceObject(ctx, ResourceNetworkPolicies, b.plan.Policy); err != nil {
		return err
	}
	for _, v := range b.plan.Volumes {
		if _, err := e.API.CreateObject(ctx, e.Namespace, ResourceVolumeClaims, v.Object); err != nil && !IsConflict(err) {
			return err
		}
	}
	for _, s := range b.plan.Services {
		if _, err := e.API.CreatePod(ctx, e.Namespace, s.Pod, false); err != nil {
			return b.failed(ctx, fmt.Errorf("k8ssandbox: pod of %s: %w", s.Name, err))
		}
	}
	if err := b.waitAddresses(ctx); err != nil {
		return b.failed(ctx, err)
	}
	b.kept = map[string]bool{}
	if b.st.golden == nil && b.st.goldenOff == "" {
		if err := b.takeGolden(ctx); err != nil {
			return b.failed(ctx, err)
		}
	}
	for _, s := range b.plan.Services {
		if err := b.prepare(ctx, s); err != nil {
			return b.failed(ctx, err)
		}
	}
	for _, s := range b.plan.Services {
		if err := b.waitDependencies(ctx, s); err != nil {
			return b.failed(ctx, err)
		}
		b.say("$ start " + s.Name)
		if _, err := b.init(ctx, s.PodName, "open", nil, nil); err != nil {
			return b.failed(ctx, err)
		}
	}
	for _, s := range b.plan.Services {
		if _, err := b.waitPod(ctx, s, "ready"); err != nil {
			return b.failed(ctx, err)
		}
	}
	for _, s := range b.plan.Services {
		if ip := b.addrs[s.Name]; ip != "" {
			b.sources = append(b.sources, ip)
		}
	}
	b.record(ctx)
	return nil
}

// failed leaves no pod of a boot that did not come up, so the agent's next
// try starts clean; the claims and the policy go with the claim.
func (b *envBoot) failed(ctx context.Context, err error) error {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), b.e().StopTimeout)
	defer cancel()
	return errors.Join(err, b.d.deleteEnvPods(cleanup, b.claim, false))
}

// waitAddresses waits until every pod has an address: its sandbox runs and
// its init container holds the gate.
func (b *envBoot) waitAddresses(ctx context.Context) error {
	b.addrs = map[string]string{}
	for _, s := range b.plan.Services {
		p, err := b.waitPod(ctx, s, "address")
		if err != nil {
			return err
		}
		b.addrs[s.Name] = podStatus(p).ip
	}
	return nil
}

func (b *envBoot) init(ctx context.Context, pod, op string, args []string, stdin []byte) (CommandResult, error) {
	return b.d.initOp(ctx, pod, op, args, stdin, 1<<20)
}

func (d *Driver) initOp(ctx context.Context, pod, op string, args []string, stdin []byte, maxOut int) (CommandResult, error) {
	e := d.cfg.Env
	argv := append([]string{"/bin/sh", "-c", kube.InitScript, "kodus-init", op}, args...)
	res, err := e.Exec.RunCommand(ctx, e.Namespace, pod, kube.InitContainer, argv, stdin, maxOut)
	if err != nil {
		return res, fmt.Errorf("k8ssandbox: %s %s in %s: %w", op, strings.Join(args, " "), pod, err)
	}
	if res.ExitCode != 0 {
		return res, fmt.Errorf("k8ssandbox: %s %s in %s exited %d: %s", op, strings.Join(args, " "), pod, res.ExitCode, strings.TrimSpace(string(res.Stderr)))
	}
	return res, nil
}

// goldenServices are the services whose volumes a reset restores: each
// mounts a named volume, has a healthcheck of its own (healthy is when its
// init is over), depends on nothing, and something depends on it (a
// database). What their first start wrote is copied before any service that
// could write to them runs.
func goldenServices(p *kube.Plan) []kube.Service {
	needed := map[string]bool{}
	for _, s := range p.Services {
		for _, d := range s.DependsOn {
			needed[d.Service] = true
		}
	}
	var out []kube.Service
	for _, s := range p.Services {
		if len(s.Data) > 0 && s.Healthcheck && len(s.DependsOn) == 0 && needed[s.Name] {
			out = append(out, s)
		}
	}
	return out
}

func (b *envBoot) goldenOff(why string) {
	b.st.golden, b.st.goldenOff = nil, why
	b.e().Log.Info("data.golden.off", "machine", b.req.Ref.MachineID, "reason", why)
}

// takeGolden is step 2 of Up: the golden services' first start, stopped
// clean, copied out through the recreated pods' init containers. Only a
// failure that leaves the boot unable to go on is returned.
func (b *envBoot) takeGolden(ctx context.Context) error {
	gold := goldenServices(b.plan)
	if len(gold) == 0 {
		b.goldenOff("no service whose data a reset could restore (a database others depend on, with a healthcheck)")
		return nil
	}
	start := b.d.cfg.Now()
	for _, s := range gold {
		if err := b.prepare(ctx, s); err != nil {
			return err
		}
		if _, err := b.init(ctx, s.PodName, "open", nil, nil); err != nil {
			return err
		}
	}
	for _, s := range gold {
		if _, err := b.waitPod(ctx, s, "ready"); err != nil {
			return err
		}
	}
	for _, s := range gold {
		if err := b.d.deletePod(ctx, s.PodName); err != nil {
			return err
		}
	}
	e := b.e()
	for _, s := range gold {
		if _, err := e.API.CreatePod(ctx, e.Namespace, s.Pod, false); err != nil {
			return fmt.Errorf("k8ssandbox: pod of %s: %w", s.Name, err)
		}
	}
	for _, s := range gold {
		p, err := b.waitPod(ctx, s, "address")
		if err != nil {
			return err
		}
		b.addrs[s.Name] = podStatus(p).ip
	}
	golden := map[string][]byte{}
	var total int64
	for _, s := range gold {
		for _, dm := range s.Data {
			res, err := b.d.initOp(ctx, s.PodName, "take", []string{dm.Dir}, nil, int(e.MaxGoldenBytes-total)+1)
			switch {
			case err != nil:
				b.goldenOff("take " + dm.Volume + ": " + err.Error())
				return nil
			case res.Truncated || int64(len(res.Stdout)) > e.MaxGoldenBytes-total:
				b.goldenOff(fmt.Sprintf("the volumes hold more than %d MiB", e.MaxGoldenBytes>>20))
				return nil
			}
			total += int64(len(res.Stdout))
			golden[dm.Volume] = res.Stdout
			b.kept[dm.Volume] = true
		}
	}
	b.st.golden = golden
	e.Log.Info("data.golden.taken", "machine", b.req.Ref.MachineID, "volumes", len(golden), "bytes", total, "ms", b.d.cfg.Now().Sub(start).Milliseconds())
	return nil
}

// prepare is step 3 for one pod: its hosts file, decoy, copies and volumes.
func (b *envBoot) prepare(ctx context.Context, s kube.Service) error {
	if _, err := b.init(ctx, s.PodName, "hosts", nil, b.plan.HostsFile(s, b.addrs)); err != nil {
		return err
	}
	if decoy := driver.CanaryFileOf(b.req.Canaries); decoy != "" {
		if _, err := b.init(ctx, s.PodName, "decoy", nil, []byte(decoy)); err != nil {
			return err
		}
	}
	for _, c := range s.Copies {
		data, err := copyTar(b.req.ProjectDir, c, b.e().MaxCopyBytes)
		if err != nil {
			return err
		}
		if _, err := b.init(ctx, s.PodName, "copy", []string{c.Dir}, data); err != nil {
			return err
		}
	}
	for _, dm := range s.Data {
		switch g, ok := b.st.golden[dm.Volume]; {
		case b.kept[dm.Volume]:
		case ok:
			if _, err := b.init(ctx, s.PodName, "restore", []string{dm.Dir}, g); err != nil {
				return err
			}
		default:
			if _, err := b.init(ctx, s.PodName, "wipe", []string{dm.Dir}, nil); err != nil {
				return err
			}
		}
	}
	return nil
}

// copyTar is a checkout path as the tar the init container unpacks: one
// file under its own name, or a directory's tree. Read through os.Root:
// nothing outside the checkout, no symlink followed.
func copyTar(projectDir string, c kube.Copy, limit int64) ([]byte, error) {
	root, err := os.OpenRoot(projectDir)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	fsys := root.FS()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	var total int64
	add := func(name, src string, info fs.FileInfo) error {
		switch {
		case info.Mode()&fs.ModeSymlink != 0:
			return &sandbox.RefusedError{Violations: []sandbox.Violation{{Path: c.Source, Reason: "a bind of a checkout path holds a symlink (" + src + "): the copy follows none"}}}
		case info.IsDir():
			return tw.WriteHeader(&tar.Header{Typeflag: tar.TypeDir, Name: name + "/", Mode: 0o755})
		case !info.Mode().IsRegular():
			return nil
		}
		if total += info.Size(); total > limit {
			return &sandbox.RefusedError{Violations: []sandbox.Violation{{Path: c.Source, Reason: fmt.Sprintf("the checkout files a service binds pass %d MiB", limit>>20)}}}
		}
		data, err := fs.ReadFile(fsys, src)
		if err != nil {
			return err
		}
		mode := int64(0o644)
		if info.Mode()&0o111 != 0 {
			mode = 0o755
		}
		if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: name, Mode: mode, Size: int64(len(data))}); err != nil {
			return err
		}
		_, err = tw.Write(data)
		return err
	}
	if c.File {
		info, err := fs.Stat(fsys, c.Source)
		if err != nil {
			return nil, err
		}
		if err := add(baseName(c.Source), c.Source, info); err != nil {
			return nil, err
		}
	} else {
		err := fs.WalkDir(fsys, c.Source, func(p string, de fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if p == c.Source {
				return nil
			}
			info, err := de.Info()
			if err != nil {
				return err
			}
			return add(strings.TrimPrefix(p, c.Source+"/"), p, info)
		})
		if err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func baseName(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// waitDependencies waits until each service s depends on meets its
// condition: started, healthy, or completed successfully.
func (b *envBoot) waitDependencies(ctx context.Context, s kube.Service) error {
	for _, dep := range s.DependsOn {
		var target kube.Service
		for _, t := range b.plan.Services {
			if t.Name == dep.Service {
				target = t
			}
		}
		want := map[string]string{"service_started": "started", "service_healthy": "ready", "service_completed_successfully": "completed"}[dep.Condition]
		if _, err := b.waitPod(ctx, target, want); err != nil {
			return fmt.Errorf("%s waits on %s: %w", s.Name, dep.Service, err)
		}
	}
	return nil
}

// waitPod polls the service's pod until it reaches want (address, started,
// ready, completed), and names why when it cannot: a pod that failed, an
// image that does not pull, a container that crashes. A workload's own
// failure is driver.WorkloadBootFailed (the repository's blocker).
func (b *envBoot) waitPod(ctx context.Context, s kube.Service, want string) (Object, error) {
	e := b.e()
	ctx, cancel := context.WithTimeout(ctx, b.d.cfg.ReadyTimeout)
	defer cancel()
	last := "Pending"
	for {
		p, err := e.API.GetPod(ctx, e.Namespace, s.PodName)
		if err != nil && ctx.Err() == nil {
			return nil, err
		}
		if p != nil {
			st := podStatus(p)
			done, why, fatal := envPodState(p, s.Container, want)
			switch {
			case done:
				return p, nil
			case fatal:
				return nil, driver.WorkloadBootFailed(fmt.Errorf("service %s: %s", s.Name, why))
			case why != "":
				last = why
			case st.phase != "":
				last = st.phase
			}
		}
		select {
		case <-ctx.Done():
			return nil, driver.WorkloadBootFailed(fmt.Errorf("service %s did not get %s in %s: %s", s.Name, want, b.d.cfg.ReadyTimeout, last))
		case <-time.After(b.d.cfg.Poll):
		}
	}
}

// fatalWaiting are the waiting reasons a pod does not get out of by itself.
var fatalWaiting = map[string]bool{
	"ErrImagePull": true, "ImagePullBackOff": true, "InvalidImageName": true, "CrashLoopBackOff": true,
	"CreateContainerConfigError": true, "CreateContainerError": true, "RunContainerError": true,
}

// envPodState reads a service pod against want: whether it is there, why
// not, and whether it never will be.
func envPodState(p Object, container, want string) (done bool, why string, fatal bool) {
	st, _ := p["status"].(map[string]any)
	phase := str(st["phase"])
	if phase == "Failed" {
		return false, "the pod failed: " + strings.TrimSpace(str(st["reason"])+" "+str(st["message"])), true
	}
	var main map[string]any
	for _, key := range []string{"initContainerStatuses", "containerStatuses"} {
		list, _ := st[key].([]any)
		for _, c := range list {
			cm, _ := c.(map[string]any)
			state, _ := cm["state"].(map[string]any)
			if w, ok := state["waiting"].(map[string]any); ok && fatalWaiting[str(w["reason"])] {
				return false, strings.TrimSpace(str(cm["name"]) + ": " + str(w["reason"]) + " " + str(w["message"])), true
			}
			if key == "containerStatuses" && str(cm["name"]) == container {
				main = cm
			}
		}
	}
	state, _ := main["state"].(map[string]any)
	term, terminated := state["terminated"].(map[string]any)
	_, running := state["running"].(map[string]any)
	ready := false
	conds, _ := st["conditions"].([]any)
	for _, c := range conds {
		cm, _ := c.(map[string]any)
		if str(cm["type"]) == "Ready" && str(cm["status"]) == "True" {
			ready = true
		}
	}
	exit := -1
	if terminated {
		if n, ok := term["exitCode"].(float64); ok {
			exit = int(n)
		} else if n, ok := term["exitCode"].(int); ok {
			exit = n
		}
	}
	switch want {
	case "address":
		return str(st["podIP"]) != "", "", false
	case "started":
		return running || terminated, "", false
	case "completed":
		if terminated && exit != 0 {
			return false, fmt.Sprintf("exited %d", exit), true
		}
		return terminated && exit == 0, "", false
	default: // ready
		if phase == "Succeeded" || (terminated && exit == 0) {
			return true, "", false
		}
		if terminated && phase != "Running" {
			return false, fmt.Sprintf("exited %d", exit), true
		}
		return ready, "", false
	}
}

// record keeps where an exec goes: the recipe's public service, or the
// project's only one, from its working directory (the file's, or the
// image's as pwd says).
func (b *envBoot) record(ctx context.Context) {
	e := b.e()
	name := ""
	if rec, err := recipe.Load(b.req.ProjectDir); err == nil && rec != nil {
		name = rec.Services.Compose.Primary()
	}
	if name == "" && len(b.plan.Services) == 1 {
		name = b.plan.Services[0].Name
	}
	b.st.targets = map[string]envTarget{}
	b.st.exec = nil
	for _, s := range b.plan.Services {
		t := envTarget{pod: s.PodName, container: s.Container, dir: s.WorkingDir}
		if t.dir == "" {
			res, err := e.Exec.RunCommand(ctx, e.Namespace, s.PodName, s.Container, []string{"/bin/sh", "-c", "pwd"}, nil, 4096)
			if dir := strings.TrimSpace(string(res.Stdout)); err == nil && res.ExitCode == 0 && strings.HasPrefix(dir, "/") {
				t.dir = dir
			} else {
				t.dir = "/"
			}
		}
		b.st.targets[s.Name] = t
		if s.Name == name {
			t := t
			b.st.exec = &t
		}
	}
}

// deletePod deletes one pod of the environment namespace (this cell's, by
// its labels) and waits until it is gone: its grace period is the stop.
func (d *Driver) deletePod(ctx context.Context, name string) error {
	e := d.cfg.Env
	if err := ignoreNotFound(e.API.DeletePod(ctx, e.Namespace, name)); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, e.StopTimeout)
	defer cancel()
	for {
		_, err := e.API.GetPod(ctx, e.Namespace, name)
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		if err != nil && ctx.Err() == nil {
			return err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("k8ssandbox: pod %s/%s was not gone in %s", e.Namespace, name, e.StopTimeout)
		case <-time.After(d.cfg.Poll):
		}
	}
}

// deleteEnvPods deletes the claim's pods of this cell but its observer (and,
// with all, the observer too, the volume claims and the policies), waiting
// for the pods to be gone.
func (d *Driver) deleteEnvPods(ctx context.Context, claim string, all bool) error {
	e := d.cfg.Env
	sel := d.envSelector(claim)
	pods, err := e.API.ListPods(ctx, e.Namespace, sel)
	if err != nil {
		return err
	}
	if !all {
		pods = withoutObserver(pods)
	}
	var errs []error
	for _, p := range pods {
		if d.owns(p) {
			if err := d.deletePod(ctx, str(meta(p)["name"])); err != nil {
				errs = append(errs, err)
			}
		}
	}
	if all {
		for _, r := range []Resource{ResourceVolumeClaims, ResourceNetworkPolicies} {
			objs, err := e.API.ListObjects(ctx, e.Namespace, r, sel)
			if err != nil {
				errs = append(errs, err)
				continue
			}
			for _, o := range objs {
				if d.owns(o) {
					if err := ignoreNotFound(e.API.DeleteObject(ctx, e.Namespace, r, str(meta(o)["name"]))); err != nil {
						errs = append(errs, err)
					}
				}
			}
		}
	}
	return errors.Join(errs...)
}

// Reset takes the project down for the next round (compose_volumes): its
// pods are deleted; its volume claims, policy and golden copy stay, and the
// agent's Up after it restores or empties the volumes. The claim's observer
// starts again under the same machine (recycleObserver).
func (d *Driver) envReset(ctx context.Context, ref driver.MachineRef, snap driver.SnapshotRef) error {
	if snap.Kind != "compose_volumes" {
		return fmt.Errorf("%w: k8s-sandbox resets compose volumes only, not %q", driver.ErrUnsupported, snap.Kind)
	}
	f, err := d.holderFacts(ctx, ref)
	if err != nil {
		return err
	}
	if err := d.deleteEnvPods(ctx, f.claim, false); err != nil {
		return err
	}
	st := d.envs.get(ref.MachineID)
	st.up, st.addrs = false, nil
	return d.recycleObserver(ctx, f)
}

// withoutObserver are the pods but the claim's observer.
func withoutObserver(pods []Object) []Object {
	out := pods[:0:0]
	for _, p := range pods {
		if l, _ := meta(p)["labels"].(map[string]any); str(l[label(driver.TagRole)]) != kube.ObserverRole {
			out = append(out, p)
		}
	}
	return out
}

// envResetter is the Resetter part (the driver has its own Reset name free
// for a disk reset no Kubernetes cell has).
type envResetter struct{ d *Driver }

func (r envResetter) Reset(ctx context.Context, ref driver.MachineRef, snap driver.SnapshotRef) error {
	return r.d.envReset(ctx, ref, snap)
}

// cleanupEnv removes everything of the claim in the environment namespace.
func (d *Driver) cleanupEnv(ctx context.Context, claim string) error {
	if d.cfg.Env == nil || claim == "" {
		return nil
	}
	if err := driver.ValidateClaimID(claim); err != nil {
		return err
	}
	return d.deleteEnvPods(ctx, claim, true)
}

// ReapOrphans removes this cell's environment objects whose claim has no
// holder pod left: a cell that crashed between a claim's end and its
// cleanup, or a holder the sweep or the reaper ended (the reaper's orphan
// pass). A claim's objects are made after its holder, so one being set up
// is never an orphan.
func (d *Driver) ReapOrphans(ctx context.Context) ([]string, error) {
	if d.cfg.Env == nil {
		return nil, nil
	}
	e := d.cfg.Env
	holders, err := d.k.ListPods(ctx, d.cfg.Namespace, map[string]string{label(driver.TagCell): d.cfg.CellID})
	if err != nil {
		return nil, err
	}
	alive := map[string]bool{}
	for _, p := range holders {
		if d.owns(p) {
			l, _ := meta(p)["labels"].(map[string]any)
			alive[str(l[label(driver.TagClaim)])] = true
		}
	}
	mine := map[string]string{label(driver.TagCell): d.cfg.CellID}
	orphans := map[string]bool{}
	pods, err := e.API.ListPods(ctx, e.Namespace, mine)
	if err != nil {
		return nil, err
	}
	objs := pods
	for _, r := range []Resource{ResourceVolumeClaims, ResourceNetworkPolicies} {
		o, err := e.API.ListObjects(ctx, e.Namespace, r, mine)
		if err != nil {
			return nil, err
		}
		objs = append(objs, o...)
	}
	for _, o := range objs {
		l, _ := meta(o)["labels"].(map[string]any)
		if claim := str(l[label(driver.TagClaim)]); d.owns(o) && claim != "" && !alive[claim] {
			orphans[claim] = true
		}
	}
	var gone []string
	var errs []error
	for claim := range orphans {
		if err := d.cleanupEnv(ctx, claim); err != nil {
			errs = append(errs, err)
			continue
		}
		gone = append(gone, e.Namespace+"/"+envPrefix(claim))
	}
	return gone, errors.Join(errs...)
}

// NewForReaperWithEnv is NewForReaper that also ends the environment
// namespace's objects of a reaped machine, and runs the orphan pass there.
func NewForReaperWithEnv(k KubeAPI, env EnvAPI, cellID, namespace, envNamespace string) *Driver {
	d := NewForReaper(k, cellID, namespace)
	d.cfg.Env = &EnvConfig{API: env, Namespace: envNamespace, StopTimeout: 2 * time.Minute, Log: slog.New(slog.DiscardHandler)}
	d.cfg.Poll = time.Second
	return d
}
