package agent

import (
	"context"
	"errors"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// startHold keeps a failed setup claim's machines until hardExpiresAt when
// the claim asked for it (§11 runbook): only a setup claim that never ran
// PR code, only with machines to look at. The lease moves to the ceiling,
// so the sweep, the dead-man and the reaper take it at kodus:hard-expires,
// and ReapDeadClaims ends the hold there. It returns when the hold ends.
func (a *Agent) startHold(ctx context.Context, c *claims.Claim, hard time.Time) (time.Time, bool) {
	acq := c.Acquire
	if acq.DiagnosticHold == nil || !*acq.DiagnosticHold || !a.isCleanSetupClaim(c) || c.Machines().Workload.MachineID == "" {
		return time.Time{}, false
	}
	if _, err := a.leases.Renew(ctx, c.ID, hard); err != nil {
		if errors.Is(err, lease.ErrUnknownClaim) || errors.Is(err, lease.ErrExpired) || errors.Is(err, lease.ErrTagsBehind) {
			// Without the ceiling on the tags the sweep would take the
			// machines at the old end: no hold.
			c.Log.Warn("claim.hold.refused", "err", err)
			return time.Time{}, false
		}
	}
	c.Log.Warn("claim.held", "until", protocol.FormatTime(hard))
	return hard, true
}
