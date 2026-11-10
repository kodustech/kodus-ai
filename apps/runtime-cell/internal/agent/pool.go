package agent

import (
	"context"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// The warm pool (S-52): pool.target asks the cell to keep `size` clean
// machines ready for an environment, made from the environment's bake. A
// claim of that environment adopts one instead of making its own, and
// destroys it on release like any other: a pool machine is used once and
// never goes back. A new bake of the environment replaces the pool's
// machines with machines of the new image; a new machine size (pool.target
// machineSize) replaces them with machines of the new size.

const (
	// defaultPoolMax bounds the machines one environment keeps ready.
	defaultPoolMax = 4
	// defaultPoolTTL is how long a pool machine waits for a claim; its
	// ceiling bounds every claim that adopts it.
	defaultPoolTTL = 4 * time.Hour
)

type poolKey struct{ orgID, environmentID string }

// latestImage in pool.target is the environment's last bake in this cell.
const latestImage = "latest"

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

// setPoolTarget records the target and fills or drains toward it.
func (a *Agent) setPoolTarget(b protocol.PoolTargetBody) {
	size := int(b.Size)
	if size > a.cfg.PoolMax {
		a.log.Warn("pool.target.clamped", "env", b.EnvironmentID, "asked", size, "max", a.cfg.PoolMax)
		size = a.cfg.PoolMax
	}
	if size < 0 {
		size = 0
	}
	k := poolKey{b.OrgID, b.EnvironmentID}
	a.mu.Lock()
	p := a.pools[k]
	if p == nil {
		p = &envPool{}
		a.pools[k] = p
	}
	p.imageID, p.size, p.claimSize = b.ImageID, size, poolClaimSize(b)
	a.mu.Unlock()
	a.log.Info("pool.target", "env", b.EnvironmentID, "image", b.ImageID, "size", size, "machineSize", p.claimSize.String())
	a.refillPool(k)
}

// poolClaimSize is the machine size pool.target asks; zero is the default.
func poolClaimSize(b protocol.PoolTargetBody) driver.ClaimSize {
	if b.MachineSize == nil {
		return driver.ClaimSize{}
	}
	return driver.ClaimSize{MemoryMB: int(b.MachineSize.MemoryMb), CPUs: int(b.MachineSize.Cpus)}
}

// poolFollowsBake moves an environment's pool to the image just baked.
func (a *Agent) poolFollowsBake(orgID, environmentID, imageID string) {
	k := poolKey{orgID, environmentID}
	a.mu.Lock()
	p := a.pools[k]
	if p != nil {
		p.imageID = imageID
	}
	a.mu.Unlock()
	if p != nil {
		a.refillPool(k)
	}
}

// refillPools tops every pool up (housekeeping): a fill that failed is
// tried again here, never in a loop of its own.
func (a *Agent) refillPools() {
	a.mu.Lock()
	keys := make([]poolKey, 0, len(a.pools))
	for k := range a.pools {
		keys = append(keys, k)
	}
	a.mu.Unlock()
	for _, k := range keys {
		a.refillPool(k)
	}
}

// refillPool drops the machines that no longer fit the target (another
// image or machine size, too close to their ceiling, past the size) and makes the missing
// ones in the background.
func (a *Agent) refillPool(k poolKey) {
	if a.cfg.Pooler == nil || !a.acceptingWork() {
		return
	}
	now := a.clock.Now()
	a.mu.Lock()
	p := a.pools[k]
	if p == nil {
		a.mu.Unlock()
		return
	}
	var keep, drop []driver.PoolMachine
	for _, m := range p.ready {
		switch {
		case p.imageID == "", m.ImageID != p.imageID, m.ClaimSize != p.claimSize, m.HardExpiresAt.Sub(now) < a.cfg.PoolTTL/2, len(keep) >= p.size:
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
	a.mu.Unlock()

	for _, m := range drop {
		a.discardPoolMachine(m, "stale")
	}
	key, err := a.cfg.OrgKey(k.orgID)
	if err != nil && need > 0 {
		a.mu.Lock()
		p.filling -= need
		a.mu.Unlock()
		a.log.Error("pool.fill.failed", "env", k.environmentID, "reason", "org_key")
		return
	}
	for range need {
		a.goTracked(func(ctx context.Context) {
			created := a.clock.Now()
			m, err := a.cfg.Pooler.PoolCreate(ctx, driver.PoolSpec{
				CellID: a.cfg.CellID, OrgID: k.orgID, EnvironmentID: k.environmentID, ImageID: imageID, KMSKeyRef: key,
				Size: a.cfg.WorkloadSize, ClaimSize: claimSize, ExpiresAt: created.Add(a.cfg.PoolTTL), HardExpiresAt: created.Add(a.cfg.PoolTTL),
			})
			a.mu.Lock()
			p.filling--
			// The driver says the size it made: one that made the default for a
			// sized pool made a machine no claim of the environment adopts.
			fits := err == nil && a.pools[k] == p && p.imageID == m.ImageID && m.ClaimSize == p.claimSize && len(p.ready) < p.size
			if fits {
				p.ready = append(p.ready, m)
			}
			a.mu.Unlock()
			switch {
			case err != nil:
				a.m.pool.Inc("failed")
				a.log.Error("pool.fill.failed", "env", k.environmentID, "err", err)
			case fits:
				a.m.pool.Inc("created")
				a.log.Info("pool.fill.done", "env", k.environmentID, "machine", m.Workload.MachineID, "ms", a.clock.Now().Sub(created).Milliseconds())
			default:
				// The target moved while it was being made.
				a.discardPoolMachine(m, "target_changed")
			}
		})
	}
}

// takePoolMachine hands out a ready machine for the claim: same org and
// environment, the image the claim asks for ("latest" or empty is the
// environment's current one), the size the claim asks, and a ceiling no
// earlier than the claim's.
func (a *Agent) takePoolMachine(acq protocol.ClaimAcquireBody, hard time.Time) (driver.PoolMachine, bool) {
	return a.poolMachine(acq, hard, true)
}

// hasPoolMachine reports whether takePoolMachine would find a machine for
// the claim now, taking none.
func (a *Agent) hasPoolMachine(acq protocol.ClaimAcquireBody, hard time.Time) bool {
	_, ok := a.poolMachine(acq, hard, false)
	return ok
}

func (a *Agent) poolMachine(acq protocol.ClaimAcquireBody, hard time.Time, take bool) (driver.PoolMachine, bool) {
	// A setup boots the default branch from nothing: it never starts from a
	// pool machine, which holds the previous bake's data.
	if a.cfg.Pooler == nil || acq.Consumer == protocol.ConsumerSetup {
		return driver.PoolMachine{}, false
	}
	// A machine of another size would give the claim more or less than its
	// environment pays for: it makes its own instead.
	size := claimSize(acq)
	k := poolKey{acq.OrgID, acq.EnvironmentID}
	a.mu.Lock()
	defer a.mu.Unlock()
	p := a.pools[k]
	if p == nil {
		return driver.PoolMachine{}, false
	}
	for i, m := range p.ready {
		image := acq.ImageID == "" || acq.ImageID == "latest" || acq.ImageID == m.ImageID
		if m.OrgID == acq.OrgID && m.EnvironmentID == acq.EnvironmentID && image && m.ClaimSize == size && !m.HardExpiresAt.Before(hard) {
			if take {
				p.ready = append(p.ready[:i:i], p.ready[i+1:]...)
			}
			return m, true
		}
	}
	return driver.PoolMachine{}, false
}

// discardPoolMachine destroys a pool machine no claim will take.
func (a *Agent) discardPoolMachine(m driver.PoolMachine, reason string) {
	a.m.pool.Inc("discarded")
	a.goTracked(func(ctx context.Context) {
		if err := a.cfg.Driver.Destroy(ctx, m.Workload); err != nil {
			a.log.Warn("pool.discard.failed", "machine", m.Workload.MachineID, "err", err)
		}
		if err := a.cfg.Driver.ReleaseClaim(ctx, m.Network); err != nil {
			a.log.Warn("pool.discard.failed", "machine", m.Workload.MachineID, "network", m.Network.WorkloadGroupID, "err", err)
		}
		a.log.Info("pool.discarded", "machine", m.Workload.MachineID, "reason", reason)
	})
}
