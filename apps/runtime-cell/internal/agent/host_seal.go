package agent

import (
	"context"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
)

// HostSealer starts the host's seal (cell-host.sh seal) detached from this
// process: the seal stops the cell itself, so it must outlive it.
type HostSealer interface {
	Seal(ctx context.Context) error
}

// cellSeal answers cell.seal, which the hub sends only to the cell of an
// environment template's setup host (bound key template:<org>/<env>). The
// cell refuses when it is not a fleet host (no HostSeal), a claim is live or
// a bake is in progress (the setup claim is released once its bake is acked,
// minutes before the bake has exported and recorded its images; a seal then
// stops the cell mid-bake and the template keeps no bake): the fleet asks
// again when the work is done. The ack comes first, the seal
// starts right after; once it runs the cell is stopped and its connection
// closes, which is how the fleet knows the seal finished.
func (a *Agent) cellSeal() error {
	if a.cfg.HostSeal == nil {
		return nack("not_fleet", "this cell is not installed as a fleet host and cannot seal itself")
	}
	for _, c := range a.claims.All() {
		if c.State() != claims.Released {
			return nack("claim_live", "a claim is live on this cell; seal after it is released")
		}
	}
	if _, _, baking := a.origin.Counts(); baking > 0 {
		return nack("bake_running", "a bake is in progress on this cell; seal after it has recorded its images")
	}
	a.goTracked(func(ctx context.Context) {
		// The template's disk is saved as it is: discard what the setup's
		// builds freed first, or the sparse file keeps every block ever written.
		if w := a.cfg.DiskWatch; w != nil && w.Trim != nil {
			n, err := w.Trim(context.WithoutCancel(ctx))
			a.log.Info("cell.seal.trim", "freedBytes", n, "err", err)
			if err == nil && n > 0 {
				a.m.diskFreed.Add(float64(n), "seal_fstrim")
			}
		}
		if err := a.cfg.HostSeal.Seal(context.WithoutCancel(ctx)); err != nil {
			a.log.Error("cell.seal.failed", "alarm", true, "err", err)
			return
		}
		a.log.Info("cell.seal", "started", true)
	})
	return nil
}
