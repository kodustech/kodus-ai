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
// cell refuses when it is not a fleet host (no HostSeal) or a claim is live:
// the hub asks again when the work is done. The ack comes first, the seal
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
	a.goTracked(func(ctx context.Context) {
		if err := a.cfg.HostSeal.Seal(context.WithoutCancel(ctx)); err != nil {
			a.log.Error("cell.seal.failed", "alarm", true, "err", err)
			return
		}
		a.log.Info("cell.seal", "started", true)
	})
	return nil
}
