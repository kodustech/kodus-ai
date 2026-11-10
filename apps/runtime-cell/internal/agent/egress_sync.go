package agent

import (
	"context"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// egressPolicy stores the hub's allowlist for the claim (it replaces the
// previous one) and pushes it once the claim is prepared.
func (a *Agent) egressPolicy(claimID string, b *protocol.EgressPolicyBody) error {
	issued, err := protocol.ParseTime(b.IssuedAt)
	if err != nil {
		return nack("invalid_body", "issuedAt")
	}
	c, ok := a.claims.Get(claimID)
	if !ok {
		return nack("unknown_claim", "%s", claimID)
	}
	stale, ok := c.SetAllow(b.Allow, issued)
	if !ok {
		return nack("unknown_claim", "%s", claimID)
	}
	if stale {
		c.Log.Warn("egress.policy.stale", "issuedAt", b.IssuedAt)
		return nil
	}
	c.Log.Info("egress.policy", "hosts", len(b.Allow), "issuedAt", b.IssuedAt)
	if a.cfg.Egress == nil {
		return nil
	}
	a.goTracked(func(ctx context.Context) {
		select {
		case <-c.Settled():
		case <-ctx.Done():
			return
		}
		if st := c.State(); st != claims.Ready && st != claims.Held {
			return
		}
		if err := a.applyEgress(ctx, c); err != nil {
			c.Log.Error("egress.policy.apply", "err", err)
		}
	})
	return nil
}

// applyEgress pushes the claim's policy with the latest extra allowlist,
// again until no newer egress.policy arrived during the push.
func (a *Agent) applyEgress(ctx context.Context, c *claims.Claim) error {
	unlock := c.EgressLock()
	defer unlock()
	for {
		allow, gen, ok := c.PendingAllow()
		if !ok {
			return nil
		}
		ci := info(c)
		ci.ExtraAllow = allow
		if err := a.cfg.Egress.Apply(ctx, ci); err != nil {
			return err
		}
		c.MarkAllowApplied(gen)
	}
}

// pushEgressBeforeUp pushes the claim's policy as it stands before its
// project comes up. It is not marked applied: the push after Up, with the
// containers' addresses, replaces it.
func (a *Agent) pushEgressBeforeUp(ctx context.Context, c *claims.Claim) error {
	unlock := c.EgressLock()
	defer unlock()
	allow, _, _ := c.PendingAllow()
	ci := info(c)
	ci.ExtraAllow = allow
	return a.cfg.Egress.Apply(ctx, ci)
}
