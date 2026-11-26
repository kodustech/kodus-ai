package agent

import (
	"context"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// A ready check asks the app on its health path every few seconds. An app that
// started and died (a seed step that exits non-zero) never answers, and the
// check waited out its whole timeout. So a probe that got no HTTP answer also
// carries the services that have exited, with their exit code and the tail of
// their log, redacted and capped as the failure bundle's are, and the check
// ends at once on them.
const (
	exitedTailLines   = 50
	exitedReadTimeout = 10 * time.Second
)

// attachExitedServices adds the exited services to a probe's result when the
// probe was an HTTP one that got no answer, to a hub that accepts the field.
func (a *Agent) attachExitedServices(ctx context.Context, c *claims.Claim, b *protocol.ProbeRunBody, res *protocol.StepResultBody) {
	r := a.cfg.Parts.ExitedServices
	if r == nil || !a.hubAccepts(protocol.FeatureServiceStates) || b.Probe.Spec.HTTP == nil {
		return
	}
	if res.Probe != nil && res.Probe.HTTP != nil {
		return
	}
	workload := c.Machines().Workload
	if workload.MachineID == "" {
		return
	}
	rctx, cancel := context.WithTimeout(ctx, exitedReadTimeout)
	exited, err := r.ExitedServices(rctx, workload, exitedTailLines)
	cancel()
	if err != nil {
		c.Log.Warn("probe.exited_services", "err", err)
		return
	}
	diag := make([]driver.ServiceDiagnostics, 0, len(exited))
	for _, e := range exited {
		diag = append(diag, driver.ServiceDiagnostics{Name: e.Name, State: e.State, Log: e.Log})
	}
	w := newBundleWriter(c.Redactor(), a.clock.Now())
	w.services(diag)
	for i, item := range w.b.Services {
		res.Services = append(res.Services, protocol.StepResultBodyServicesItem{Name: item.Name, State: item.State, ExitCode: int64(min(max(exited[i].ExitCode, 0), 255)), LogTail: item.LogTail})
	}
}
