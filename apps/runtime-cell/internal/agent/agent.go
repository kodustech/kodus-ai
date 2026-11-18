// Package agent is the cell agent (apps/runtime-cell/README.md): it holds the
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
	"fmt"
	"log/slog"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/admission"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/coverage"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/evidence"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/outbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/pool"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/provenance"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dedup"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type Agent struct {
	// established counts the sessions the hub accepted (Run resets its
	// reconnect backoff when one did).
	established atomic.Int64
	// trimHello asks the next hello to fit an older hub's 32 features: set
	// when a hub refused a longer hello's body, cleared by the next one.
	trimHello atomic.Bool
	cfg       Config
	clock     clock.Clock
	log       *slog.Logger
	leases    *lease.Manager
	deadman   *lease.DeadMan
	steps     *dedup.Store
	claims    *claims.Registry
	outbox    *outbox.Outbox
	m         agentMetrics
	wg        sync.WaitGroup

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
	coverage *coverage.Counter
	// disk is the watchdog's last look at what each claim holds on
	// Docker's disk, under the margin (disk_watch.go).
	disk diskLooks
	// pool keeps the warm pools pool.target asked for (its own lock).
	pool *pool.Manager

	// mem is the memory admission (memory.go), nil without one; budget is
	// the driver's count of a claim.
	mem    *admission.Ledger
	budget driver.MemoryBudget
	// beat asks the session for a heartbeat now (nudgeHeartbeat).
	beat         chan struct{}
	sourceHealth alertSourceHealth
	// alertSources are the alert feeds watched (alertSources).
	alertSources []AlertSource

	// guests are the sandbox claims' streams to their guest agents
	// (sandbox.go); sandboxPool the blank sandboxes (sandbox_pool.go), nil
	// without one.
	guests      guests
	sandboxPool *sandboxPool
}

const (
	DefaultMaxClaimSteps = 4
	MaxClaimStepsLimit   = 64
)

func New(cfg Config) (*Agent, error) {
	if err := cfg.complete(); err != nil {
		return nil, err
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
		m:       newAgentMetrics(cfg.Metrics),
	}
	a.coverage = &coverage.Counter{Flusher: cfg.Parts.Coverage, Clock: cfg.Clock}
	a.recoverCoverageCaps()
	a.evidence = &evidence.Collector{ServiceLogs: cfg.Parts.ServiceLogs, Outbound: cfg.Outbound, HTTP: cfg.EvidenceHTTP, Clock: cfg.Clock, Accepts: a.hubAccepts}
	a.pool = pool.New(pool.Config{
		CellID: cfg.CellID, Pooler: cfg.Parts.Pooler, Machines: cfg.Driver, OrgKey: cfg.OrgKey,
		WorkloadSize: cfg.WorkloadSize, Max: cfg.PoolMax, TTL: cfg.PoolTTL,
		Accepting: a.acceptingWork, Go: a.goTracked, Clock: cfg.Clock, Log: a.log, Outcomes: a.m.pool,
	})
	if err := a.recoverBakes(); err != nil {
		return nil, err
	}
	if h := cfg.Host; h != nil {
		// What the KVM host is, for the alert on a shared host and the fleet's view.
		g := cfg.Metrics.Gauge("cell_host_hardening", "The KVM host's SMT, KSM and swap (1 on the state found) and its unmitigated CPU vulnerabilities, by policy.", "policy", "check", "state")
		for check, state := range map[string]string{"smt": string(h.Smt), "ksm": string(h.Ksm), "swap": string(h.Swap)} {
			g.Set(1, string(h.Policy), check, state)
		}
		g.Set(float64(len(h.Vulnerable)), string(h.Policy), "vulnerable", "count")
	}
	// No source-health series for a cell without an alert source.
	a.alertSources = alertSources(cfg)
	a.sourceHealth.ready = make([]bool, len(a.alertSources))
	if len(a.alertSources) > 0 {
		a.m.alertSourceAvailable.Set(0)
	}
	if cfg.Parts.Memory != nil && cfg.MemoryAllocatableMB > 0 {
		a.mem, a.budget = admission.New(cfg.MemoryAllocatableMB), cfg.Parts.Memory
	}
	a.outbox = outbox.New(outbox.Config{
		Conn: a.currentConn, Attempts: cfg.SettleAttempts, Backoff: cfg.SettleBackoff,
		Clock: cfg.Clock, NewID: cfg.NewID, Metrics: cfg.Metrics,
	})
	if cfg.Parts.Sandboxes != nil && cfg.SandboxPool > 0 {
		a.sandboxPool = &sandboxPool{
			Target: cfg.SandboxPool, CellID: cfg.CellID, Driver: cfg.Driver, Sandboxes: cfg.Parts.Sandboxes, OrgKey: cfg.OrgKey,
			Size: cfg.WorkloadSize, ClaimSize: cfg.SandboxSize, Clock: cfg.Clock, Log: a.log, Accepting: a.acceptingWork, dial: a.dialGuest,
		}
		if a.mem != nil {
			// A blank sandbox holds its machine's memory, at the figure the
			// claim that takes it is counted at (sandboxMemoryMB), in the
			// same ledger the claims are admitted from.
			a.sandboxPool.Mem, a.sandboxPool.MemMB = a.mem, a.sandboxMemoryMB(cfg.SandboxSize)
		}
	}
	a.registerGauges()
	a.observeClaims()
	return a, nil
}

// recoverBakes restores which images this cell baked, from the driver's
// catalog. Eligibility only: no claim, pool machine or lease comes back.
func (a *Agent) recoverBakes() error {
	if a.cfg.Parts.BakeCatalog == nil {
		return nil
	}
	startup := a.cfg.RecoveryContext
	if startup == nil {
		startup = context.Background()
	}
	ctx, cancel := context.WithTimeout(startup, 30*time.Second)
	recovered, err := a.cfg.Parts.BakeCatalog.RecoverBakes(ctx)
	cancel()
	if err != nil {
		return fmt.Errorf("agent: bake recovery: %w", err)
	}
	for _, image := range recovered {
		a.origin.Add(image.ImageID, provenance.Image{OrgID: image.OrgID, EnvironmentID: image.EnvironmentID, SHA: image.SHA}, image.Current)
	}
	return nil
}

// registerGauges exposes what the agent holds now.
func (a *Agent) registerGauges() {
	reg := a.cfg.Metrics
	if a.mem != nil {
		reg.GaugeFunc("cell_memory_committed_mb", "Memory the cell's claims are counted for (ADR-070), in MB.", func() float64 { return float64(a.mem.Committed()) })
		reg.GaugeFunc("cell_memory_allocatable_mb", "Memory the cell may commit to claims (ADR-070), in MB.", func() float64 { return float64(a.mem.Allocatable()) })
	}
	reg.GaugeFunc("cell_deadman_state", "Dead-man state: 0 healthy, 1 lost (no new work), 2 abandoned (every machine destroyed).",
		func() float64 { return float64(a.deadman.State()) })
	reg.GaugeFunc("cell_pool_ready", "Warm pool machines ready, every environment.", func() float64 { return float64(a.pool.Ready()) })
	reg.GaugeFunc("cell_free_slots", "Claims the cell can still take.", func() float64 { return float64(a.claims.Free()) })
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
//
//nolint:contextcheck,nolintlint // background work outlives the frame that started it: it runs under the Run context on purpose (contextcheck reports at the callers, so nolintlint sees the directive as unused)
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

// trimForOlderHub keeps the oldest features of the hello, at most limit of
// them. Features are named in CELL_FEATURES order, newest last, and a hub
// older than the 64 limit knew none past the 32nd (exercisedLines,
// bakeShare and any added after them), so dropping from the end loses only
// what such a hub would never read, and the hello always fits.
func trimForOlderHub(features []string, limit int) []string {
	if len(features) <= limit {
		return features
	}
	return slices.Clone(features[:limit])
}

// olderHubFeatureLimit is protocol.MaxHelloFeaturesOlderHub, a variable so
// a test can reach it with the harness's fewer features.
var olderHubFeatureLimit = protocol.MaxHelloFeaturesOlderHub

// Hello is the first frame: versions, driver, isolation, regions, owner,
// and what the hub may ask of this cell: the optional claim.acquire fields
// it decodes and the largest size its driver grants one claim (the hub
// sends a sized claim only to a cell whose maximum fits it).
func (a *Agent) Hello() *protocol.HelloBody { return a.hello(false) }

// hello is Hello, cut to an older hub's 32 features when trim is set.
func (a *Agent) hello(trim bool) *protocol.HelloBody {
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
		if feature == protocol.FeatureExercisedLines && !a.cfg.ExercisedLines {
			continue
		}
		if feature == protocol.FeatureRecipeFakes && !a.cfg.FakeSupport {
			continue
		}
		if feature == protocol.FeatureSeededSQL && a.cfg.Parts.SQLObservers == nil {
			continue
		}
		// claim.acquire repos are laid out only where the driver's sandbox
		// keeps the project inside the workspace (laysOutWorkspaces).
		if feature == protocol.FeatureWorkspace && !a.laysOutWorkspaces() {
			continue
		}
		if feature == protocol.FeatureSnapshots && a.cfg.Parts.Snapshots == nil {
			continue // the hub sends no snapshot field to a cell that keeps none
		}
		if feature == protocol.FeatureSnapshotForget && a.cfg.Parts.Sessions == nil {
			continue
		}
		if feature == protocol.FeatureHostHardening && a.cfg.Host == nil {
			continue
		}
		if feature == protocol.FeatureCellProtocols && a.cfg.HubProtocolState == "" {
			continue // the range is kept only for cell update, on a host that keeps it
		}
		if feature == protocol.FeatureSandbox && a.cfg.Parts.Sandboxes == nil {
			continue
		}
		if (feature == protocol.FeatureBuildStateEvicted || feature == protocol.FeatureBuildStateRebuildCost) && a.cfg.Parts.BuildStates == nil {
			continue
		}
		if feature == protocol.FeaturePreview && a.cfg.Preview == nil {
			continue
		}
		// Only a driver with the org's registry pushes and pulls baked images.
		if feature == protocol.FeatureBakeShare && !caps.ShareBakes {
			continue
		}
		// A placeholder is worth something only where an injector swaps it:
		// a cell that pushes no egress policy takes no secrets.
		if (feature == protocol.FeatureSecrets || feature == protocol.FeatureEgressTiers) && a.cfg.Egress == nil {
			continue
		}
		kept = append(kept, feature)
	}
	features = kept
	// A hub before the 64 limit refuses a hello of more than 32 features.
	// After such a refusal (session.go) the next hello is trimmed to fit it.
	if trim {
		features = trimForOlderHub(features, olderHubFeatureLimit)
	}

	return &protocol.HelloBody{
		Versions:     protocol.SupportedVersions(),
		Driver:       a.cfg.Driver.Kind(),
		Isolation:    protocol.Isolation(caps.Isolation),
		Regions:      regions,
		Owner:        a.cfg.Owner,
		Features:     features,
		MaxClaimSize: protocol.MaxClaimSize(int64(caps.MaxClaimSize.MemoryMB), int64(caps.MaxClaimSize.CPUs)),
		Capabilities: a.helloCapabilities(caps, a.cfg.Parts),
	}
}

// helloCapabilities is what the cell's machines can be
// (docs/runtime/isolation-architecture.md C2): the driver's backends, memory
// snapshots, nested containers, the host's KVM and arch, the largest size,
// the default one and a code sandbox's (only on a cell that runs them). Nil
// on an architecture the protocol does not name.
func (a *Agent) helloCapabilities(caps driver.Capabilities, parts driver.Parts) *protocol.HelloCapabilities {
	arch := caps.HostArch
	if arch == "" {
		arch = isolation.ArchOf(runtime.GOARCH)
	}
	if arch == "" {
		return nil
	}
	backends := append([]string{}, caps.Backends...)
	return &protocol.HelloCapabilities{
		Backends: backends, SnapshotMemory: parts.SnapshotsMemory(), NestedDocker: caps.NestedContainers, Kvm: caps.KVM,
		Arch: protocol.MachineArch(arch), MaxSize: protocol.MaxClaimSize(int64(caps.MaxClaimSize.MemoryMB), int64(caps.MaxClaimSize.CPUs)),
		DefaultSize: protocol.MaxClaimSize(int64(caps.DefaultClaimSize.MemoryMB), int64(caps.DefaultClaimSize.CPUs)),
		SandboxSize: a.helloSandboxSize(),
	}
}

// helloSandboxSize is hello capabilities.sandboxSize: nil on a cell that runs
// no sandboxes or has no sandbox size of its own (the hub then counts a
// sandbox at its own default, RUNTIME_SANDBOX_MEMORY_MB).
func (a *Agent) helloSandboxSize() *protocol.MachineSize {
	if a.cfg.Parts.Sandboxes == nil || a.cfg.SandboxSize.IsZero() {
		return nil
	}
	return protocol.MaxClaimSize(int64(a.cfg.SandboxSize.MemoryMB), int64(a.cfg.SandboxSize.CPUs))
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
	if a.cfg.Parts.BuildStates != nil && a.hubAccepts(protocol.FeatureBuildStateEvicted) {
		hb.EvictedBuildStates = evictedBuildStates(a.cfg.Parts.BuildStates.EvictedBuildStates(), a.hubAccepts(protocol.FeatureBuildStateRebuildCost))
	}
	if a.cfg.Host != nil && a.hubAccepts(protocol.FeatureHostHardening) {
		h := *a.cfg.Host
		hb.Host = &h
	}
	return hb
}

// evictedBuildStates is the driver's ledger as heartbeat evictedBuildStates:
// ids the schema takes only (an id past its bound is left out), at most the
// schema's count. withCost adds each state's rebuild seconds, when measured
// (a hub that accepts buildStateRebuildCost).
func evictedBuildStates(ev []driver.EvictedBuildState, withCost bool) []protocol.HeartbeatBodyEvictedBuildStatesItem {
	var out []protocol.HeartbeatBodyEvictedBuildStatesItem
	for _, e := range ev {
		if len(out) == maxEvictedBuildStates {
			break
		}
		if e.Org == "" || e.Env == "" || len(e.Org) > 128 || len(e.Env) > 128 {
			continue
		}
		item := protocol.HeartbeatBodyEvictedBuildStatesItem{OrgID: e.Org, EnvironmentID: e.Env, EvictedAt: protocol.FormatTime(e.At)}
		if secs := int64(e.Rebuild / time.Second); withCost && secs >= 1 {
			secs = min(secs, maxRebuildSeconds)
			item.RebuildSeconds = &secs
		}
		out = append(out, item)
	}
	return out
}

// maxEvictedBuildStates is MAX_EVICTED_BUILD_STATES of the schema.
const maxEvictedBuildStates = 64

// maxRebuildSeconds is evictedBuildStates[].rebuildSeconds' bound in the schema: a week.
const maxRebuildSeconds = 604_800

// info is the ClaimInfo of c as it stands.
func info(c *claims.Claim) ClaimInfo {
	m := c.Machines()
	return ClaimInfo{ClaimID: c.ID, ObserverGeneration: c.ObserverGeneration(), Acquire: c.Acquire, Workload: m.Workload, Observer: m.Observer, Network: m.Network, Sources: m.Sources, GoPins: m.GoPins, ImagePins: m.ImagePins, OrgSecrets: policySecrets(c), CellTrusted: c.CellTrusted(), Running: c.Running()}
}
