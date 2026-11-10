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
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/admission"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/evidence"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/outbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/pool"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/provenance"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dedup"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

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
	a.evidence = &evidence.Collector{ServiceLogs: cfg.ServiceLogs, Outbound: cfg.Outbound, HTTP: cfg.EvidenceHTTP, Clock: cfg.Clock, Accepts: a.hubAccepts}
	a.pool = pool.New(pool.Config{
		CellID: cfg.CellID, Pooler: cfg.Pooler, Machines: cfg.Driver, OrgKey: cfg.OrgKey,
		WorkloadSize: cfg.WorkloadSize, Max: cfg.PoolMax, TTL: cfg.PoolTTL,
		Accepting: a.acceptingWork, Go: a.goTracked, Clock: cfg.Clock, Log: a.log, Outcomes: a.m.pool,
	})
	if err := a.recoverBakes(); err != nil {
		return nil, err
	}
	// No source-health series for a cell without an injector alert source.
	if cfg.Alerts != nil {
		a.m.alertSourceAvailable.Set(0)
	}
	if b, ok := driver.MemoryBudgetOf(cfg.Driver); ok && cfg.MemoryAllocatableMB > 0 {
		a.mem, a.budget = admission.New(cfg.MemoryAllocatableMB), b
	}
	a.outbox = outbox.New(outbox.Config{
		Conn: a.currentConn, Attempts: cfg.SettleAttempts, Backoff: cfg.SettleBackoff,
		Clock: cfg.Clock, NewID: cfg.NewID, Metrics: cfg.Metrics,
	})
	a.registerGauges()
	a.observeClaims()
	return a, nil
}

// recoverBakes restores which images this cell baked, from the driver's
// catalog. Eligibility only: no claim, pool machine or lease comes back.
func (a *Agent) recoverBakes() error {
	if a.cfg.BakeCatalog == nil {
		return nil
	}
	startup := a.cfg.RecoveryContext
	if startup == nil {
		startup = context.Background()
	}
	ctx, cancel := context.WithTimeout(startup, 30*time.Second)
	recovered, err := a.cfg.BakeCatalog.RecoverBakes(ctx)
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
