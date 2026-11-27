package agent

import (
	"context"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// Data-only reset (data.reset: data-only; docs/runtime/persistent-state.md
// section 11). A machine.reset of a claim whose recipe opted in first asks the
// driver to restore only the data services and keep the app running. The
// driver tries its modes in order (data, restart-app) and says recreate
// when none worked: then the reset is the one it always was.

// dataOnly is true when the claim's driver can reset data only and the
// recipe it booted asks for it.
func (a *Agent) dataOnly(c *claims.Claim) bool {
	if a.cfg.Parts.DataResetter == nil {
		return false
	}
	file, dir := c.Compose()
	if file == nil {
		return false
	}
	rec, err := recipe.Load(dir)
	return err == nil && rec != nil && rec.ResetStrategy() == recipe.ResetDataOnly
}

// dataReset resets the claim's data services and keeps its app. ok false:
// the driver says recreate (or fails), and the caller resets as before.
// The sources are the project's addresses, which a kept app never changed.
func (a *Agent) dataReset(ctx context.Context, c *claims.Claim, workload driver.MachineRef) ([]string, bool) {
	if !a.dataOnly(c) {
		return nil, false
	}
	res, err := a.cfg.Parts.DataResetter.ResetData(ctx, workload)
	switch {
	case err != nil:
		c.Log.Warn("data.reset.failed", "err", err)
		return nil, false
	case res.Mode == driver.ResetModeRecreate:
		c.Log.Info("data.reset.recreate", "why", res.Why)
		return nil, false
	}
	c.Log.Info("data.reset.done", "mode", res.Mode)
	return res.Sources, true
}
