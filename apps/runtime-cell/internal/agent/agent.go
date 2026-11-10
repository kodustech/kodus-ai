// Package agent is the cell agent (docs §4 "Agente da célula"): it holds the
// outbound connection to the hub, executes its messages, keeps the leases
// and runs the dead-man switch. It decides nothing about the PR.
//
// The agent orchestrates; the parts live apart:
//   - claims: each claim's state machine and the registry that bounds them;
//   - outbox: claim frames delivered until the hub acks them;
//   - lease: lease, sweep and dead-man, which own how long machines live;
//   - handle.go: one hub frame to one handler, no I/O on the read loop;
//   - checkout: what is read from and written into a claim's checkout;
//   - admission: the memory ledger; pool: the warm pool; provenance: which
//     machines ran PR code and which images this cell baked (S-52);
//   - acquire.go, steps.go, release.go: the claim's life on the cell;
//   - egress_sync.go, image_policy.go, hold.go, bundle.go, redaction.go.
package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/admission"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/evidence"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/outbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/pool"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/provenance"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/browser"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dedup"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/transport"
)

// ClaimInfo is what the agent tells the egress control and the observer
// factory about a claim once its machines exist.
type ClaimInfo struct {
	ClaimID            string
	ObserverGeneration uint64 // private observer configuration, never a public frame
	Acquire            protocol.ClaimAcquireBody
	Workload           driver.MachineRef
	Observer           driver.MachineRef
	Network            driver.ClaimNetwork
	// Sources are more addresses the claim's traffic comes from (the
	// containers of a compose project the driver booted): the claim's
	// egress policy lists them with the workload's and the observer's.
	Sources []string
	// ExtraAllow is the hub's egress.policy allowlist for this claim; it
	// adds to the cell's base allowlist and replaces the previous one.
	ExtraAllow []string
	// GoPins are what the checkout's go.sum pins (module@version).
	GoPins []string
	// ImagePins are the Docker Hub images the checkout's Dockerfiles name.
	ImagePins []string
}

// ObserverFactory returns the client for a claim's observer machine.
type ObserverFactory func(ctx context.Context, c ClaimInfo, targets []observer.Target) (observer.Client, error)

// RepoSource gives the tarball URL of the claim's environment at its SHA.
type RepoSource func(acq protocol.ClaimAcquireBody) (string, error)

// ClaimKeyer is a transport that needs per-claim keys (SSH): it returns the
// user-data that gives the workload its keys, and forgets them on release.
type ClaimKeyer interface {
	PrepareClaim(claimID string) (userData string, err error)
	Forget(claimID string)
}

// EgressControl pushes the claim's signed policy to the proxy and resolver.
// Apply is called again for the same claim when the hub sends a new
// egress.policy; the pushed policy replaces the previous one.
type EgressControl interface {
	Apply(ctx context.Context, c ClaimInfo) error
	Remove(ctx context.Context, claimID string) error
}

// ManifestSource is a driver that knows what it booted for a claim (the
// recipe's services, the expose list it published, the seed hash):
// claim.ready carries that manifest instead of the one built from
// claim.acquire.
type ManifestSource interface {
	Manifest(claimID string) (protocol.Manifest, bool)
}

// ClaimSecretSource holds exact secret values of a claim (the SSH keys of
// the claim); the agent redacts them from all the claim sends (S-51).
type ClaimSecretSource interface {
	ClaimSecrets(claimID string) []redact.Known
}

// DeniedEgress is one request the proxy or the resolver refused for a claim.
type DeniedEgress struct {
	Host string
	Port int
	At   time.Time
	// Platform: the platform deny list refused it; no approval lifts it.
	Platform bool
}

// DeniedEgressSource remembers what egress it denied, for the failure
// bundle.
type DeniedEgressSource interface {
	Denied(claimID string) []DeniedEgress
}

type Config struct {
	CellID    string
	Regions   []string
	Owner     protocol.CellOwner
	MaxClaims int
	// MaxClaimSteps bounds active exec, probe and reset work per claim.
	// Zero selects DefaultMaxClaimSteps; explicit limits are 1 through 64.
	MaxClaimSteps int

	Driver       driver.MachineDriver
	Transport    transport.Transport
	Observers    ObserverFactory
	Repo         RepoSource
	Extractor    tarball.Extractor
	Revoker      tarball.Revoker
	Egress       EgressControl
	RecipeEgress RecipeEgressValidator
	FakeSupport  bool // this driver materializes the closed recipe fake services
	SQLObservers driver.SQLObserverProvisioner
	OrgKey       func(orgID string) (string, error)
	// ClaimSecrets returns more exact values the cell knows for a claim
	// (seed passwords, test secrets it injected); they are redacted from
	// everything the claim sends, like the download token (S-51).
	ClaimSecrets func(ClaimInfo) []redact.Known

	// Optional capabilities, wired by the composition root; nil is "this
	// cell has none". The agent never discovers them by type assertion.
	Keys         ClaimKeyer          // per-claim transport keys (SSH)
	Manifests    ManifestSource      // what the driver booted
	BootTimes    driver.BootTimer    // the driver's boot and reset phases
	Diagnoser    driver.Diagnoser    // the failure bundle's service view
	Secrets      []ClaimSecretSource // more exact values to redact
	DeniedEgress DeniedEgressSource  // the failure bundle's denied egress
	// Composer boots the claim's compose project itself (docker-gvisor):
	// the agent hands it the checkout's compose file and adds the
	// containers' addresses to the claim's egress Sources.
	Composer driver.ComposeBooter
	// Recipes runs the recipe's own boot steps (setup, data.migrate,
	// data.seed) in the project Composer brought up; nil: this cell runs
	// none. Set with Composer, by the composition root.
	Recipes driver.RecipeRunner
	// BakePinner is set when the driver bakes from the setup claim's
	// machine (docker-gvisor): image.bake pins that machine's output before
	// the ack, so releasing the claim cannot take it away.
	BakePinner driver.BakeSourcePinner
	// BakeCatalog restores only verified default-branch image eligibility.
	// It does not restore pool holders, claims, credentials or leases.
	BakeCatalog driver.BakeCatalog
	// RecoveryContext is the process startup/shutdown context; recovery is
	// additionally capped at 30 seconds. Nil retains the bounded library default.
	RecoveryContext context.Context
	// Pooler keeps clean machines ready per environment (pool.target);
	// nil refuses pool.target. PoolMax bounds one environment's pool and
	// PoolTTL how long a pool machine waits (defaults 4 and 4h).
	Pooler  driver.Pooler
	PoolMax int
	PoolTTL time.Duration
	// Alerts is the injector's alert feed: an exfiltration alert makes its
	// claim a blocker and stops it (watchAlerts).
	Alerts AlertSource
	// ServiceLogs reads a claim's service logs in a probe round's window;
	// Outbound its egress there (evidence.go). EvidenceHTTP is the client
	// artifacts are uploaded with (nil: a plain one, 30 s).
	ServiceLogs  driver.ServiceLogReader
	Outbound     evidence.OutboundSource
	EvidenceHTTP *http.Client
	// Browser starts the browser runner per probe round (ADR-071,
	// browser.go); nil: a browser probe goes to the observer, which refuses
	// it with browser_unavailable.
	Browser browser.Runner
	// BrowserExplore is explicit and opt-in: only a preflight-verified native
	// explorer image may advertise this distinct, non-verdict capability.
	BrowserExplore browser.Runner

	// MemoryAllocatableMB is what the cell may commit to claims (its host
	// memory less a reserve), for a driver whose claims share it
	// (driver.MemoryBudget): a claim is taken only when it fits (ADR-070).
	// Zero, or a driver without a budget: no memory admission, free slots
	// alone, as before.
	MemoryAllocatableMB int
	// RequireMemoryAdmission refuses startup without a usable shared-host
	// budget and enforces capacity even when an older hub lacks cellMemory.
	// Required aggregate resource enforcement enables this explicitly.
	RequireMemoryAdmission bool

	WorkDir      string
	InitialLease time.Duration // until the first claim.renew
	WorkloadSize driver.MachineSize
	ObserverSize driver.MachineSize
	// ExecLimits are the rlimits kody-exec puts on every exec (S-09, a
	// second lock under the VM's own limits); zero fields are unset.
	ExecLimits kodyexec.Limits
	// ExecGrace is how long past the step's timeoutMs the cell waits for
	// kody-exec before it calls the VM unreachable (default 30 s).
	ExecGrace time.Duration
	// ReleaseWait bounds how long a release waits for a claim still being
	// prepared to stop (default 2 min); then it tears down what exists.
	ReleaseWait time.Duration

	// DevAllowInsecureIsolation lets a developer cell run a driver with
	// isolation "none" (plain containers: local-docker, the fake driver).
	// cmd/cell sets it only behind that driver's own gate. Never set in
	// production.
	DevAllowInsecureIsolation bool

	// SettleAttempts bounds how many times a claim frame (claim.ready,
	// claim.failed, step.result) is sent until the hub acks it (default 6);
	// SettleBackoff is the first wait between attempts, doubling up to 30 s
	// (default 1 s). A nack ends the retries.
	SettleAttempts int
	SettleBackoff  time.Duration

	Clock   clock.Clock
	Log     *slog.Logger
	NewID   func() string
	Metrics *metrics.Registry
}

type Agent struct {
	cfg     Config
	clock   clock.Clock
	log     *slog.Logger
	leases  *lease.Manager
	deadman *lease.DeadMan
	steps   *dedup.Store
	claims  *claims.Registry
	outbox  *outbox.Outbox
	m       agentMetrics
	wg      sync.WaitGroup

	// mu guards the hub session only: conn, version, accepts and runCtx.
	// Every other part keeps its own state behind its own lock.
	mu      sync.Mutex
	conn    hubclient.Sender
	version int64
	// accepts are the optional fields the hub's hello ack accepts from this
	// cell (protocol.Accepted); none while there is no session.
	accepts map[string]bool
	// runCtx ends when Run returns: retries and background work stop
	// instead of holding Wait.
	runCtx context.Context

	// origin is what the cell knows of where its machines and images came
	// from (S-52): tainted machines, the images it baked, the bakes in
	// progress (its own lock).
	origin *provenance.Record
	// evidence captures what a step leaves: logs, egress, the cast.
	evidence *evidence.Collector
	// pool keeps the warm pools pool.target asked for (its own lock).
	pool *pool.Manager

	// mem is the memory admission (memory.go), nil without one; budget is
	// the driver's count of a claim.
	mem    *admission.Ledger
	budget driver.MemoryBudget
	// beat asks the session for a heartbeat now (nudgeHeartbeat).
	beat         chan struct{}
	sourceHealth alertSourceHealth
}

type agentMetrics struct {
	claims               *metrics.Vec
	claimsReaped         *metrics.Vec
	steps                *metrics.Vec
	browserExplorations  *metrics.Vec
	stepConflicts        *metrics.Vec
	bakes                *metrics.Vec
	cleanupsFailed       *metrics.Vec
	alerts               *metrics.Vec
	alertSourceAvailable *metrics.Vec
	alertSourceFailures  *metrics.Vec
	pool                 *metrics.Vec
	sqlObservers         *metrics.Vec
	sqlObserverDuration  *metrics.Vec
}

const (
	DefaultMaxClaimSteps = 4
	MaxClaimStepsLimit   = 64
)

func New(cfg Config) (*Agent, error) {
	if cfg.CellID == "" || cfg.Driver == nil || cfg.Transport == nil || cfg.Observers == nil {
		return nil, errors.New("agent: cell id, driver, transport and observers required")
	}
	if cfg.Repo == nil || cfg.Extractor == nil || cfg.Revoker == nil || cfg.OrgKey == nil {
		return nil, errors.New("agent: repo source, extractor, revoker and org key required")
	}
	if cfg.RequireMemoryAdmission {
		budget, ok := driver.MemoryBudgetOf(cfg.Driver)
		if !ok || cfg.MemoryAllocatableMB <= 0 {
			return nil, fmt.Errorf("%w: agent requires a shared memory budget and positive allocatable memory", driver.ErrResourceEnforcement)
		}
		mem := budget.ClaimMemory(driver.ClaimSize{})
		if mem.BootMB <= 0 || mem.ReadyMB <= 0 || mem.ReadyMB > mem.BootMB || mem.BootMB > maxReportedMemoryMB {
			return nil, fmt.Errorf("%w: agent requires a usable boot/ready memory budget", driver.ErrResourceEnforcement)
		}
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if iso := cfg.Driver.Capabilities().Isolation; !driver.ProductionIsolation(iso) {
		if !cfg.DevAllowInsecureIsolation || iso != driver.IsolationNone {
			return nil, fmt.Errorf("agent: isolation %q is not allowed (ADR-027)", iso)
		}
		cfg.Log.Warn("INSECURE ISOLATION: workloads run with isolation \"none\"; development only, never production (ADR-027)",
			"isolation", iso, "driver", cfg.Driver.Kind())
	}
	cfg.Clock = clock.Or(cfg.Clock)
	if cfg.NewID == nil {
		cfg.NewID = hubclient.NewID
	}
	if cfg.Owner == "" {
		cfg.Owner = protocol.CellOwnerKodus
	}
	if cfg.MaxClaims == 0 {
		cfg.MaxClaims = 20
	}
	if cfg.MaxClaimSteps == 0 {
		cfg.MaxClaimSteps = DefaultMaxClaimSteps
	}
	if cfg.MaxClaimSteps < 1 || cfg.MaxClaimSteps > MaxClaimStepsLimit {
		return nil, fmt.Errorf("agent: max claim steps must be 1..%d", MaxClaimStepsLimit)
	}
	if cfg.PoolMax == 0 {
		cfg.PoolMax = pool.DefaultMax
	}
	if cfg.PoolTTL == 0 {
		cfg.PoolTTL = pool.DefaultTTL
	}
	if cfg.InitialLease == 0 {
		cfg.InitialLease = 5 * time.Minute
	}
	if cfg.ExecGrace == 0 {
		cfg.ExecGrace = 30 * time.Second
	}
	if cfg.ReleaseWait == 0 {
		cfg.ReleaseWait = 2 * time.Minute
	}
	if cfg.WorkloadSize.CPU == 0 {
		cfg.WorkloadSize = driver.MachineSize{CPU: 4, MemoryGB: 16, DiskGB: 60}
	}
	if cfg.ObserverSize.CPU == 0 {
		cfg.ObserverSize = driver.MachineSize{CPU: 2, MemoryGB: 4, DiskGB: 20}
	}
	if cfg.WorkDir == "" {
		cfg.WorkDir = os.TempDir()
	}
	now := cfg.Clock.Now
	leases := lease.NewManager(cfg.CellID, cfg.Driver, now, cfg.Log)
	a := &Agent{
		cfg:     cfg,
		clock:   cfg.Clock,
		log:     cfg.Log.With("cell", cfg.CellID),
		leases:  leases,
		deadman: lease.NewDeadMan(leases, now, cfg.Log),
		steps:   dedup.NewStore(dedup.DefaultTTL, now),
		claims:  claims.NewRegistry(cfg.MaxClaims),
		origin:  provenance.New(),
		runCtx:  context.Background(),
		beat:    make(chan struct{}, 1),
		m: agentMetrics{
			claims:               cfg.Metrics.Gauge("cell_claims", "Claims the cell holds, by state.", "state"),
			claimsReaped:         cfg.Metrics.Counter("cell_claims_reaped_total", "Claims the cell tore down without a claim.release, by reason.", "reason"),
			steps:                cfg.Metrics.Counter("cell_steps_total", "Steps run, by kind and outcome.", "kind", "outcome"),
			browserExplorations:  cfg.Metrics.Counter("cell_browser_explorations_total", "Browser exploration completions, by observed, blocked, timeout, unavailable or failed outcome; cancelled steps are excluded.", "outcome"),
			stepConflicts:        cfg.Metrics.Counter("cell_step_conflicts_total", "Steps refused because their stepId was seen with another command (S-30)."),
			bakes:                cfg.Metrics.Counter("cell_image_bakes_total", "Image bakes, by outcome.", "outcome"),
			cleanupsFailed:       cfg.Metrics.Counter("cell_claim_cleanup_errors_total", "Errors tearing a claim down (machines, network, egress policy)."),
			alerts:               cfg.Metrics.Counter("cell_exfiltration_alerts_total", "Injector alerts: a claim's credential or bait left for a host it was not for.", "kind"),
			alertSourceAvailable: cfg.Metrics.Gauge("cell_alert_source_available", "Whether the configured alert source has verified continuity; zero until negotiated or while unavailable."),
			alertSourceFailures:  cfg.Metrics.Counter("cell_alert_source_failures_total", "Alert source failures, by closed continuity or availability reason.", "reason"),
			pool:                 cfg.Metrics.Counter("cell_pool_machines_total", "Warm pool machines, by outcome: created, failed, adopted, discarded.", "outcome"),
			sqlObservers:         cfg.Metrics.Counter("cell_sql_observer_provisions_total", "Managed SQL observer provisioning attempts, by closed outcome.", "outcome"),
			sqlObserverDuration:  cfg.Metrics.Counter("cell_sql_observer_provision_duration_ms_total", "Cumulative managed SQL observer provisioning time in milliseconds."),
		},
	}
	a.evidence = &evidence.Collector{ServiceLogs: cfg.ServiceLogs, Outbound: cfg.Outbound, HTTP: cfg.EvidenceHTTP, Clock: cfg.Clock, Accepts: a.hubAccepts}
	a.pool = pool.New(pool.Config{
		CellID: cfg.CellID, Pooler: cfg.Pooler, Machines: cfg.Driver, OrgKey: cfg.OrgKey,
		WorkloadSize: cfg.WorkloadSize, Max: cfg.PoolMax, TTL: cfg.PoolTTL,
		Accepting: a.acceptingWork, Go: a.goTracked, Clock: cfg.Clock, Log: a.log, Outcomes: a.m.pool,
	})
	if cfg.BakeCatalog != nil {
		startup := cfg.RecoveryContext
		if startup == nil {
			startup = context.Background()
		}
		ctx, cancel := context.WithTimeout(startup, 30*time.Second)
		recovered, err := cfg.BakeCatalog.RecoverBakes(ctx)
		cancel()
		if err != nil {
			return nil, fmt.Errorf("agent: bake recovery: %w", err)
		}
		for _, image := range recovered {
			a.origin.Add(image.ImageID, provenance.Image{OrgID: image.OrgID, EnvironmentID: image.EnvironmentID, SHA: image.SHA}, image.Current)
		}
	}
	// No source-health series for a cell without an injector alert source.
	if cfg.Alerts != nil {
		a.m.alertSourceAvailable.Set(0)
	}
	if b, ok := driver.MemoryBudgetOf(cfg.Driver); ok && cfg.MemoryAllocatableMB > 0 {
		a.mem, a.budget = admission.New(cfg.MemoryAllocatableMB), b
		cfg.Metrics.GaugeFunc("cell_memory_committed_mb", "Memory the cell's claims are counted for (ADR-070), in MB.", func() float64 { return float64(a.mem.Committed()) })
		cfg.Metrics.GaugeFunc("cell_memory_allocatable_mb", "Memory the cell may commit to claims (ADR-070), in MB.", func() float64 { return float64(a.mem.Allocatable()) })
	}
	a.outbox = outbox.New(outbox.Config{
		Conn: a.currentConn, Attempts: cfg.SettleAttempts, Backoff: cfg.SettleBackoff,
		Clock: cfg.Clock, NewID: cfg.NewID, Metrics: cfg.Metrics,
	})
	cfg.Metrics.GaugeFunc("cell_deadman_state", "Dead-man state: 0 healthy, 1 lost (no new work), 2 abandoned (every machine destroyed).",
		func() float64 { return float64(a.deadman.State()) })
	cfg.Metrics.GaugeFunc("cell_pool_ready", "Warm pool machines ready, every environment.", func() float64 { return float64(a.pool.Ready()) })
	cfg.Metrics.GaugeFunc("cell_free_slots", "Claims the cell can still take.", func() float64 { return float64(a.claims.Free()) })
	a.observeClaims()
	return a, nil
}

func (a *Agent) Leases() *lease.Manager  { return a.leases }
func (a *Agent) DeadMan() *lease.DeadMan { return a.deadman }

// Version is the protocol version the hub chose in its hello ack, or 0
// while there is no session.
func (a *Agent) Version() int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.version
}

// hubAccepts reports whether this session's hub accepts the optional field
// of feature: an older hub, or no session, accepts none.
func (a *Agent) hubAccepts(feature string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.accepts[feature]
}

func (a *Agent) currentConn() hubclient.Sender {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.conn
}

func (a *Agent) runContext() context.Context {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.runCtx
}

// goTracked runs f in a goroutine Wait waits for, with the Run context.
func (a *Agent) goTracked(f func(ctx context.Context)) {
	ctx := a.runContext()
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		f(ctx)
	}()
}

// Wait blocks until background work finishes (tests, and Run's end).
func (a *Agent) Wait() { a.wg.Wait() }

func nack(code, format string, args ...any) error {
	return &hubclient.NackError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// observeClaims refreshes the claims gauge.
func (a *Agent) observeClaims() {
	counts := a.claims.CountByState()
	for _, s := range claims.States {
		a.m.claims.Set(float64(counts[s]), s.String())
	}
}

// Hello is the first frame: versions, driver, isolation, regions, owner,
// and what the hub may ask of this cell: the optional claim.acquire fields
// it decodes and the largest size its driver grants one claim (the hub
// sends a sized claim only to a cell whose maximum fits it).
func (a *Agent) Hello() *protocol.HelloBody {
	caps := a.cfg.Driver.Capabilities()
	regions := a.cfg.Regions
	if regions == nil {
		regions = []string{}
	}
	features := protocol.Features()
	kept := features[:0]
	for _, feature := range features {
		if feature == protocol.FeatureBrowserExplore && a.cfg.BrowserExplore == nil {
			continue
		}
		if feature == protocol.FeatureRecipeFakes && !a.cfg.FakeSupport {
			continue
		}
		if feature == protocol.FeatureSeededSQL && a.cfg.SQLObservers == nil {
			continue
		}
		kept = append(kept, feature)
	}
	features = kept

	return &protocol.HelloBody{
		Versions:     protocol.SupportedVersions(),
		Driver:       a.cfg.Driver.Kind(),
		Isolation:    protocol.Isolation(caps.Isolation),
		Regions:      regions,
		Owner:        a.cfg.Owner,
		Features:     features,
		MaxClaimSize: protocol.MaxClaimSize(int64(caps.MaxClaimSize.MemoryMB), int64(caps.MaxClaimSize.CPUs)),
	}
}

func (a *Agent) Heartbeat() *protocol.HeartbeatBody {
	hb := &protocol.HeartbeatBody{Claims: []protocol.HeartbeatClaim{}}
	for _, c := range a.claims.All() {
		l, _ := a.leases.Get(c.ID)
		hb.Claims = append(hb.Claims, protocol.HeartbeatClaim{ClaimID: c.ID, Machines: int64(len(l.Machines))})
	}
	if a.acceptingWork() {
		hb.FreeSlots = int64(a.claims.Free())
	}
	// Only to a hub that accepts it: an older hub's strict decoder refuses the field.
	if a.hubAccepts(protocol.FeatureCellMemory) {
		hb.Memory = a.memoryReport()
	}
	return hb
}

// info is the ClaimInfo of c as it stands.
func info(c *claims.Claim) ClaimInfo {
	m := c.Machines()
	return ClaimInfo{ClaimID: c.ID, ObserverGeneration: c.ObserverGeneration(), Acquire: c.Acquire, Workload: m.Workload, Observer: m.Observer, Network: m.Network, Sources: m.Sources, GoPins: m.GoPins, ImagePins: m.ImagePins}
}
