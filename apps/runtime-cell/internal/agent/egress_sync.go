package agent

import (
	"context"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
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
	if c.Layers.Build != nil {
		// The builder reaches its registry host and nothing else, and the cell
		// seals it itself: no frame widens or replaces that policy.
		return nack("not_supported", "a layer builder's egress is the cell's alone")
	}
	if b.Sealed != nil && *b.Sealed {
		return a.sealEgress(c)
	}
	stale, ok := c.SetAllow(b.Allow, claims.InspectRules(b.Inspect), issued)
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
		ci.ExtraAllow, ci.ExtraInspect = allow, c.PendingInspect()
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
	ci.ExtraAllow, ci.ExtraInspect = allow, c.PendingInspect()
	return a.cfg.Egress.Apply(ctx, ci)
}

// sealEgress closes a sandbox claim's egress for good (egress.policy sealed):
// the claim is marked sealed first, so every push from here on, this one or a
// racing one, builds a policy that allows nothing, and the answer comes only
// once the enforcers hold it (and have cut the connections the old policy
// allowed). A push that fails is a nack: the claim stays sealed, so the next
// push closes it, but the hub must not hand the sandbox out as sealed. Only a
// sandbox claim seals; a Run or setup claim's egress is its own recipe's.
func (a *Agent) sealEgress(c *claims.Claim) error {
	if !isSandbox(c) {
		return nack("not_supported", "only a sandbox claim's egress is sealed")
	}
	if a.cfg.Egress == nil {
		// A cell with no egress control pushes no policy: nothing here could close it.
		return nack("egress_unavailable", "this cell has no egress control to seal with")
	}
	if st := c.State(); st != claims.Ready {
		return nack("claim_not_ready", "the claim is %s", st)
	}
	return hubclient.Later(func(ctx context.Context) error {
		if err := a.applySeal(ctx, c); err != nil {
			return nack("seal_failed", "the sealed policy was not pushed: %v", err)
		}
		return nil
	})
}

// applySeal marks the sandbox claim sealed and pushes the policy that allows
// nothing; it returns once the enforcers hold it. A layer builder is sealed
// by the cell itself, right after its install.
func (a *Agent) applySeal(ctx context.Context, c *claims.Claim) error {
	gen, first := c.Seal()
	unlock := c.EgressLock()
	defer unlock()
	if err := a.cfg.Egress.Apply(ctx, info(c)); err != nil {
		a.m.egressSeals.Inc("failed")
		c.Log.Error("egress.seal.failed", "alarm", true, "err", err)
		return err
	}
	c.MarkAllowApplied(gen)
	a.m.egressSeals.Inc("ok")
	c.Log.Info("egress.sealed", "org", c.Acquire.OrgID, "first", first)
	return nil
}
