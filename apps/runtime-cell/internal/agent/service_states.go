package agent

import (
	"context"
	"fmt"
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
	oom := a.workloadOOM(ctx, workload, exited)
	diag := make([]driver.ServiceDiagnostics, 0, len(exited))
	for _, e := range exited {
		log := e.Log
		if oom && e.ExitCode == exitKilled {
			log = append([]string{oomLine(e.Name)}, log...)
		}
		diag = append(diag, driver.ServiceDiagnostics{Name: e.Name, State: e.State, Log: log})
	}
	w := newBundleWriter(c.Redactor(), a.clock.Now())
	w.services(diag)
	for i, item := range w.b.Services {
		res.Services = append(res.Services, protocol.StepResultBodyServicesItem{Name: item.Name, State: item.State, ExitCode: int64(min(max(exited[i].ExitCode, 0), 255)), LogTail: item.LogTail})
	}
}

// exitKilled is the exit code of a process the kernel killed (SIGKILL).
const exitKilled = 137

// oomLine is what the blocker reads of a service the kernel killed at its
// memory limit. The classifier turns it into a card naming the service.
func oomLine(service string) string {
	return fmt.Sprintf("%s exited with code 137: the kernel killed it for memory (OOM): raise the environment's machine size or declare mem_limit for %s", service, service)
}

// workloadOOM says one of the exited services was killed with 137 and the
// claim's kernel counted an OOM kill: a 137 alone may be a stop or a manual
// kill, so the line is added only with the OOM event beside it.
func (a *Agent) workloadOOM(ctx context.Context, workload driver.MachineRef, exited []driver.ExitedService) bool {
	killed := false
	for _, e := range exited {
		killed = killed || e.ExitCode == exitKilled
	}
	if !killed || a.cfg.Parts.Health == nil {
		return false
	}
	h, err := a.cfg.Parts.Health.MachineHealth(ctx, workload)
	return err == nil && h.OOMKills > 0
}
