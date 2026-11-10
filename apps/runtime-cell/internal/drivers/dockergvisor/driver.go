// Package dockergvisor is the docker-gvisor MachineDriver for self-hosted
// (docs §4b, Inc. 4): each side of a Run is a compose project whose services
// run under gVisor (runtime: runsc) in the host's Docker. Root on a shared
// host is the threat (S-10): the compose file goes through the allowlist
// (internal/compose/sandbox) before any container starts, docker runs with
// a minimal environment and no interpolation file, and what compose would
// run is checked a second time from its own canonical output.
//
// The agent boots the project through Up (driver.ComposeBooter) and must add
// the sources Up returns to the claim's egress policy.
package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// Docker is the part of the host's Docker the driver uses; dockercli.CLI
// implements it.
type Docker interface {
	Runtimes(ctx context.Context) ([]string, error)
	DaemonEndpoint(ctx context.Context) (string, error)
	CgroupInfo(ctx context.Context) (dockercli.CgroupDaemonInfo, error)
	APIVersion(ctx context.Context) (string, error)
	SecurityOptions(ctx context.Context) ([]string, error)
	RunHolder(ctx context.Context, h dockercli.HolderSpec) (dockercli.Container, error)
	Remove(ctx context.Context, name string) error
	IDs(ctx context.Context, f dockercli.Filters) ([]string, error)
	Inspect(ctx context.Context, ids ...string) ([]dockercli.Container, error)
	List(ctx context.Context, labels map[string]string) ([]dockercli.Container, error)
	ComposeConfig(ctx context.Context, p dockercli.ComposeProject) ([]byte, error)
	ComposeUp(ctx context.Context, p dockercli.ComposeProject) error
	ComposeDown(ctx context.Context, project string, volumes bool) error
	ComposeStop(ctx context.Context, project string) error
	ComposeStopServices(ctx context.Context, project string, services ...string) error
	ComposeStart(ctx context.Context, project string) error
	NetworkCreate(ctx context.Context, n dockercli.NetworkSpec) error
	NetworkSubnet(ctx context.Context, name string) (string, error)
	NetworkLabels(ctx context.Context, name string) (map[string]string, error)
	NetworkRemove(ctx context.Context, name string) error
	NetworkConnect(ctx context.Context, network, container string) (string, error)
	NetworkDisconnect(ctx context.Context, network, container string) error
	RunBuild(ctx context.Context, b dockercli.BuildRun) error
	LoadImage(ctx context.Context, tarball string) error
	RemoveImage(ctx context.Context, ref string) error
	TagImage(ctx context.Context, src, dst string) error
	ImageRefs(ctx context.Context, repo string) ([]string, error)
	ImageLabels(ctx context.Context, ref string) (map[string]string, error)
	Volumes(ctx context.Context, labels map[string]string) ([]dockercli.Volume, error)
	VolumeRemove(ctx context.Context, names ...string) error
	CopyVolumeIn(ctx context.Context, runtime, helperImage, from, to string, labels map[string]string) error
	CopyVolumeBound(ctx context.Context, runtime, helperImage, from, to string, labels map[string]string, parent string) error
	CopyVolumeGeneration(ctx context.Context, runtime, helperImage, from, to string, labels map[string]string, parent, expected, write string) error
	Exec(ctx context.Context, e dockercli.ExecSpec, req, host kodyexec.Request) kodyexec.Result
	ExecInput(ctx context.Context, container string, stdin []byte, argv ...string) ([]byte, error)
}

var _ Docker = dockercli.CLI{}

type Config struct {
	// ClaimLimits enforces the whole container tree; nil leaves legacy per-container limits.
	ClaimLimits claimlimits.Manager
	// ClaimLimitBackend is explicit: cgroupfs (default) or systemd.
	ClaimLimitBackend string
	// MirrorGoProxy is the GOPROXY every build gets as a build argument
	// (the cell's registry mirror, "…/go,off"); a Dockerfile that declares
	// ARG GOPROXY fetches its modules there. Empty: none.
	MirrorGoProxy string
	// MirrorRegistry is the cell's registry mirror (host:port) every build's
	// BuildKit pulls docker.io images through; empty: straight to Docker Hub.
	MirrorRegistry string
	// PersistBuildState keeps BuildKit's state per environment (state.go):
	// the default branch's setup writes it, every other build reads it
	// through a throwaway overlay. Off: each build starts from the exported
	// cache alone.
	PersistBuildState bool
	// BuildStateMinFreeBytes: below this free space on the cell's disk, the
	// least recently used environment states nobody holds are removed.
	BuildStateMinFreeBytes int64
	// BuildStateKeep bounds what BuildKit keeps in one state ("20GB"; its GC).
	BuildStateKeep string
	CellID         string
	Runtime        string // runsc
	HolderImage    string
	PidsLimit      int
	// MemLimit and CPUs are forced on every compose service and build ("4g",
	// "2") of a claim that asks no size of its own.
	MemLimit string
	CPUs     string
	// MemMax and CPUsMax are the largest size one claim may ask
	// (claim.acquire size); empty or zero: MemLimit and CPUs, so a claim may
	// ask less than the default but never more. Neither may be below the
	// default.
	MemMax  string
	CPUsMax int
	// MemReady is what a ready claim is counted for in the cell's memory
	// admission (ADR-070), as docker takes it ("2g" when empty, never above
	// the claim's own memory). A count, not a limit: services keep MemLimit.
	MemReady string
	// WorkDir holds the rewritten compose files (cell-owned, never the
	// checkout); os.TempDir() when empty.
	WorkDir string
	// BakeStateDir contains the private durable generation catalog. Empty:
	// bake-catalog under WorkDir. It must never be mounted in a workload.
	BakeStateDir string
	// EgressContainer is the cell's egress container (proxy and resolver,
	// cmd/egress with -dns-listen and -transparent=false). PrepareClaim
	// attaches it to each claim network, the only way out of one. Empty:
	// claims have no way out at all.
	EgressContainer string
	// ClaimSubnets is where each claim network takes its /24 (default
	// 10.213.0.0/16): services get fixed addresses in it, so their names
	// resolve without Docker's resolver.
	ClaimSubnets netip.Prefix
	// BuilderImage is rootless BuildKit, by digest, that builds a project's
	// build sections under Runtime on the claim network. Empty: a project
	// that builds is refused (ErrNoBuilder).
	BuilderImage string
	// BuilderUID and BuilderGID are the builder's ids as the host sees them,
	// the owner of the directories it writes (hostdirs.go). Zero: the
	// image's user (1000), which is right only when Docker maps no user
	// namespace; with one (userns-remap, rootless) they must be set.
	BuilderUID, BuilderGID int
	// HelperImage copies data volumes under Runtime (sh and cp -a) for a
	// bake and for a claim that starts from one; busybox:1.36 when empty.
	HelperImage string
	// ObserverImage holds the observer server at /observer (cmd/observer,
	// static), by digest. An observer machine runs it under Runtime on the
	// claim network, where it reaches the claim's services and nothing
	// else; the cell dials it over mTLS (-observer http). Empty: the
	// observer machine is a bare holder, and nothing can run its probes.
	ObserverImage string
	// ObserverTLSDir is the cell's directory with the observer's server
	// certificate (cert.pem, key.pem, for ObserverServerName) and the CA of
	// the cell's client certificate (ca.pem), mounted read-only into it.
	ObserverTLSDir string
	// HealthStartInterval is how often a starting service's healthcheck
	// runs until it first passes (sandbox.Options.HealthStartInterval), on
	// every boot and every round's reset; zero: DefaultHealthStartInterval,
	// negative: as the compose file says. Off on a daemon older than API
	// 1.44, which has no start_interval.
	HealthStartInterval time.Duration
	// NoGoldenData turns the golden data off (golden.go): every reset
	// recreates the data volumes from nothing, as before it.
	NoGoldenData bool
	// Log gets the driver's build and bake events; discarded when nil.
	Log *slog.Logger
	// Clock is what the build states' and caches' bookkeeping reads the
	// time from (last use, generation and trash names); the wall clock when
	// nil.
	Clock clock.Clock
}

// Docker labels cannot change after creation. That suits kodus:hard-expires
// (immutable by construction); kodus:expires lives in the driver's memory.
type Driver struct {
	d   Docker
	cfg Config
	mu  sync.Mutex
	// machines is what the driver knows of each machine, from Create to
	// Destroy (machineState).
	machines map[string]*machineState
	// observerSQL never participates in a machine snapshot or persisted state.
	observerSQL map[string]*observerSQLAccount
	limitGroups map[string]limitGroup
	// pinned is what a bake took from a clean setup machine
	// (PinBakeSource) until the bake is done with it, past the machine's
	// Destroy.
	pinned map[string]*pinnedOutput
	// adopted binds a claim to the pool machine's network it took (Adopt),
	// until that network is released.
	adopted map[string]string
	// dirs makes the host directories the builder writes (hostdirs.go).
	dirs hostDirs
	// states are the environments' BuildKit states (state.go); caches
	// their exported build caches (cache.go).
	states stateStore
	caches *cacheGenerations
	// reclaim runs ReclaimDisk off the sweep's goroutine (sweep.go).
	reclaim diskReclaim
	// maxSize is the largest size Create accepts.
	maxSize driver.ClaimSize
	// defaultMemMB is MemLimit in MB, readyMB MemReady (ClaimMemory).
	defaultMemMB, readyMB int
	// healthEvery is HealthStartInterval once the daemon is known to take
	// it; zero: off.
	healthEvery time.Duration
	// clock times boots and resets (BootTiming).
	clock           clock.Clock
	catalogMu       sync.Mutex
	catalog         *bakeCatalog
	generationHolds map[string]func()
}

func (d *Driver) log() *slog.Logger {
	if d.cfg.Log == nil {
		return slog.New(slog.DiscardHandler)
	}
	return d.cfg.Log
}

// ErrNoIsolatedRuntime: the cell does not start without gVisor (S-10).
var ErrNoIsolatedRuntime = errors.New("dockergvisor: the runsc runtime is not installed in this Docker")

func New(ctx context.Context, d Docker, cfg Config) (*Driver, error) {
	if cfg.CellID == "" || cfg.HolderImage == "" {
		return nil, errors.New("dockergvisor: cell id and holder image required")
	}
	if cfg.ObserverImage != "" && cfg.ObserverTLSDir == "" {
		return nil, errors.New("dockergvisor: an observer image needs its TLS directory")
	}
	if cfg.Runtime == "" {
		cfg.Runtime = "runsc"
	}
	if cfg.ClaimLimitBackend == "" {
		cfg.ClaimLimitBackend = "cgroupfs"
	}
	if cfg.ClaimLimitBackend != "cgroupfs" && cfg.ClaimLimitBackend != "systemd" {
		return nil, ErrResourceEnforcement
	}
	if cfg.ClaimLimits == nil && cfg.ClaimLimitBackend == "systemd" {
		return nil, ErrResourceEnforcement
	}
	if cfg.ClaimLimits != nil {
		endpoint, err := d.DaemonEndpoint(ctx)
		if err != nil {
			return nil, errors.Join(ErrResourceEnforcement, err)
		}
		if err = ValidateClaimLimitEndpoint(endpoint); err != nil {
			return nil, err
		}
		info, err := d.CgroupInfo(ctx)
		if err != nil {
			return nil, errors.Join(ErrResourceEnforcement, err)
		}
		if err = ValidateClaimLimitDaemon(info, cfg.ClaimLimitBackend, cfg.Runtime); err != nil {
			return nil, err
		}
	}
	if cfg.MemLimit == "" {
		cfg.MemLimit = "4g"
	}
	if cfg.CPUs == "" {
		cfg.CPUs = "2"
	}
	if cfg.HelperImage == "" {
		cfg.HelperImage = defaultHelperImage
	}
	maxSize, err := maxClaimSize(cfg)
	if err != nil {
		return nil, err
	}
	rts, err := d.Runtimes(ctx)
	if err != nil {
		return nil, err
	}
	found := false
	for _, r := range rts {
		if r == cfg.Runtime {
			found = true
		}
	}
	if !found {
		return nil, ErrNoIsolatedRuntime
	}
	defMem, err := parseMemMB(cfg.MemLimit)
	if err != nil {
		return nil, err
	}
	readyMB := defaultReadyMB
	if cfg.MemReady != "" {
		if readyMB, err = parseMemMB(cfg.MemReady); err != nil {
			return nil, err
		}
	}
	dr := &Driver{d: d, cfg: cfg, machines: map[string]*machineState{}, pinned: map[string]*pinnedOutput{}, adopted: map[string]string{}, maxSize: maxSize, states: noStates{}, dirs: defaultHostDirs(), defaultMemMB: defMem, readyMB: readyMB}
	if cfg.BuilderImage != "" {
		if dr.dirs.uid, dr.dirs.gid, err = builderIDs(ctx, d, cfg); err != nil {
			return nil, err
		}
		for _, root := range builderRoots(dr.workDir()) {
			if err := dr.dirs.privateRoot(root); err != nil {
				return nil, err
			}
		}
	}
	clk := clock.Or(cfg.Clock)
	dr.clock = clk
	dr.healthEvery = dr.healthStartInterval(ctx)
	dr.caches = newCacheGenerations(filepath.Join(dr.workDir(), "cache", "env"), filepath.Join(dr.workDir(), "cache", "trash"), clk)
	if cfg.PersistBuildState {
		if dr.states, err = newBuildStates(buildStatesConfig{
			Root: filepath.Join(dr.workDir(), "buildkit"), CellID: cfg.CellID, MinFree: cfg.BuildStateMinFreeBytes,
			Dirs: dr.dirs, Mounter: defaultMounter(), FreeBytes: statfsFree, Clock: clk, Log: dr.log(),
		}); err != nil {
			return nil, err
		}
	}
	return dr, nil
}

// DefaultHealthStartInterval is Config.HealthStartInterval when unset: a
// probe a few times a second costs a starting service little (Docker runs
// one at a time) and finds it up within a fifth of a second.
const DefaultHealthStartInterval = 200 * time.Millisecond

// healthStartInterval is the fast cadence this daemon can take: start_interval
// is API 1.44 (Docker 25); compose refuses it on an older one.
func (d *Driver) healthStartInterval(ctx context.Context) time.Duration {
	every := d.cfg.HealthStartInterval
	if every < 0 {
		return 0
	}
	if every == 0 {
		every = DefaultHealthStartInterval
	}
	v, err := d.d.APIVersion(ctx)
	if err == nil && !apiAtLeast(v, 1, 44) {
		err = fmt.Errorf("API %q is older than 1.44", v)
	}
	if err != nil {
		d.log().Warn("health.fast_start.off", "err", err)
		return 0
	}
	return every
}

// apiAtLeast compares a "major.minor" API version.
func apiAtLeast(v string, major, minor int) bool {
	a, b, ok := strings.Cut(v, ".")
	if !ok {
		return false
	}
	ma, err1 := strconv.Atoi(a)
	mi, err2 := strconv.Atoi(b)
	if err1 != nil || err2 != nil {
		return false
	}
	return ma > major || (ma == major && mi >= minor)
}

// Kind is the driver's name (-driver docker-gvisor, hello.driver).
const Kind = "docker-gvisor"

func (d *Driver) Kind() string { return Kind }

func (d *Driver) Capabilities() driver.Capabilities {
	return driver.Capabilities{Isolation: driver.IsolationSandboxedContainer, NestedContainers: true, Suspend: "stop", Arch: []string{"x86_64", "arm64"}, Bake: true, MaxClaimSize: d.maxSize}
}

// labelMachine names the machine on its holder container only, so List
// returns machines, not every compose container of the project.
const labelMachine = "kodus.machine"

func toLabels(tags map[string]string) map[string]string {
	out := make(map[string]string, len(tags))
	for k, v := range tags {
		out[dockercli.LabelFromTag(k)] = v
	}
	return out
}

func networkName(claimID string) string { return "kodus-" + strings.ToLower(claimID) }

func (d *Driver) PrepareClaim(ctx context.Context, spec driver.ClaimNetworkSpec) (driver.ClaimNetwork, error) {
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.ClaimNetwork{}, err
	}
	name := networkName(spec.ClaimID)
	labels := toLabels(map[string]string{driver.TagCell: d.cfg.CellID, driver.TagOrg: spec.OrgID, driver.TagClaim: spec.ClaimID})
	// internal: no route out except through the cell's proxy and resolver,
	// which join it here.
	subnet, err := d.createClaimNetwork(ctx, spec.ClaimID, name, labels)
	if err != nil {
		return driver.ClaimNetwork{}, err
	}
	n := driver.ClaimNetwork{WorkloadGroupID: name, ObserverGroupID: name}
	if d.cfg.BuilderImage != "" {
		n.Sources = []string{builderAddress(subnet).String()}
	}
	if d.cfg.EgressContainer == "" {
		return n, nil
	}
	addr, err := d.d.NetworkConnect(ctx, name, d.cfg.EgressContainer)
	if err == nil {
		err = d.writeResolv(name, addr)
	}
	if err != nil {
		// A claim the egress cannot join would run with no way out but
		// also with no resolver: refuse it rather than boot half wired.
		_ = d.d.NetworkDisconnect(ctx, name, d.cfg.EgressContainer)
		return driver.ClaimNetwork{}, errors.Join(fmt.Errorf("dockergvisor: attach egress to %s: %w", name, err), d.d.NetworkRemove(ctx, name))
	}
	n.EgressAddress = addr
	return n, nil
}

// createClaimNetwork makes the claim's network in a /24 of ClaimSubnets,
// starting where the claim id points and moving on while Docker says the
// subnet is taken. Docker hands dynamic addresses (the holder, the egress)
// only from the upper half; services take fixed ones in the lower half.
func (d *Driver) createClaimNetwork(ctx context.Context, claimID, name string, labels map[string]string) (netip.Prefix, error) {
	pool := d.cfg.ClaimSubnets
	if !pool.IsValid() {
		pool = netip.MustParsePrefix("10.213.0.0/16")
	}
	slots := 1 << (24 - pool.Bits())
	h := fnv.New32a()
	_, _ = h.Write([]byte(claimID))
	start := int(h.Sum32() % uint32(slots))
	var last error
	for i := range min(slots, 32) {
		subnet, upper := claimSlot(pool, (start+i)%slots)
		last = d.d.NetworkCreate(ctx, dockercli.NetworkSpec{Name: name, Internal: true, Labels: labels, Subnet: subnet.String(), IPRange: upper.String()})
		if last == nil {
			return subnet, nil
		}
		if !strings.Contains(last.Error(), "overlap") {
			return netip.Prefix{}, last
		}
	}
	return netip.Prefix{}, fmt.Errorf("dockergvisor: no free /24 for %s in %s: %w", name, pool, last)
}

// claimSlot is the slot-th /24 of pool and its upper half.
func claimSlot(pool netip.Prefix, slot int) (netip.Prefix, netip.Prefix) {
	b := pool.Masked().Addr().As4()
	n := (uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8) + uint32(slot)<<8
	base := netip.AddrFrom4([4]byte{byte(n >> 24), byte(n >> 16), byte(n >> 8), 0})
	upper := netip.AddrFrom4([4]byte{byte(n >> 24), byte(n >> 16), byte(n >> 8), 128})
	return netip.PrefixFrom(base, 24), netip.PrefixFrom(upper, 25)
}

// resolvPath is the cell's resolv.conf for a claim network: in the cell's
// own directory, never the checkout.
func (d *Driver) resolvPath(network string) string {
	dir := d.cfg.WorkDir
	if dir == "" {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "resolv", network+".conf")
}

func (d *Driver) writeResolv(network, egress string) error {
	p := d.resolvPath(network)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	// Read by the machines' users: world-readable, written by the cell only.
	return os.WriteFile(p, []byte("nameserver "+egress+"\noptions ndots:0 timeout:2 attempts:2\n"), 0o644)
}

// claimResolv is the resolv.conf a claim's machines mount ("" with no egress).
func (d *Driver) claimResolv(network string) (string, error) {
	if d.cfg.EgressContainer == "" {
		return "", nil
	}
	p := d.resolvPath(network)
	if _, err := os.Stat(p); err != nil {
		return "", fmt.Errorf("dockergvisor: no resolver for %s: %w", network, err)
	}
	return p, nil
}

// ReleaseClaim removes the claim's network, only when it carries this
// cell's label.
func (d *Driver) ReleaseClaim(ctx context.Context, n driver.ClaimNetwork) error {
	if n.WorkloadGroupID == "" {
		return nil
	}
	labels, err := d.d.NetworkLabels(ctx, n.WorkloadGroupID)
	if err != nil {
		return err
	}
	if labels == nil {
		d.mu.Lock()
		g := d.limitGroups[n.WorkloadGroupID]
		d.mu.Unlock()
		return d.removeLimitGroup(ctx, g)
	}
	if labels[dockercli.LabelFromTag(driver.TagCell)] != d.cfg.CellID {
		return fmt.Errorf("%w: network %s", driver.ErrNotOwned, n.WorkloadGroupID)
	}
	if d.cfg.ClaimLimits != nil {
		org := labels["kodus.org"]
		if org == "" {
			return ErrResourceEnforcement
		}
		d.mu.Lock()
		if d.limitGroups == nil {
			d.limitGroups = map[string]limitGroup{}
		}
		if d.limitGroups[n.WorkloadGroupID].key == "" {
			d.limitGroups[n.WorkloadGroupID] = limitGroup{key: resourceKey(d.cfg.CellID, org, n.WorkloadGroupID), network: n.WorkloadGroupID}
		}
		d.mu.Unlock()
	}
	// Docker removes no network a container is still attached to.
	if d.cfg.EgressContainer != "" {
		if err := d.d.NetworkDisconnect(ctx, n.WorkloadGroupID, d.cfg.EgressContainer); err != nil {
			return err
		}
		if err := os.Remove(d.resolvPath(n.WorkloadGroupID)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := d.d.NetworkRemove(ctx, n.WorkloadGroupID); err != nil {
		return err
	}
	d.forgetAdoptions(n.WorkloadGroupID)
	d.mu.Lock()
	g := d.limitGroups[n.WorkloadGroupID]
	d.mu.Unlock()
	return d.removeLimitGroup(ctx, g)
}

// observerTLSMount is where an observer machine finds ObserverTLSDir.
const observerTLSMount = "/etc/kodus/observer"

// ObserverPort is where an observer machine serves the cell (cmd/observer).
const ObserverPort = 7443

func observerCmd(cell string) []string {
	return []string{"/observer", "-listen", fmt.Sprintf(":%d", ObserverPort), "-cell-id", cell,
		"-cert", observerTLSMount + "/cert.pem", "-key", observerTLSMount + "/key.pem", "-ca", observerTLSMount + "/ca.pem"}
}

func machineName(spec driver.MachineSpec) string {
	return fmt.Sprintf("kodus-%s-%s", strings.ToLower(spec.ClaimID), spec.Role)
}

func (d *Driver) Create(ctx context.Context, spec driver.MachineSpec) (driver.MachineRef, error) {
	if err := spec.ValidateFor(d.Capabilities()); err != nil {
		return driver.MachineRef{}, err
	}
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.MachineRef{}, err
	}
	if spec.CellID != d.cfg.CellID {
		return driver.MachineRef{}, fmt.Errorf("%w: spec for cell %s", driver.ErrNotOwned, spec.CellID)
	}
	// The holder joins this claim's network only: a spec naming another
	// claim's network is refused.
	if spec.ClaimGroupID != d.claimNetwork(spec.ClaimID) {
		return driver.MachineRef{}, fmt.Errorf("%w: network %s is not claim %s's", driver.ErrNotOwned, spec.ClaimGroupID, spec.ClaimID)
	}
	tags := spec.AllTags()
	name := machineName(spec)
	keepGeneration := false
	if strings.HasPrefix(spec.ImageID, "kodus-bake/") && spec.Role != driver.RoleObserver {
		_, release, err := d.holdGeneration(ctx, driver.MachineRef{ImageID: spec.ImageID, Tags: tags})
		if err != nil {
			return driver.MachineRef{}, err
		}
		defer func() {
			if !keepGeneration {
				release()
			}
		}()
		d.mu.Lock()
		if d.generationHolds == nil {
			d.generationHolds = map[string]func(){}
		}
		if d.generationHolds[name] != nil {
			d.mu.Unlock()
			return driver.MachineRef{}, errors.New("dockergvisor: machine already retains a generation")
		}
		d.generationHolds[name] = release
		d.mu.Unlock()
		defer func() {
			if !keepGeneration {
				d.mu.Lock()
				delete(d.generationHolds, name)
				d.mu.Unlock()
			}
		}()
	}
	labels := toLabels(tags)
	var g limitGroup
	var err error
	if spec.Role == driver.RoleObserver {
		g, err = d.observerGroup(ctx, spec.ClaimGroupID, spec.OrgID)
	} else {
		g, err = d.groupFor(ctx, spec.ClaimGroupID, spec.OrgID, spec.ClaimSize)
	}
	if err != nil {
		return driver.MachineRef{}, err
	}
	g.label(labels)
	labels["kodus.image"] = spec.ImageID
	labels[labelMachine] = name
	resolv, err := d.claimResolv(spec.ClaimGroupID)
	if err != nil {
		return driver.MachineRef{}, err
	}
	h := dockercli.HolderSpec{Name: name, Image: d.cfg.HolderImage, Network: spec.ClaimGroupID, Runtime: d.cfg.Runtime,
		PidsLimit: d.cfg.PidsLimit, Labels: labels, Resolv: resolv, CgroupParent: g.parent}
	observerNet := ""
	if spec.Role == driver.RoleObserver && d.cfg.ObserverImage != "" {
		if observerNet, err = d.ensureObserverNetwork(ctx); err != nil {
			return driver.MachineRef{}, fmt.Errorf("dockergvisor: observer network: %w", err)
		}
		h.Image, h.Mounts, h.Cmd = d.cfg.ObserverImage, []string{d.cfg.ObserverTLSDir + ":" + observerTLSMount}, observerCmd(d.cfg.CellID)
		h.AlsoOn = []string{observerNet}
	}
	c, err := d.d.RunHolder(ctx, h)
	if err != nil {
		return driver.MachineRef{}, err
	}
	if d.cfg.ClaimLimits != nil {
		if err := d.cfg.ClaimLimits.Verify(g.key, c.PID); err != nil {
			cleanup, cancel := cleanupContext(ctx)
			defer cancel()
			return driver.MachineRef{}, errors.Join(ErrResourceEnforcement, err, d.d.Remove(cleanup, name))
		}
	}
	// The cell dials an observer on the observer network: the claim
	// network has no address on the host.
	address := c.IP(spec.ClaimGroupID)
	if observerNet != "" {
		if address = c.IP(observerNet); address == "" {
			return driver.MachineRef{}, errors.Join(fmt.Errorf("dockergvisor: observer %s has no address on %s", name, observerNet), d.d.Remove(context.WithoutCancel(ctx), name))
		}
	}
	d.mu.Lock()
	m := d.machineLocked(name)
	m.expires, m.size = spec.ExpiresAt, spec.ClaimSize
	m.setup, m.seeds = spec.Setup, spec.Setup && spec.SeedsCache
	d.mu.Unlock()
	keepGeneration = true
	return driver.MachineRef{MachineID: name, DriverRef: c.ID, PrivateAddress: address, ImageID: spec.ImageID, Tags: tags}, nil
}

// owned checks that every container of the machine (its holder, its compose
// project) carries this cell's label. exists is false when there is none.
func (d *Driver) owned(ctx context.Context, machine string) (exists bool, err error) {
	byName, err := d.d.IDs(ctx, dockercli.Filters{"name": {"^/?" + machine + "$"}})
	if err != nil {
		return false, err
	}
	byProject, err := d.d.IDs(ctx, dockercli.Filters{"label": {"com.docker.compose.project=" + machine}})
	if err != nil {
		return false, err
	}
	cs, err := d.d.Inspect(ctx, append(byName, byProject...)...)
	if err != nil {
		return false, err
	}
	for _, c := range cs {
		if c.Labels[dockercli.LabelFromTag(driver.TagCell)] != d.cfg.CellID {
			return true, fmt.Errorf("%w: container %s", driver.ErrNotOwned, c.Name)
		}
	}
	return len(cs) > 0, nil
}

// Up runs the claim's compose project after the allowlist rewrite and the
// second check of compose's canonical output. Nothing starts if either
// refuses. It returns the containers' addresses on the claim network.
func (d *Driver) Up(ctx context.Context, ref driver.MachineRef, composeFile []byte, projectDir string) ([]string, error) {
	// A reset's down is the first phase of the boot that follows it.
	d.mu.Lock()
	reset := d.machineLocked(ref.MachineID).reset
	d.machineLocked(ref.MachineID).reset = nil
	d.mu.Unlock()
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return nil, err
	}
	network := networkName(ref.Tags[driver.TagClaim])
	resolv, err := d.claimResolv(network)
	if err != nil {
		return nil, err
	}
	raw, err := d.d.NetworkSubnet(ctx, network)
	if err != nil {
		return nil, err
	}
	subnet, err := netip.ParsePrefix(raw)
	if err != nil {
		return nil, fmt.Errorf("dockergvisor: subnet of %s: %w", network, err)
	}
	parent, err := d.parentFor(ctx, ref)
	if err != nil {
		return nil, err
	}
	mem, cpus := d.limits(ref.MachineID)
	opts := sandbox.Options{
		CgroupParent: parent,
		ProjectDir:   projectDir, Project: ref.MachineID, Runtime: d.cfg.Runtime, PidsLimit: d.cfg.PidsLimit,
		MemLimit: mem, CPUs: cpus, Network: network, Subnet: subnet, Resolv: resolv,
		HealthStartInterval: d.healthEvery,
		Labels: toLabels(map[string]string{
			driver.TagCell: d.cfg.CellID, driver.TagOrg: ref.Tags[driver.TagOrg], driver.TagClaim: ref.Tags[driver.TagClaim],
			driver.TagRole: ref.Tags[driver.TagRole], driver.TagHardExpires: ref.Tags[driver.TagHardExpires],
		}),
	}
	if opts.Decoy, err = d.writeDecoy(ref.MachineID, driver.CanariesFrom(ctx)); err != nil {
		return nil, fmt.Errorf("dockergvisor: decoy file: %w", err)
	}
	builds, err := sandbox.Builds(composeFile, opts)
	if err != nil {
		return nil, err
	}
	started := d.clock.Now()
	var steps driver.BuildSteps
	if opts.Built, steps, err = d.build(ctx, ref, builds, network, resolv, subnet); err != nil {
		return nil, err
	}
	buildMs := d.clock.Now().Sub(started).Milliseconds()
	keys, err := dataKeys(composeFile, projectDir)
	if err != nil {
		return nil, fmt.Errorf("dockergvisor: data volumes: %w", err)
	}
	d.mu.Lock()
	if o := d.machineLocked(ref.MachineID).output; o != nil {
		o.volumes = keys
	}
	d.mu.Unlock()
	abs, err := filepath.Abs(projectDir)
	if err != nil {
		return nil, err
	}
	// A reset of a machine with golden data mounts it where the image kept
	// its data in an anonymous volume (golden.go).
	d.mu.Lock()
	gold := d.machineLocked(ref.MachineID).golden
	firstTry := gold == nil && !d.machineLocked(ref.MachineID).goldenOff && !d.cfg.NoGoldenData
	d.mu.Unlock()
	if reset == nil {
		gold = nil
	}
	if gold != nil {
		opts.DataVolumes = gold.dataVolumes()
	}
	project, canonical, err := d.render(ctx, ref.MachineID, abs, composeFile, opts)
	if err != nil && gold != nil {
		d.goldenOff(ctx, ref.MachineID, "render: "+err.Error())
		gold, opts.DataVolumes = nil, nil
		project, canonical, err = d.render(ctx, ref.MachineID, abs, composeFile, opts)
	}
	if err != nil {
		return nil, err
	}
	defer os.Remove(project.File)
	rec, _ := recipe.Load(projectDir) // read and refused by the agent already
	if reset == nil {
		warnUnapplied(d.log(), ref.MachineID, rec)
	}
	seedAtInit := seedRunsAtInit(canonical, abs, rec)
	plan, why := planGolden(canonical, composeFile, abs, rec, seedAtInit, opts.DataVolumes)
	if gold != nil && (plan == nil || plan.sum != gold.sum) {
		// What the copy was made from changed: recreate, as before it.
		d.goldenOff(ctx, ref.MachineID, "inputs changed")
		gold, opts.DataVolumes = nil, nil
		os.Remove(project.File)
		if project, _, err = d.render(ctx, ref.MachineID, abs, composeFile, opts); err != nil {
			return nil, err
		}
		defer os.Remove(project.File)
	}
	// seedInData: this Up's data holds the recipe's seed already; nil
	// leaves what the last Up said (no reset: same data).
	var seedInData *bool
	var restoreMs, snapshotMs int64
	switch {
	case gold != nil:
		at := d.clock.Now()
		if err := d.restoreGolden(ctx, ref, gold); err != nil {
			d.goldenOff(ctx, ref.MachineID, err.Error())
			opts.DataVolumes = nil
			os.Remove(project.File)
			if project, _, err = d.render(ctx, ref.MachineID, abs, composeFile, opts); err != nil {
				return nil, err
			}
			defer os.Remove(project.File)
			seedInData = new(false)
		} else {
			restoreMs = d.clock.Now().Sub(at).Milliseconds()
			seedInData = new(gold.seeded)
			d.log().Info("data.golden.restored", "machine", ref.MachineID, "volumes", len(gold.vols), "ms", restoreMs)
		}
	case reset != nil:
		seedInData = new(false)
	case firstTry && plan == nil:
		d.goldenOff(ctx, ref.MachineID, why)
	case firstTry:
		at := d.clock.Now()
		g, seeded, err := d.takeGolden(ctx, ref, project, plan, abs, rec)
		seedInData = new(seeded)
		var seedErr *goldenSeedError
		if errors.As(err, &seedErr) {
			return nil, seedErr.err
		}
		snapshotMs = d.clock.Now().Sub(at).Milliseconds()
		if err != nil {
			d.goldenOff(ctx, ref.MachineID, err.Error())
		} else {
			d.mu.Lock()
			d.machineLocked(ref.MachineID).golden = g
			d.mu.Unlock()
			d.log().Info("data.golden.taken", "machine", ref.MachineID, "services", strings.Join(plan.services, ","), "volumes", len(g.vols), "seeded", g.seeded, "ms", snapshotMs)
		}
	}
	restoreAt := d.clock.Now()
	restored, err := d.restoreData(ctx, ref, keys)
	if err != nil {
		return nil, fmt.Errorf("dockergvisor: data from the bake: %w", err)
	}
	if restored > 0 {
		d.log().Info("data.restored", "machine", ref.MachineID, "volumes", restored)
	}
	upAt := d.clock.Now()
	if err := d.d.ComposeUp(ctx, project); err != nil {
		return nil, err
	}
	upped := d.clock.Now()
	ids, err := d.d.IDs(ctx, dockercli.Filters{"label": {"com.docker.compose.project=" + ref.MachineID}})
	if err != nil {
		return nil, err
	}
	cs, err := d.d.Inspect(ctx, ids...)
	if err != nil {
		return nil, err
	}
	timing := bootPhases(started, upAt, upped, cs)
	timing.BuildMs = buildMs
	if restored > 0 {
		timing.RestoreMs = upAt.Sub(restoreAt).Milliseconds()
	}
	timing.RestoreMs += restoreMs
	timing.SnapshotMs = snapshotMs
	if steps.Steps > 0 {
		timing.BuildSteps = &steps
	}
	if reset != nil {
		timing.Kind, timing.At, timing.DownMs = "reset", reset.at, reset.downMs
		timing.TotalMs = upped.Sub(reset.at).Milliseconds()
	}
	d.log().Info(timing.Kind+".timing", "machine", ref.MachineID, "totalMs", timing.TotalMs, "downMs", timing.DownMs, "buildMs", timing.BuildMs,
		"restoreMs", timing.RestoreMs, "upMs", timing.UpMs, "seedMs", timing.SeedMs, "readyMs", timing.ReadyMs)
	d.mu.Lock()
	d.machineLocked(ref.MachineID).boot = &claimBoot{claim: ref.Tags[driver.TagClaim], timing: timing}
	d.mu.Unlock()
	var sources []string
	services := map[string]string{}
	containers := map[string]dockercli.Container{}
	for _, c := range cs {
		if ip := c.IP(network); ip != "" {
			sources = append(sources, ip)
			if svc := c.Labels["com.docker.compose.service"]; svc != "" {
				services[svc] = ip
				containers[svc] = c
			}
		}
	}
	at, ok := execService(projectDir, containers)
	targets := make(map[string]execTarget, len(containers))
	for svc, c := range containers {
		targets[svc] = targetOf(c)
	}
	d.mu.Lock()
	m := d.machineLocked(ref.MachineID)
	m.services, m.exec, m.targets = services, nil, targets
	if ok {
		m.exec = &at
	}
	// Every data volume came from the bake: its seed is in them already.
	m.restoredData = len(keys) > 0 && restored == len(keys)
	m.seedAtInit = seedAtInit
	if seedInData != nil {
		m.seedInData = *seedInData
	}
	d.mu.Unlock()
	return sources, nil
}

// render writes the cell's compose file for the project and checks what
// compose will run from it (VerifyCanonical). The caller removes the file.
func (d *Driver) render(ctx context.Context, machine, abs string, composeFile []byte, opts sandbox.Options) (dockercli.ComposeProject, []byte, error) {
	out, err := sandbox.Apply(composeFile, opts)
	if err != nil {
		return dockercli.ComposeProject{}, nil, err
	}
	// The rewritten file lives in the cell's own directory: the checkout is
	// the PR's, and any name in it may be a planted symlink.
	f, err := os.CreateTemp(d.cfg.WorkDir, "kodus-compose-*.yaml")
	if err != nil {
		return dockercli.ComposeProject{}, nil, err
	}
	project := dockercli.ComposeProject{Name: machine, Dir: abs, File: f.Name(), EnvFile: os.DevNull}
	fail := func(err error) (dockercli.ComposeProject, []byte, error) {
		os.Remove(f.Name())
		return dockercli.ComposeProject{}, nil, err
	}
	if _, err := f.Write(out); err != nil {
		f.Close()
		return fail(err)
	}
	if err := f.Close(); err != nil {
		return fail(err)
	}
	canonical, err := d.d.ComposeConfig(ctx, project)
	if err != nil {
		return fail(err)
	}
	if err := sandbox.VerifyCanonical(canonical, opts); err != nil {
		return fail(err)
	}
	return project, canonical, nil
}

// goldenOff ends the machine's golden data: its resets recreate the data
// from nothing, as before (golden.go).
func (d *Driver) goldenOff(ctx context.Context, machine, why string) {
	d.mu.Lock()
	m := d.machineLocked(machine)
	g := m.golden
	m.golden, m.goldenOff = nil, true
	d.mu.Unlock()
	if err := d.dropGolden(ctx, g); err != nil {
		d.log().Warn("data.golden.drop.failed", "machine", machine, "err", err)
	}
	d.log().Info("data.golden.off", "machine", machine, "reason", why)
}

func (d *Driver) Suspend(ctx context.Context, ref driver.MachineRef, _ driver.SuspendMode) error {
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return err
	}
	return d.d.ComposeStop(ctx, ref.MachineID)
}

func (d *Driver) Resume(ctx context.Context, ref driver.MachineRef) error {
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return err
	}
	return d.d.ComposeStart(ctx, ref.MachineID)
}

// Reset between rounds: the project's volumes are dropped and the cell
// brings it up again from the image (ADR-050).
func (d *Driver) Reset(ctx context.Context, ref driver.MachineRef, snap driver.SnapshotRef) error {
	if snap.Kind != "compose_volumes" {
		return fmt.Errorf("dockergvisor: reset %q not supported", snap.Kind)
	}
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return err
	}
	at := d.clock.Now()
	if err := d.d.ComposeDown(ctx, ref.MachineID, true); err != nil {
		return err
	}
	d.mu.Lock()
	d.machineLocked(ref.MachineID).reset = &pendingReset{at: at, downMs: d.clock.Now().Sub(at).Milliseconds()}
	d.mu.Unlock()
	return nil
}

// bootPhases splits a boot at what Docker says of its containers: up is
// compose creating and starting the first of them; seed is the services
// that depend on others waiting for those to pass their healthcheck (a
// database's init and seed run there, in its own start); ready is the last
// ones started passing theirs. With no dependency, seed is zero.
func bootPhases(started, upAt, upped time.Time, cs []dockercli.Container) driver.BootTiming {
	t := driver.BootTiming{Kind: "boot", At: started, UpMs: upped.Sub(upAt).Milliseconds(), TotalMs: upped.Sub(started).Milliseconds()}
	var first, last time.Time
	for _, c := range cs {
		if c.Labels["com.docker.compose.service"] == "" || c.StartedAt.IsZero() {
			continue
		}
		if first.IsZero() || c.StartedAt.Before(first) {
			first = c.StartedAt
		}
		if c.StartedAt.After(last) {
			last = c.StartedAt
		}
	}
	// A container that did not start in this up (or a clock that does not
	// agree with the daemon's) leaves the up whole.
	if first.IsZero() || first.Before(upAt) || last.After(upped) {
		return t
	}
	t.UpMs = first.Sub(upAt).Milliseconds()
	t.SeedMs = last.Sub(first).Milliseconds()
	t.ReadyMs = upped.Sub(last).Milliseconds()
	return t
}

// Destroy takes the project down and removes the holder, only when every
// container under that name is this cell's.
func (d *Driver) Destroy(ctx context.Context, ref driver.MachineRef) error {
	exists, err := d.owned(ctx, ref.MachineID)
	if err != nil {
		return err
	}
	// A machine whose data a bake is copying keeps its volumes past the
	// down; whichever of the two finishes last removes them.
	d.mu.Lock()
	pin := d.pinned[ref.MachineID]
	d.mu.Unlock()
	keepData := pin != nil && len(pin.volumes) > 0
	if exists {
		err = d.d.ComposeDown(ctx, ref.MachineID, !keepData)
		if rerr := d.d.Remove(ctx, ref.MachineID); rerr != nil {
			err = errors.Join(err, rerr)
		}
	}
	if keepData {
		if rerr := d.downForBake(ctx, ref.MachineID, pin); rerr != nil {
			err = errors.Join(err, rerr)
		}
	} else if rerr := d.removeProjectVolumes(ctx, ref.MachineID); rerr != nil {
		err = errors.Join(err, rerr)
	}
	// Its golden data goes with it (golden.go).
	if rerr := d.reaper().removeGolden(ctx, ref.MachineID); rerr != nil {
		err = errors.Join(err, rerr)
	}
	if rerr := d.removeBuilt(ctx, ref.MachineID); rerr != nil {
		err = errors.Join(err, rerr)
	}
	if rerr := removeDecoyFile(decoyPath(d.workDir(), ref.MachineID)); rerr != nil {
		err = errors.Join(err, rerr)
	}
	d.forget(ref.MachineID)
	d.mu.Lock()
	_, baking := d.pinned[ref.MachineID]
	d.mu.Unlock()
	// A machine being baked leaves its build cache to the bake.
	if !baking {
		if rerr := d.removeMachineCache(ref.MachineID); rerr != nil {
			err = errors.Join(err, rerr)
		}
	}
	if err == nil {
		d.mu.Lock()
		release := d.generationHolds[ref.MachineID]
		delete(d.generationHolds, ref.MachineID)
		d.mu.Unlock()
		if release != nil {
			release()
		}
	}
	return err
}

// List is this cell's holders (one per machine) carrying the selector's
// labels: a selector naming another cell finds nothing.
func (d *Driver) List(ctx context.Context, selector map[string]string) ([]driver.MachineRef, error) {
	if cell, ok := selector[driver.TagCell]; ok && cell != d.cfg.CellID {
		return nil, nil
	}
	labels := toLabels(selector)
	labels[dockercli.LabelFromTag(driver.TagCell)] = d.cfg.CellID
	labels[labelMachine] = ""
	cs, err := d.d.List(ctx, labels)
	if err != nil {
		return nil, err
	}
	var out []driver.MachineRef
	for _, c := range cs {
		tags := map[string]string{}
		for k, v := range c.Labels {
			tags[dockercli.TagFromLabel(k)] = v
		}
		if !driver.Matches(tags, selector) || c.Labels[labelMachine] != c.Name {
			continue
		}
		if e := d.peek(c.Name).expires; !e.IsZero() {
			tags[driver.TagExpires] = driver.FormatTime(e)
		}
		network := networkName(tags[driver.TagClaim])
		out = append(out, driver.MachineRef{MachineID: c.Name, DriverRef: c.ID, PrivateAddress: c.IP(network), ImageID: tags["kodus:image"], Tags: tags})
	}
	return out, nil
}

// SetExpiry moves kodus:expires, which lives in the driver's state (labels
// never change), for this cell's machine, held under the ceiling its
// holder's label carries (not the one the caller's ref says).
func (d *Driver) SetExpiry(ctx context.Context, ref driver.MachineRef, at time.Time) error {
	holders, err := d.d.List(ctx, map[string]string{labelMachine: ref.MachineID})
	if err != nil {
		return err
	}
	if len(holders) != 1 || holders[0].Labels[dockercli.LabelFromTag(driver.TagCell)] != d.cfg.CellID {
		return fmt.Errorf("%w: machine %s", driver.ErrNotOwned, ref.MachineID)
	}
	hard, perr := time.Parse(time.RFC3339, holders[0].Labels[dockercli.LabelFromTag(driver.TagHardExpires)])
	if perr != nil {
		return fmt.Errorf("dockergvisor: machine %s has no ceiling: %w", ref.MachineID, perr)
	}
	if at.After(hard) {
		at = hard
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.machineLocked(ref.MachineID).expires = at
	return nil
}

var (
	_ driver.MachineDriver = (*Driver)(nil)
	_ driver.ComposeBooter = (*Driver)(nil)
	_ driver.RecipeRunner  = (*Driver)(nil)
)

// BootTiming is the claim's last boot, per phase: its builds (each a
// BuildKit run and the image's load) and compose up.
func (d *Driver) BootTiming(claimID string) (driver.BootTiming, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, m := range d.machines {
		if m.boot != nil && m.boot.claim == claimID {
			return m.boot.timing, true
		}
	}
	return driver.BootTiming{}, false
}
