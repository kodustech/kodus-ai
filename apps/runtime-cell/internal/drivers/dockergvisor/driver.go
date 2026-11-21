// Package dockergvisor is the docker-gvisor MachineDriver for self-hosted
// (docs/runtime/isolation-architecture.md): each side of a Run is a compose project whose services
// run under gVisor (runtime: runsc) in the host's Docker. Root on a shared
// host is the threat (S-10): the compose file goes through the allowlist
// (internal/compose/sandbox) before any container starts, docker runs with
// a minimal environment and no interpolation file, and what compose would
// run is checked a second time from its own canonical output.
//
// The agent boots the project through Up (driver.ComposeBooter) and must add
// the sources Up returns to the claim's egress policy.
//
// The driver runs its machines under gVisor (isolation/gvisor) on the
// docker placement (placement/docker: where machines live and how a claim's
// network attaches). Claims, egress wiring, the build path, the registry,
// data and golden copies and the sandbox pool stay here. Firecracker
// machines run on the microvm driver, which shares packages with this one.
package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
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

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildcache"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildstate"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/registry"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/remotecache"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/gvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lifecycle"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement"
	dockerplacement "github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/docker"
)

type Config struct {
	// IOLimits are the per-sandbox disk and network rates (the shared
	// policy, driver.IOLimits): each workload container's writes to the disk
	// Docker's data root is on get Docker's blkio limits, and its host-side
	// veths a token bucket each way (tc). A sandbox's /workspace and /tmp
	// are in its memory, which its memory limit bounds. nil: none.
	IOLimits *driver.IOLimits
	// ClaimLimits enforces the whole container tree; nil leaves legacy per-container limits.
	ClaimLimits claimlimits.Manager
	// ClaimBudgets lowers a ready claim's memory ceiling and reads what its
	// budget holds (settle.go); the same backend as ClaimLimits. nil: a
	// ready claim stays counted, and capped, at its whole ceiling.
	ClaimBudgets claimlimits.Resizer
	// ClaimLimitBackend is explicit: cgroupfs (default) or systemd.
	ClaimLimitBackend string
	// MirrorGoProxy is the GOPROXY every build gets as a build argument
	// (the cell's registry mirror, "…/go,off"); a Dockerfile that declares
	// ARG GOPROXY fetches its modules there. Empty: none.
	MirrorGoProxy string
	// MirrorNPM and MirrorPyPI are the cell mirror's npm registry
	// (http://mirror.cell.internal:8080/npm/) and PyPI simple index
	// (…/pypi/simple/), given to every build as npm_config_registry and
	// PIP_INDEX_URL (with PIP_TRUSTED_HOST, the mirror being plain HTTP on
	// the claim network): a Dockerfile that declares the ARG installs
	// through the read-only mirror. Empty: none.
	MirrorNPM, MirrorPyPI string
	// MirrorRegistry is the cell's registry mirror (host:port) every build's
	// BuildKit pulls docker.io images through; empty: straight to Docker Hub.
	MirrorRegistry string
	// PersistBuildState keeps BuildKit's state per environment
	// (build_states.go, buildstate): the default branch's setup writes it,
	// every other build reads it through a throwaway overlay. Off: each build starts from the exported
	// cache alone.
	PersistBuildState bool
	// DiskMinFreeBytes is the cell's free-disk floor (-disk-min-free-gb),
	// under which the agent's watchdog stops every claim of the cell. The
	// driver keeps a margin of the same size above it (diskfloor.go): a
	// workload is not created, and a running build is stopped, while the
	// work directory's or Docker's disk has less than twice it free, so the
	// claim that is filling the disk ends before the watchdog ends them all.
	// Zero: no margin.
	DiskMinFreeBytes int64
	// BuildStateMinFreeBytes: below this free space on the cell's disk, the
	// environment states nobody holds that are cheapest to keep are removed
	// (buildstate/cost.go), then exported caches no build reads.
	BuildStateMinFreeBytes int64
	// BuildStateKeep bounds what BuildKit keeps in one state ("20GB"; its GC).
	BuildStateKeep string
	// BuildCacheRemote is the build cache's store off the cell
	// (cache_remote.go, docs/runtime/build-cache.md): an OCI registry,
	// http(s)://host[:port]/<prefix>, plain HTTP only on loopback. Empty: the
	// cache lives on the cell only, as before. BuildCacheRemoteAuth is
	// "user:password" for it, or empty.
	BuildCacheRemote     string
	BuildCacheRemoteAuth string
	// BakeShare is the org's registry of baked images (share.go,
	// docs/runtime/shared-baked-environments.md), the same URL form as
	// BuildCacheRemote: each bake's images are pushed there and a claim of
	// the org on any cell pulls one by digest. BakeSharePull, when set, is
	// where pulls go instead (a mirror or pull-through cache near the cell;
	// pushes still go to BakeShare). BakeShareAuth is "user:password" for
	// both, or empty. Empty BakeShare: bakes stay on the cell, as before.
	BakeShare     string
	BakeSharePull string
	BakeShareAuth string
	// ImageTransfer is how a build's image reaches this Docker (registry.go):
	// TransferTarball (also when empty) or TransferRegistry (cmd/cell's
	// default), which needs RegistryImage, the distribution registry by
	// digest, and sends a tarball for a build the registry was never seeded for.
	// RegistryKeepBytes bounds an environment's seed storage (zero:
	// DefaultRegistryKeepBytes).
	ImageTransfer     string
	RegistryImage     string
	RegistryKeepBytes int64
	// MaxImageBytes bounds what one build may leave for the cell to load: its
	// output directory, the image tarball in it included. Zero:
	// dockercli.DefaultMaxImageBytes.
	MaxImageBytes int64
	// ContainerDiskSize caps the writable layer of every holder, builder and
	// compose service ("50G", docker --storage-opt size=, compose
	// storage_opt). Off when empty: only some storage drivers apply it
	// (dockercli.ValidDiskSize), and the daemon refuses the container on the
	// others.
	ContainerDiskSize string
	// ServiceLogMaxSize and ServiceLogMaxFile bound every compose service's
	// logs (the local log driver's max-size and max-file, forced whatever the
	// file says; sandbox.DefaultLogMaxSize and DefaultLogMaxFile when unset).
	ServiceLogMaxSize string
	ServiceLogMaxFile int
	CellID            string
	// Runtime is the gVisor backend's OCI runtime ("runsc" when empty): its
	// machines' and the cell's helper containers on a claim.
	Runtime string
	// Host is what the host gives the backends (KVM, arch); probed when nil.
	Host        *isolation.Host
	HolderImage string
	PidsLimit   int
	// MemLimit and CPUs are forced on every compose service and build ("4g",
	// "2") of a claim that asks no size of its own.
	MemLimit string
	CPUs     string
	// MemMax and CPUsMax are the largest size one claim may ask
	// (claim.acquire size); empty or zero: the host's (HostMemoryMB,
	// HostCPUs) when known, else MemLimit and CPUs. Neither may be below the
	// default.
	MemMax  string
	CPUsMax int
	// HostMemoryMB and HostCPUs are what the host gives claims: the memory
	// the cell may commit (MemTotal less the reserve) and its CPU count.
	// Zero: unknown, and the ceiling stays at the default.
	HostMemoryMB, HostCPUs int
	// MemReady is the least ceiling a ready claim keeps under claim limits
	// (SettleReady), as docker takes it ("2g" when empty, never above the
	// claim's own memory). Without claim limits a claim is counted at its
	// memory limit, which its services share (ClaimMemory).
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
	// BuilderTrustsCellCA: BuilderImage is the cell's own builder
	// (builder-image/, with exec-ca-bundle.patch). With the trust files, every
	// build's RUN steps then trust the cell CA: the claim's policy inspects
	// the builder's TLS like a machine's (G1) and its builds get the claim's
	// secrets (G6). False: a stock BuildKit, whose RUN steps keep their
	// image's trust store, so the builder reaches only its passthrough hosts
	// over TLS.
	BuilderTrustsCellCA bool
	// BuilderUID and BuilderGID are the builder's ids as the host sees them,
	// the owner of the directories it writes (hostdirs.go). Zero: the
	// image's user (1000), which is right only when Docker maps no user
	// namespace; with one (userns-remap, rootless) they must be set.
	BuilderUID, BuilderGID int
	// HelperImage copies data volumes under Runtime (sh and cp -a) for a
	// bake and for a claim that starts from one; busybox:1.36 when empty.
	HelperImage string
	// MaxBuilds is how many builds the cell runs at once, whichever claims
	// they are for; a build past it waits for a slot. Each builder takes
	// its claim's CPUs (2 by default), and memory admission alone lets
	// more claims boot together than the cores hold, which skews the base
	// and PR timings the gate compares (G5). 0: half the host's CPUs, at
	// least one.
	MaxBuilds int
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
	// WarmForkReset keeps a warm spare of a Run's compose project booted
	// beside it, so the next round's reset is a swap (spare.go, Parts
	// Spares): the agent boots one only when its memory admission has room.
	// Refused with ClaimLimits: a spare runs in its claim's own ceiling.
	WarmForkReset bool
	// Log gets the driver's build and bake events; discarded when nil.
	Log *slog.Logger
	// Clock is what the build states' and caches' bookkeeping reads the
	// time from (last use, generation and trash names); the wall clock when
	// nil.
	Clock clock.Clock

	// SandboxImage is the code sandbox's tool image, by digest, with the
	// guest agent at /usr/local/bin/kody-guest (sandbox.go). Empty: no sandboxes.
	SandboxImage string
	// CellImages are the cell's images this config does not name (the
	// browser runner). With the ones it does, they may have been pulled
	// with the cell's own login: a service that names one of their
	// repositories gets it only as a registry serves it anonymously (pull).
	CellImages []string
	// Trust are the cell's trust files (internal/machinetrust), mounted
	// read-only into the machines of a claim whose request asks them
	// (UpRequest.CellTrust, SandboxRequest.CellTrust): every compose service
	// with the trust variables, and a code sandbox, where the guest agent
	// sets them. Zero: no machine gets them.
	Trust machinetrust.Files
}

// Driver is the docker-gvisor machine driver. Docker labels cannot change
// after creation. That suits kodus:hard-expires (immutable by construction);
// kodus:expires lives in the driver's memory.
type Driver struct {
	d   Docker
	cfg Config
	// place is where machines live and how a claim's network attaches;
	// backend (gVisor) makes and ends them.
	place   placement.Placement
	backend *gvisor.Backend
	host    isolation.Host
	mu      sync.Mutex
	// machines is what the driver knows of each machine, from Create to
	// Destroy (machineState).
	machines map[string]*machineState
	// observerSQL never participates in a machine snapshot or persisted state.
	observerSQL map[string]*observerSQLAccount
	limitGroups map[string]limitGroup
	// subnets is each claim network's subnet, from PrepareClaim (or the
	// first Up that read it) to ReleaseClaim: a network's subnet never
	// changes while it exists, so each Up does not ask Docker again (G4).
	subnets map[string]netip.Prefix
	// slotsOnce makes buildSlots, MaxBuilds wide (build.go buildSlot).
	slotsOnce  sync.Once
	buildSlots chan struct{}
	// dataRoot is Docker's data root, read once for the disk margin;
	// writers the builds running, which the margin weighs (build.go).
	dataRoot dataRootCache
	writers  buildWriters
	// pinned is what a bake took from a clean setup machine
	// (PinBakeSource) until the bake is done with it, past the machine's
	// Destroy.
	pinned map[string]*pinnedOutput
	// adopted binds a claim to the pool machine's network it took (Adopt),
	// until that network is released.
	adopted map[string]string
	// dirs makes the host directories the builder writes (hostdirs.go).
	dirs hostDirs
	// states are the environments' BuildKit states (build_states.go,
	// buildstate); caches their exported build caches (cache.go).
	states stateStore
	caches *buildcache.Generations
	// remote is the build cache's store off the cell; nil: none.
	remote    remoteCache
	transfers remoteTransfers
	// share is the org's registry of baked images (pushes), sharePull where
	// pulls go (share itself, or a mirror); nil: bakes are not shared.
	share, sharePull imageShare
	// reclaim runs ReclaimDisk off the sweep's goroutine (sweep.go).
	reclaim diskReclaim
	// bg owns the work that outlives the call that started it (the disk
	// reclaim, the remote cache pushes) until Shutdown (lifetime.go).
	bg *lifecycle.Group
	// maxSize is the largest size Create accepts.
	maxSize driver.ClaimSize
	// defaultSize is what a claim that asks no size gets: MemLimit, and CPUs
	// by its whole part (as maxClaimSize counts it).
	defaultSize driver.ClaimSize
	// defaultMemMB is MemLimit in MB, readyMB MemReady (ClaimMemory).
	defaultMemMB, readyMB int
	// healthEvery is HealthStartInterval once the daemon is known to take
	// it; zero: off.
	healthEvery time.Duration
	// clock times boots and resets (BootTiming).
	clock           clock.Clock
	catalogMu       sync.Mutex
	catalog         *bakecatalog.Catalog
	generationHolds map[string]func()
	// registries is the registry image transfer (package registry); nil
	// on the tarball transfer.
	registries *registry.Registries
	// hooks are the seams only tests set (export_test.go); nil in production.
	hooks *testHooks
}

// testHooks replace or interleave with the driver's work in tests. A zero
// field keeps the production behavior.
type testHooks struct {
	// syncCatalogDir replaces the catalog's directory sync.
	syncCatalogDir func(*os.File) error
	// dialRegistry dials a build's registry.
	dialRegistry func(ctx context.Context, network, addr string) (net.Conn, error)
	// buildDiskEvery is how often a running build's host directories are
	// measured (watchBuildDisk); zero: defaultBuildDiskEvery.
	buildDiskEvery time.Duration
	// freeBytes measures the free space evictCaches keeps above the floor;
	// nil: buildstate.FreeBytes.
	freeBytes func(path string) (int64, error)
}

// registryDialer dials a build's registry in production.
var registryDialer = &net.Dialer{Timeout: 5 * time.Second}

// dialRegistry dials a build's registry, through the test hook when set.
func (d *Driver) dialRegistry(ctx context.Context, network, addr string) (net.Conn, error) {
	if d.hooks != nil && d.hooks.dialRegistry != nil {
		return d.hooks.dialRegistry(ctx, network, addr)
	}
	return registryDialer.DialContext(ctx, network, addr)
}

func (d *Driver) log() *slog.Logger {
	if d.cfg.Log == nil {
		return slog.New(slog.DiscardHandler)
	}
	return d.cfg.Log
}

// ErrNoIsolatedRuntime means the cell does not start without gVisor (S-10).
var ErrNoIsolatedRuntime = gvisor.ErrNoRuntime

// newBackend is the gVisor backend on this host's Docker.
func newBackend(ctx context.Context, d backendPort, cfg Config) (*gvisor.Backend, error) {
	b, err := gvisor.New(ctx, d, cfg.Runtime)
	if err != nil || cfg.IOLimits == nil {
		return b, err
	}
	if root, err := d.DataRoot(ctx); err == nil {
		b.BoundIOOn(dockercli.DataRootDisk(root))
	}
	return b, nil
}

func New(ctx context.Context, d Docker, cfg Config) (*Driver, error) {
	if cfg.CellID == "" || cfg.HolderImage == "" {
		return nil, errors.New("dockergvisor: cell id and holder image required")
	}
	if cfg.ObserverImage != "" && cfg.ObserverTLSDir == "" {
		return nil, errors.New("dockergvisor: an observer image needs its TLS directory")
	}
	if p := cfg.ClaimSubnets; p.IsValid() && (!p.Addr().Is4() || p.Bits() > 24) {
		return nil, fmt.Errorf("dockergvisor: claim subnets %s is not an IPv4 pool of a /24 or wider", p)
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
	if cfg.WarmForkReset && cfg.ClaimLimits != nil {
		// A spare would share the claim's settled ceiling (settle.go), which
		// never rises: both copies would run out of memory under it.
		return nil, errors.New("dockergvisor: the warm fork reset needs claim limits off: a spare runs in its claim's ceiling")
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
	helper, err := helperImage(cfg.HelperImage)
	if err != nil {
		return nil, err
	}
	cfg.HelperImage = helper
	if err := dockercli.ValidDiskSize(cfg.ContainerDiskSize); err != nil {
		return nil, err
	}
	if cfg.MaxImageBytes <= 0 {
		cfg.MaxImageBytes = dockercli.DefaultMaxImageBytes
	}
	switch cfg.ImageTransfer {
	case "":
		cfg.ImageTransfer = TransferTarball
	case TransferTarball:
	case TransferRegistry:
		if cfg.RegistryImage == "" || cfg.BuilderImage == "" {
			return nil, errors.New("dockergvisor: the registry image transfer needs a builder image and a registry image")
		}
	default:
		return nil, fmt.Errorf("dockergvisor: image transfer %q is not tarball or registry", cfg.ImageTransfer)
	}
	maxSize, err := maxClaimSize(cfg)
	if err != nil {
		return nil, err
	}
	host := isolation.ProbeHost()
	if cfg.Host != nil {
		host = *cfg.Host
	}
	backend, err := newBackend(ctx, d, cfg)
	if err != nil {
		return nil, err
	}
	defMem, err := parseMemMB(cfg.MemLimit)
	if err != nil {
		return nil, err
	}
	defCPUs, err := parseCPUs(cfg.CPUs)
	if err != nil {
		return nil, err
	}
	readyMB := defaultReadyMB
	if cfg.MemReady != "" {
		if readyMB, err = parseMemMB(cfg.MemReady); err != nil {
			return nil, err
		}
	}
	dr := &Driver{d: d, cfg: cfg, place: dockerplacement.Placement{N: d}, backend: backend, host: host, machines: map[string]*machineState{}, pinned: map[string]*pinnedOutput{}, adopted: map[string]string{}, maxSize: maxSize, defaultSize: driver.ClaimSize{MemoryMB: defMem, CPUs: defCPUs}, states: noStates{}, dirs: defaultHostDirs(), defaultMemMB: defMem, readyMB: readyMB, bg: lifecycle.New(context.WithoutCancel(ctx))}
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
	if dr.registryMode() {
		// The seed is sealed by making its blobs the cell's and read-only
		// (sealSeed): a cell that is the builder's uid owns what the builder
		// writes, and a pull request's registry could rewrite a blob it was
		// linked.
		if dr.dirs.self == dr.dirs.uid {
			return nil, fmt.Errorf("dockergvisor: the registry image transfer needs the cell to run as another uid than the builder's (%d); run it as another uid, or choose -gvisor-image-transfer tarball", dr.dirs.uid)
		}
		if err := dr.dirs.privateRoot(dr.registryRoot()); err != nil {
			return nil, err
		}
		// No build runs yet.
		dr.registries = dr.newRegistries()
		if err := dr.registries.Clear(); err != nil {
			return nil, err
		}
	}
	clk := clock.Or(cfg.Clock)
	dr.clock = clk
	dr.healthEvery = dr.healthStartInterval(ctx)
	dr.caches = buildcache.New(filepath.Join(dr.workDir(), "cache", "env"), filepath.Join(dr.workDir(), "cache", "trash"), clk)
	if cfg.BuildCacheRemote != "" {
		reg, err := remotecache.New(remotecache.Config{URL: cfg.BuildCacheRemote, Auth: cfg.BuildCacheRemoteAuth})
		if err != nil {
			return nil, err
		}
		dr.remote = reg
		dr.log().Info("build.cache.remote", "store", reg.Where())
	}
	if cfg.BakeSharePull != "" && cfg.BakeShare == "" {
		return nil, errors.New("dockergvisor: a bake share pull mirror needs the bake share it mirrors")
	}
	if cfg.BakeShare != "" {
		push, err := remotecache.New(remotecache.Config{URL: cfg.BakeShare, Auth: cfg.BakeShareAuth})
		if err != nil {
			return nil, err
		}
		dr.share, dr.sharePull = push, push
		if cfg.BakeSharePull != "" {
			pull, err := remotecache.New(remotecache.Config{URL: cfg.BakeSharePull, Auth: cfg.BakeShareAuth})
			if err != nil {
				return nil, err
			}
			dr.sharePull = pull
		}
		dr.log().Info("bake.share", "store", push.Where(), "pull", dr.sharePullWhere())
	}
	if cfg.PersistBuildState {
		root := filepath.Join(dr.workDir(), "buildkit")
		// A clone where the state's filesystem reflinks, the kernel's overlay
		// elsewhere: on the overlay a build that replaces a file of an earlier
		// layer fails and runs again cold (buildstate.cloneMounter).
		mounter, view := buildstate.MounterFor(root)
		dr.log().Info("build.state.store", "root", root, "view", view)
		if dr.states, err = buildstate.New(buildstate.Config{
			Root: root, CellID: cfg.CellID, MinFree: cfg.BuildStateMinFreeBytes,
			BuilderDir: dr.dirs.builderDir, Mounter: mounter, FreeBytes: buildstate.FreeBytes, Clock: clk, Log: dr.log(),
			// A clone is a plain directory: the next build's view can be made
			// ahead of it (buildstate/spare.go). A kernel overlay is made at once.
			SpareViews: view == "clone",
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

// Capabilities is the backend's, on the docker placement, with what the
// shared layer adds (the largest size).
func (d *Driver) Capabilities() driver.Capabilities {
	b := d.backend.Capabilities()
	return driver.Capabilities{
		Isolation: b.Isolation, NestedContainers: b.NestedDocker, Arch: b.Arch, MaxClaimSize: d.maxSize, DefaultClaimSize: d.defaultSize,
		Backends: []string{b.Backend}, KVM: d.host.KVM, HostArch: d.host.Arch,
		SandboxCellTrust: d.cfg.Trust.Set(), ShareBakes: d.share != nil,
	}
}

// Parts is everything the shared layer does beyond the core: bakes and their
// catalog, the compose boot and the recipe, the pool, code sandboxes (when
// the backend runs them), the memory budget, the readers of a claim's boot,
// logs and failure, observer SQL and the sweep. No memory snapshot: the
// gVisor backend keeps none.
func (d *Driver) Parts() driver.Parts {
	p := driver.Parts{
		Baker: d, BakePinner: d, BakeCatalog: d, Resetter: d,
		Composer: d, Recipes: d, Pooler: d, Memory: d,
		Diagnoser: d, ServiceLogs: d, BootTimes: d, BootPhases: d, BuildStates: d,
		SQLObservers: d, Sweeper: d, Coverage: d, DiskUsers: d,
	}
	if d.SandboxesEnabled() {
		p.Sandboxes = d
	}
	if d.cfg.WarmForkReset {
		p.Spares = d
	}
	if _, ok := d.resizer(); ok {
		p.ReadyMemory, p.Health = d, d
	}
	return p
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
	return []string{
		"/observer", "-listen", fmt.Sprintf(":%d", ObserverPort), "-cell-id", cell,
		"-cert", observerTLSMount + "/cert.pem", "-key", observerTLSMount + "/key.pem", "-ca", observerTLSMount + "/ca.pem",
	}
}

var (
	_ driver.MachineDriver = (*Driver)(nil)
	_ driver.ComposeBooter = (*Driver)(nil)
	_ driver.RecipeRunner  = (*Driver)(nil)
)

// BootPhases is the claim's last boot in words, slowest first, whether it
// came up or not (driver.BootPhaser).
func (d *Driver) BootPhases(claimID string) ([]driver.BootPhase, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, m := range d.machines {
		if m.phases != nil && m.phases.claim == claimID {
			return append([]driver.BootPhase(nil), m.phases.phases...), true
		}
	}
	return nil, false
}

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
