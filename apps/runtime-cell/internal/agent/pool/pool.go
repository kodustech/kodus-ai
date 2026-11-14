// Package pool is the cell's warm pool (S-52): pool.target asks the cell to
// keep `size` clean machines ready for an environment, made from the
// environment's bake. A claim of that environment adopts one instead of
// making its own, and destroys it on release like any other: a pool machine
// is used once and never goes back. A new bake of the environment replaces
// the pool's machines with machines of the new image; a new machine size
// (pool.target machineSize) replaces them with machines of the new size.
//
// The Manager owns the targets and the ready machines, behind its own lock.
// It makes machines through the driver's Pooler and knows no claim: the
// agent asks it for a machine and adopts what it hands out.
package pool

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

const (
	// DefaultMax bounds the machines one environment keeps ready.
	DefaultMax = 4
	// DefaultTTL is how long a pool machine waits for a claim; its
	// ceiling bounds every claim that adopts it.
	DefaultTTL = 4 * time.Hour
)

// Machines destroys what the pool made and no claim will take.
type Machines interface {
	Destroy(ctx context.Context, ref driver.MachineRef) error
	ReleaseClaim(ctx context.Context, network driver.ClaimNetwork) error
}

// Config is what New needs. Pooler nil is a cell that keeps no pool: every
// target is recorded and nothing is ever made or handed out.
type Config struct {
	CellID string
	Pooler driver.Pooler
	// Machines destroys a pool machine no claim will take.
	Machines Machines
	OrgKey   func(orgID string) (string, error)
	// WorkloadSize is the machine a pool machine is made as; Max bounds one
	// environment's pool and TTL how long a pool machine waits.
	WorkloadSize driver.MachineSize
	Max          int
	TTL          time.Duration
	// Accepting is false while the cell takes no new work: nothing is made.
	Accepting func() bool
	// Go runs background work the cell waits for at shutdown.
	Go    func(func(ctx context.Context))
	Clock clock.Clock
	Log   *slog.Logger
	// Outcomes counts pool machines by outcome: created, failed, discarded.
	Outcomes *metrics.Vec
}

// Request is the claim asking for a ready machine.
type Request struct {
	OrgID, EnvironmentID string
	// ImageID is the image the claim asks for; "" is the environment's
	// current one.
	ImageID string
	// Setup is a setup claim: it boots the default branch from nothing and
	// never starts from a pool machine, which holds the previous bake's data.
	Setup bool
	// Size is the machine size the claim asks; a machine of another size
	// would give the claim more or less than its environment pays for.
	Size driver.ClaimSize
	// HardExpiresAt is the claim's ceiling: the machine's is no earlier.
	HardExpiresAt time.Time
}

// Target is one environment's pool as it stands.
type Target struct {
	ImageID string
	Size    int
	Ready   []driver.PoolMachine
}

type key struct{ orgID, environmentID string }

// envPool is one environment's target and the machines it holds.
type envPool struct {
	imageID string
	// claimSize is the environment's machine size: what a claim of it asks,
	// so what its pool machines are made at (zero: the cell's default).
	claimSize driver.ClaimSize
	size      int
	ready     []driver.PoolMachine
	filling   int
}

// Manager keeps every environment's pool.
type Manager struct {
	cfg   Config
	mu    sync.Mutex
	pools map[key]*envPool
}

func New(cfg Config) *Manager {
	cfg.Clock = clock.Or(cfg.Clock)
	return &Manager{cfg: cfg, pools: map[key]*envPool{}}
}

// SetTarget records the target and fills or drains toward it.
func (mg *Manager) SetTarget(b protocol.PoolTargetBody) {
	size := int(b.Size)
	if size > mg.cfg.Max {
		mg.cfg.Log.Warn("pool.target.clamped", "env", b.EnvironmentID, "asked", size, "max", mg.cfg.Max)
		size = mg.cfg.Max
	}
	if size < 0 {
		size = 0
	}
	k := key{b.OrgID, b.EnvironmentID}
	mg.mu.Lock()
	p := mg.pools[k]
	if p == nil {
		p = &envPool{}
		mg.pools[k] = p
	}
	p.imageID, p.size, p.claimSize = b.ImageID, size, ClaimSize(b)
	mg.mu.Unlock()
	mg.cfg.Log.Info("pool.target", "env", b.EnvironmentID, "image", b.ImageID, "size", size, "machineSize", p.claimSize.String())
	mg.refill(k)
}

// ClaimSize is the machine size pool.target asks; zero is the default.
func ClaimSize(b protocol.PoolTargetBody) driver.ClaimSize {
	if b.MachineSize == nil {
		return driver.ClaimSize{}
	}
	return driver.ClaimSize{MemoryMB: int(b.MachineSize.MemoryMb), CPUs: int(b.MachineSize.Cpus)}
}

// FollowBake moves an environment's pool to the image just baked.
func (mg *Manager) FollowBake(orgID, environmentID, imageID string) {
	k := key{orgID, environmentID}
	mg.mu.Lock()
	p := mg.pools[k]
	if p != nil {
		p.imageID = imageID
	}
	mg.mu.Unlock()
	if p != nil {
		mg.refill(k)
	}
}

// RefillAll tops every pool up (housekeeping): a fill that failed is
// tried again here, never in a loop of its own.
func (mg *Manager) RefillAll() {
	mg.mu.Lock()
	keys := make([]key, 0, len(mg.pools))
	for k := range mg.pools {
		keys = append(keys, k)
	}
	mg.mu.Unlock()
	for _, k := range keys {
		mg.refill(k)
	}
}

// Refill tops the environment's pool up.
func (mg *Manager) Refill(orgID, environmentID string) { mg.refill(key{orgID, environmentID}) }

// refill drops the machines that no longer fit the target (another
// image or machine size, too close to their ceiling, past the size) and makes the missing
// ones in the background.
func (mg *Manager) refill(k key) {
	if mg.cfg.Pooler == nil || !mg.cfg.Accepting() {
		return
	}
	now := mg.cfg.Clock.Now()
	mg.mu.Lock()
	p := mg.pools[k]
	if p == nil {
		mg.mu.Unlock()
		return
	}
	var keep, drop []driver.PoolMachine
	for _, m := range p.ready {
		switch {
		case p.imageID == "", m.ImageID != p.imageID, m.ClaimSize != p.claimSize, m.HardExpiresAt.Sub(now) < mg.cfg.TTL/2, len(keep) >= p.size:
			drop = append(drop, m)
		default:
			keep = append(keep, m)
		}
	}
	p.ready = keep
	need := p.size - len(keep) - p.filling
	if p.imageID == "" {
		need = 0 // waiting for the environment's first bake
	}
	if need < 0 {
		need = 0
	}
	p.filling += need
	imageID, claimSize := p.imageID, p.claimSize
	mg.mu.Unlock()

	for _, m := range drop {
		mg.Discard(m, "stale")
	}
	key, err := mg.cfg.OrgKey(k.orgID)
	if err != nil && need > 0 {
		mg.mu.Lock()
		p.filling -= need
		mg.mu.Unlock()
		mg.cfg.Log.Error("pool.fill.failed", "env", k.environmentID, "reason", "org_key")
		return
	}
	for range need {
		mg.cfg.Go(func(ctx context.Context) {
			created := mg.cfg.Clock.Now()
			m, err := mg.cfg.Pooler.PoolCreate(ctx, driver.PoolSpec{
				CellID: mg.cfg.CellID, OrgID: k.orgID, EnvironmentID: k.environmentID, ImageID: imageID, KMSKeyRef: key,
				Size: mg.cfg.WorkloadSize, ClaimSize: claimSize, ExpiresAt: created.Add(mg.cfg.TTL), HardExpiresAt: created.Add(mg.cfg.TTL),
			})
			mg.mu.Lock()
			p.filling--
			// The driver says the size it made: one that made the default for a
			// sized pool made a machine no claim of the environment adopts.
			fits := err == nil && mg.pools[k] == p && p.imageID == m.ImageID && m.ClaimSize == p.claimSize && len(p.ready) < p.size
			if fits {
				p.ready = append(p.ready, m)
			}
			mg.mu.Unlock()
			switch {
			case err != nil:
				mg.cfg.Outcomes.Inc("failed")
				mg.cfg.Log.Error("pool.fill.failed", "env", k.environmentID, "err", err)
			case fits:
				mg.cfg.Outcomes.Inc("created")
				mg.cfg.Log.Info("pool.fill.done", "env", k.environmentID, "machine", m.Workload.MachineID, "ms", mg.cfg.Clock.Now().Sub(created).Milliseconds())
			default:
				// The target moved while it was being made.
				mg.Discard(m, "target_changed")
			}
		})
	}
}

// Take hands out a ready machine for the claim: same org and environment,
// the image the claim asks for, the size the claim asks, and a ceiling no
// earlier than the claim's.
func (mg *Manager) Take(r Request) (driver.PoolMachine, bool) { return mg.machine(r, true) }

// Has reports whether Take would find a machine for the claim now, taking
// none.
func (mg *Manager) Has(r Request) bool {
	_, ok := mg.machine(r, false)
	return ok
}

func (mg *Manager) machine(r Request, take bool) (driver.PoolMachine, bool) {
	if mg.cfg.Pooler == nil || r.Setup {
		return driver.PoolMachine{}, false
	}
	mg.mu.Lock()
	defer mg.mu.Unlock()
	p := mg.pools[key{r.OrgID, r.EnvironmentID}]
	if p == nil {
		return driver.PoolMachine{}, false
	}
	for i, m := range p.ready {
		image := r.ImageID == "" || r.ImageID == m.ImageID
		if m.OrgID == r.OrgID && m.EnvironmentID == r.EnvironmentID && image && m.ClaimSize == r.Size && !m.HardExpiresAt.Before(r.HardExpiresAt) {
			if take {
				p.ready = append(p.ready[:i:i], p.ready[i+1:]...)
			}
			return m, true
		}
	}
	return driver.PoolMachine{}, false
}

// Ready is how many machines are ready, every environment.
func (mg *Manager) Ready() int {
	mg.mu.Lock()
	defer mg.mu.Unlock()
	n := 0
	for _, p := range mg.pools {
		n += len(p.ready)
	}
	return n
}

// Environments is how many environments have a pool target.
func (mg *Manager) Environments() int {
	mg.mu.Lock()
	defer mg.mu.Unlock()
	return len(mg.pools)
}

// Target is the environment's pool as it stands; false when it has none.
func (mg *Manager) Target(orgID, environmentID string) (Target, bool) {
	mg.mu.Lock()
	defer mg.mu.Unlock()
	p := mg.pools[key{orgID, environmentID}]
	if p == nil {
		return Target{}, false
	}
	return Target{ImageID: p.imageID, Size: p.size, Ready: append([]driver.PoolMachine(nil), p.ready...)}, true
}

// Discard destroys a pool machine no claim will take.
func (mg *Manager) Discard(m driver.PoolMachine, reason string) {
	mg.cfg.Outcomes.Inc("discarded")
	mg.cfg.Go(func(ctx context.Context) {
		if err := mg.cfg.Machines.Destroy(ctx, m.Workload); err != nil {
			mg.cfg.Log.Warn("pool.discard.failed", "machine", m.Workload.MachineID, "err", err)
		}
		if err := mg.cfg.Machines.ReleaseClaim(ctx, m.Network); err != nil {
			mg.cfg.Log.Warn("pool.discard.failed", "machine", m.Workload.MachineID, "network", m.Network.WorkloadGroupID, "err", err)
		}
		mg.cfg.Log.Info("pool.discarded", "machine", m.Workload.MachineID, "reason", reason)
	})
}
