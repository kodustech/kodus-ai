package agent

import (
	"context"
	"sync"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
)

// pendingCleanups are the released claims whose teardown the driver could
// not confirm. Each keeps its memory held (the ledger hold Retain gave)
// until a later destroy of everything its lease named succeeds, which a
// sweep tick retries: a hold never outlives its machines, and never ends
// before them. The hold's release used to be dropped, so one failed docker
// rm kept 2 GB of the cell committed until the cell restarted (dev cell,
// 2026-11-19).
type pendingCleanups struct {
	mu      sync.Mutex
	byClaim map[string]pendingCleanup
}

type pendingCleanup struct {
	lease   lease.Lease
	release func()
}

func (p *pendingCleanups) add(claimID string, l lease.Lease, release func()) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.byClaim == nil {
		p.byClaim = map[string]pendingCleanup{}
	}
	if old, ok := p.byClaim[claimID]; ok {
		old.release() // one hold per claim: the newer one counts the same
	}
	p.byClaim[claimID] = pendingCleanup{lease: l, release: release}
}

func (p *pendingCleanups) all() map[string]pendingCleanup {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make(map[string]pendingCleanup, len(p.byClaim))
	for id, c := range p.byClaim {
		out[id] = c
	}
	return out
}

// settled drops the claim and releases its hold, once.
func (p *pendingCleanups) settled(claimID string) {
	p.mu.Lock()
	c, ok := p.byClaim[claimID]
	delete(p.byClaim, claimID)
	p.mu.Unlock()
	if ok {
		c.release()
	}
}

func (p *pendingCleanups) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.byClaim)
}

// settlePendingCleanups destroys again what each pending claim's lease
// named. A destroy of what is already gone succeeds (the sweep may have
// taken it), so a clean pass is the proof the machines are gone: the hold
// is released and the memory is the cell's again.
func (a *Agent) settlePendingCleanups(ctx context.Context) {
	for id, p := range a.pending.all() {
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		err := a.leases.EndMachines(cctx, p.lease)
		cancel()
		if err != nil {
			a.log.Warn("resource.cleanup_still_pending", "kodus.runtime.claim.id", id, "err", err)
			continue
		}
		a.pending.settled(id)
		a.log.Info("resource.cleanup_settled", "kodus.runtime.claim.id", id)
		a.nudgeHeartbeat()
	}
}
