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
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/bakecatalog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildcache"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildstate"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
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
	caches *buildcache.Generations
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
	clock     clock.Clock
	catalogMu sync.Mutex
	catalog   *bakecatalog.Catalog
	// syncCatalogDir replaces the catalog's directory sync; nil in production.
	syncCatalogDir  func(*os.File) error
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
	dr.caches = buildcache.New(filepath.Join(dr.workDir(), "cache", "env"), filepath.Join(dr.workDir(), "cache", "trash"), clk)
	if cfg.PersistBuildState {
		if dr.states, err = buildstate.New(buildstate.Config{
			Root: filepath.Join(dr.workDir(), "buildkit"), CellID: cfg.CellID, MinFree: cfg.BuildStateMinFreeBytes,
			BuilderDir: dr.dirs.builderDir, Mounter: buildstate.DefaultMounter(), FreeBytes: buildstate.FreeBytes, Clock: clk, Log: dr.log(),
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

// observerTLSMount is where an observer machine finds ObserverTLSDir.
const observerTLSMount = "/etc/kodus/observer"

// ObserverPort is where an observer machine serves the cell (cmd/observer).
const ObserverPort = 7443

func observerCmd(cell string) []string {
	return []string{"/observer", "-listen", fmt.Sprintf(":%d", ObserverPort), "-cell-id", cell,
		"-cert", observerTLSMount + "/cert.pem", "-key", observerTLSMount + "/key.pem", "-ca", observerTLSMount + "/ca.pem"}
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
