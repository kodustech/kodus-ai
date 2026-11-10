package agent

import (
	"context"
	"errors"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/outbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// bringUp prepares the claim and settles it on the hub: claim.ready, or
// claim.failed (with a held claim's machines kept for diagnosis).
func (a *Agent) bringUp(ctx context.Context, c *claims.Claim, hard time.Time) {
	pctx, cancel := context.WithDeadline(ctx, hard)
	defer cancel()
	if !c.SetPrepareCancel(cancel) {
		c.FinishPrepare()
		a.cleanupReleased(ctx, c)
		return
	}
	err := a.prepare(pctx, c, hard)
	c.FinishPrepare()
	// Before cleanup forgets the claim's keys (S-51).
	r := a.claimRedactor(c)
	if err == nil {
		if !c.MarkReady(a.clock.Now(), r) {
			a.cleanupReleased(ctx, c)
			return
		}
		a.observeClaims()
		a.countReady(c)
		body := a.readyBody(c)
		c.Log.Info("claim.ready", timingAttrs(body.Timing)...)
		if err := a.deliver(ctx, c, "claim.ready", body); err != nil {
			var n *hubclient.NackError
			if errors.Is(err, protocol.ErrRefusedToSend) {
				// A ready body the protocol refuses (a bug of this cell): the hub
				// hears a failure now instead of waiting out the boot.
				a.cleanup(ctx, c, "ready_refused")
				_ = a.deliver(ctx, c, "claim.failed", failedBody(blockerErr(protocol.BlockerKindPlatform, "claim_ready_refused", err)))
				return
			}
			if errors.As(err, &n) {
				// The hub no longer waits for this claim (it timed out, the
				// connection it went out on dropped): nothing will use it.
				a.cleanup(ctx, c, "ready_nacked")
			}
		}
		return
	}
	c.Log.Error("claim.failed", "err", err, "prepareMs", a.clock.Now().Sub(c.AcquiredAt).Milliseconds())
	body := failedBody(err)
	c.SetRedactor(r)
	if a.isCleanSetupClaim(c) && c.Machines().Workload.MachineID != "" {
		body.Bundle = a.collectBundle(ctx, c, err)
	}
	if until, ok := a.startHold(ctx, c, hard); ok {
		if !c.MarkFailed(err, r, until) {
			a.cleanupReleased(ctx, c)
			return
		}
		a.observeClaims()
		// Its builds are over: the held machines are counted as a ready claim's.
		a.countReady(c)
		held := true
		body.Held = &held
		_ = a.deliver(ctx, c, "claim.failed", body)
		return
	}
	if !c.MarkFailed(err, r, time.Time{}) {
		a.cleanupReleased(ctx, c)
		return
	}
	a.observeClaims()
	// Clean up first: when the hub reads claim.failed nothing of the
	// claim is left on the cell.
	a.cleanup(ctx, c, "failed")
	_ = a.deliver(ctx, c, "claim.failed", body)
}

// cleanupReleased tears down a claim released while it was prepared. A
// release that stopped waiting for the preparation already cleaned up; what
// the preparation created after that is in the lease, released here.
func (a *Agent) cleanupReleased(ctx context.Context, c *claims.Claim) {
	a.cleanup(ctx, c, "released")
	if err := a.leases.Release(context.WithoutCancel(ctx), c.ID); err != nil && !errors.Is(err, lease.ErrUnknownClaim) {
		c.Log.Warn("claim.cleanup.machines", "err", err)
	}
}

// deliver redacts a claim frame (S-51) and hands it to the outbox: sent
// until acked, while the claim is still wanted.
func (a *Agent) deliver(ctx context.Context, c *claims.Claim, kind string, body any) error {
	a.redactOutbound(c, body)
	wanted := func() bool { return c.State() != claims.Released && a.allowAlertDelivery(kind) }
	if kind == "claim.failed" {
		wanted = nil // sent after the cleanup by design
	}
	return a.outbox.Deliver(ctx, outbox.Frame{ClaimID: c.ID, Kind: kind, Body: body, Log: c.Log, Wanted: wanted})
}

func timingAttrs(t *protocol.ReadyTiming) []any {
	if t == nil {
		return nil
	}
	out := []any{"prepareMs", t.PrepareMs}
	for _, f := range []struct {
		k string
		v *int64
	}{{"bootMs", t.BootMs}, {"buildMs", t.BuildMs}, {"upMs", t.UpMs}, {"seedMs", t.SeedMs}, {"readyMs", t.ReadyMs}, {"snapshotMs", t.SnapshotMs}} {
		if f.v != nil {
			out = append(out, f.k, *f.v)
		}
	}
	return out
}
