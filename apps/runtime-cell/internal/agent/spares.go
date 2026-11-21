package agent

import (
	"context"
	"errors"
	"slices"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Warm spares (driver.SpareKeeper, docker-gvisor's warm fork reset,
// docs/runtime/gvisor-warm-fork-reset.md). Once a Run's claim is ready, and
// after each of its resets, a second copy of its compose project boots
// beside it while the round runs; the next machine.reset swaps it in.
//
// A spare costs the claim's memory again. It boots only when the memory
// ledger has that much room after every claim, hold and other spare
// (admission.Ledger.Spare), and the ledger drops it the moment a claim
// needs the room: it never makes a claim refuse or wait. With no memory
// admission there is no spare. Anything that goes wrong with a spare leaves
// the reset as it was.

// wantsSpare: a ready Run claim (base or PR) whose project the driver
// boots, on a cell that counts memory and whose driver keeps spares.
func (a *Agent) wantsSpare(c *claims.Claim) bool {
	if a.cfg.Parts.Spares == nil || a.mem == nil || c.State() != claims.Ready {
		return false
	}
	file, _ := c.Compose()
	acq := c.Acquire
	return file != nil && acq.Consumer == protocol.ConsumerRuntime && (acq.Side == protocol.SideBase || acq.Side == protocol.SidePr)
}

// bootSpare reserves the claim's spare and boots it in the background: its
// addresses join the claim's egress policy before any of its containers
// starts (a setup step may fetch), and leave it again when it fails.
func (a *Agent) bootSpare(c *claims.Claim) {
	if !a.wantsSpare(c) {
		return
	}
	mb := a.mem.Count(c.ID)
	workload := c.Machines().Workload
	evict := func() {
		c.Log.Info("spare.evicted", "spareMb", mb)
		a.goTracked(func(ctx context.Context) {
			if _, err := a.cfg.Parts.Spares.DropSpare(ctx, workload); err != nil {
				c.Log.Warn("spare.drop.failed", "err", err)
			}
		})
	}
	if !a.mem.Spare(c.ID, mb, evict) {
		c.Log.Info("spare.skipped", "reason", "no_room", "spareMb", mb, "committedMb", a.mem.Committed(), "sparesMb", a.mem.Spares(), "allocatableMb", a.mem.Allocatable())
		return
	}
	file, dir := c.Compose()
	req := a.upRequest(c, workload, file, dir, claimCanaries(c.Acquire), nil)
	a.goTracked(func(ctx context.Context) {
		start := a.clock.Now()
		before := c.Machines().Sources
		err := a.cfg.Parts.Spares.BootSpare(ctx, req, func(spare []string) error {
			c.SetSources(unionSources(before, spare))
			if a.cfg.Egress == nil {
				return nil
			}
			return a.applyEgress(ctx, c)
		})
		ms := a.clock.Now().Sub(start).Milliseconds()
		if err != nil {
			a.mem.EndSpare(c.ID)
			c.SetSources(before)
			if a.cfg.Egress != nil && c.State() == claims.Ready {
				if perr := a.applyEgress(ctx, c); perr != nil {
					c.Log.Warn("egress.policy.apply", "err", perr)
				}
			}
			if !errors.Is(err, context.Canceled) {
				c.Log.Warn("spare.failed", "durationMs", ms, "err", err)
			}
			return
		}
		c.Log.Info("spare.ready", "durationMs", ms, "spareMb", mb)
	})
}

// takeSpare swaps the claim's ready spare in, when it has one: its
// project's addresses from now on. false: no spare, or one that failed
// (logged); the caller resets as before.
func (a *Agent) takeSpare(ctx context.Context, c *claims.Claim, workload driver.MachineRef) ([]string, bool) {
	if a.cfg.Parts.Spares == nil {
		return nil, false
	}
	sources, ok, err := a.cfg.Parts.Spares.TakeSpare(ctx, workload)
	switch {
	case err != nil:
		a.mem.EndSpare(c.ID)
		c.Log.Warn("spare.swap.failed", "err", err)
		return nil, false
	case !ok:
		return nil, false // none, or one still booting: it stays for the next reset
	}
	a.mem.EndSpare(c.ID) // the spare is the claim's project now, counted as the claim
	return sources, true
}

// afterSwap is composeUpAgain for a project the spare already brought up
// and ran the recipe's steps in: the policy names the spare's containers,
// and the observer's SQL account goes into its database.
func (a *Agent) afterSwap(ctx context.Context, c *claims.Claim, workload driver.MachineRef, sources []string) error {
	c.SetSources(sources)
	a.coveredAfterUp(c, workload)
	if a.cfg.Egress != nil {
		if err := a.applyEgress(ctx, c); err != nil {
			return errors.Join(errors.New("egress policy after the swap"), err)
		}
	}
	_, dir := c.Compose()
	return a.provisionObserverSQL(ctx, c, dir)
}

// unionSources is a, then what of b it lacks.
func unionSources(a, b []string) []string {
	out := slices.Clone(a)
	for _, s := range b {
		if !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	return out
}
