package agent

import (
	"context"
	"errors"
	"os"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
)

// cleanupTimeout bounds one claim's teardown; it runs even after Run's
// context ended, so a cell stopping still destroys what it can.
const cleanupTimeout = 2 * time.Minute

func (a *Agent) releaseFrame(claimID string) error {
	c, ok := a.claims.Get(claimID)
	if !ok {
		return nack("unknown_claim", "%s", claimID)
	}
	a.goTracked(func(ctx context.Context) { a.release(ctx, c) })
	return nil
}

// release is claim.release: it stops the claim's steps and its preparation,
// waits (bounded) for the preparation to stop, and tears the claim down.
func (a *Agent) release(ctx context.Context, c *claims.Claim) {
	prev := c.Release()
	a.observeClaims()
	if prev == claims.Acquiring {
		// Release closed Settled; prepare still has to return so that what it
		// created is in the lease. Its context is cancelled: this is quick,
		// unless a driver call ignores it.
		select {
		case <-c.Prepared():
		case <-a.clock.After(a.cfg.ReleaseWait):
			c.Log.Warn("claim.release.prepare_still_running", "waitedMs", a.cfg.ReleaseWait.Milliseconds())
		case <-ctx.Done():
		}
	}
	attrs := []any{"from", prev.String()}
	if b := c.BoundAt(); !b.IsZero() {
		attrs = append(attrs, "heldMs", a.clock.Now().Sub(b).Milliseconds())
	}
	c.Log.Info("claim.release", attrs...)
	a.cleanup(ctx, c, "release")
}

// cleanup destroys what the claim holds on the cell: machines, network,
// egress policy, keys, and its slot. The first caller does it; the others
// return at once.
func (a *Agent) cleanup(ctx context.Context, c *claims.Claim, reason string) {
	c.Release()
	if !c.BeginCleanup() {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
	defer cancel()
	if err := a.leases.Release(ctx, c.ID); err != nil && !errors.Is(err, lease.ErrUnknownClaim) {
		a.m.cleanupsFailed.Inc()
		c.Log.Warn("claim.cleanup.machines", "err", err)
		if a.cfg.RequireMemoryAdmission && a.mem != nil {
			// Logical removal is not physical release. Convert the active
			// reservation to an exceptional hold before removing the claim,
			// so neither a new id nor reuse of this id borrows its capacity.
			_, retained := a.mem.retain(c.ID, a.mem.count(c.ID))
			if retained {
				a.mem.forget(c.ID)
			}
			c.Log.Error("resource.cleanup_pending", "alarm", true, "memoryRetained", retained, "err", err)
			a.nudgeHeartbeat()
		}
	}
	if a.cfg.Egress != nil {
		unlock := c.EgressLock()
		if err := a.cfg.Egress.Remove(ctx, c.ID); err != nil {
			a.m.cleanupsFailed.Inc()
			c.Log.Warn("claim.cleanup.egress", "err", err)
		}
		unlock()
	}
	if a.cfg.Keys != nil {
		a.cfg.Keys.Forget(c.ID)
	}
	if a.cfg.SQLObservers != nil {
		a.cfg.SQLObservers.ForgetObserverSQL(c.Machines().Workload.MachineID)
	}
	a.untaint(c.Machines().Workload)
	if dir, err := claims.WorkDir(a.cfg.WorkDir, c.ID); err == nil {
		_ = os.RemoveAll(dir) // a compose checkout, kept until now
	}
	if a.claims.Remove(c) && a.mem != nil {
		a.mem.forget(c.ID)
		a.nudgeHeartbeat()
	}
	a.observeClaims()
	c.Log.Info("claim.cleaned", "reason", reason)
}

// ReapDeadClaims tears down the claims nothing keeps alive any more: a
// diagnostic hold past its ceiling, and any claim whose lease ended (the hub
// stopped renewing, the sweep or the dead-man took its machines). Without it
// such a claim kept its slot, its egress allowlist and its SSH keys forever.
// A claim still booting is released, as by the hub: its preparation stops
// (the build with it) before its policy goes, so the next claim on the same
// source address is not refused for a policy no one holds.
func (a *Agent) ReapDeadClaims(ctx context.Context) {
	now := a.clock.Now()
	for _, c := range a.claims.All() {
		reason := ""
		switch st := c.State(); {
		case st == claims.Held && !now.Before(c.HoldUntil()):
			reason = "hold_expired"
		// A booting claim is reaped only once its lease was tracked and has ended:
		// before prepare tracks it (network, pool adoption) it simply has none yet.
		case st == claims.Acquiring && a.leaseEnded(c.ID, now):
			a.m.claimsReaped.Inc("lease_expired_booting")
			c.Log.Warn("claim.reaped", "reason", "lease_expired_booting")
			a.goTracked(func(ctx context.Context) { a.release(ctx, c) })
			continue
		case st == claims.Acquiring || st == claims.Released:
			continue // bringUp or a release owns it
		case !a.leases.HasLiveLease(c.ID):
			reason = "lease_expired"
		}
		if reason == "" {
			continue
		}
		a.m.claimsReaped.Inc(reason)
		c.Log.Warn("claim.reaped", "reason", reason)
		a.cleanup(ctx, c, reason)
	}
}

// leaseEnded reports whether the claim's lease was tracked and is past.
func (a *Agent) leaseEnded(claimID string, now time.Time) bool {
	l, ok := a.leases.Get(claimID)
	return ok && !now.Before(l.ExpiresAt)
}
