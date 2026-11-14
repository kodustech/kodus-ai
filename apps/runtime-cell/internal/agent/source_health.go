package agent

import (
	"context"
	"sync"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
)

type alertSourceHealth struct {
	mu             sync.RWMutex
	ready, latched bool
	generation     uint64
}

// alertAdmissionSnapshot fences an acquire that crosses a failed poll, even
// if a later poll recovers before that acquire adds itself to the registry.
func (a *Agent) alertAdmissionSnapshot() (uint64, bool) {
	if a.cfg.Alerts == nil {
		return 0, true
	}
	a.sourceHealth.mu.RLock()
	defer a.sourceHealth.mu.RUnlock()
	return a.sourceHealth.generation, a.sourceHealth.ready && !a.sourceHealth.latched
}

func (a *Agent) alertAdmissionCurrent(generation uint64) bool {
	current, available := a.alertAdmissionSnapshot()
	return available && current == generation
}

func (a *Agent) alertSourceAvailable() bool {
	_, available := a.alertAdmissionSnapshot()
	return available
}

func (a *Agent) acceptingWork() bool { return a.alertSourceAvailable() && a.deadman.Accepting() }

// allowAlertDelivery is checked on every outbox attempt. Release remains
// available while ready and result frames require a verified alert source.
func (a *Agent) allowAlertDelivery(kind string) bool {
	return kind != "claim.ready" && kind != "step.result" || a.alertSourceAvailable()
}

func (a *Agent) alertSourceReady() {
	a.sourceHealth.mu.Lock()
	if a.sourceHealth.latched {
		a.sourceHealth.mu.Unlock()
		return
	}
	changed := !a.sourceHealth.ready
	a.sourceHealth.ready = true
	a.sourceHealth.mu.Unlock()
	a.m.alertSourceAvailable.Set(1)
	if changed {
		a.log.Info("alerts.source_available")
		a.nudgeHeartbeat()
	}
}

// alertSourceFailed stops the unobserved window as infrastructure failure.
// No claim is marked compromised and no security-violation frame is forged.
func (a *Agent) alertSourceFailed(ctx context.Context, err error) {
	reason := eventlog.FailureReason(err)
	a.sourceHealth.mu.Lock()
	a.sourceHealth.ready = false
	a.sourceHealth.generation++
	a.sourceHealth.latched = a.sourceHealth.latched || eventlog.HistoryLost(err)
	latched := a.sourceHealth.latched
	a.sourceHealth.mu.Unlock()
	a.m.alertSourceAvailable.Set(0)
	a.m.alertSourceFailures.Inc(string(reason))
	a.log.Error("alerts.source_unavailable", "alarm", true, "reason", reason, "latched", latched)
	a.nudgeHeartbeat()
	for _, c := range a.claims.All() {
		previous := c.Release()
		if previous == claims.Released {
			continue
		}
		c.Log.Warn("claim.alert_source_unavailable", "reason", reason)
		a.goTracked(func(ctx context.Context) {
			if previous == claims.Acquiring {
				select {
				case <-c.Prepared():
				case <-a.clock.After(a.cfg.ReleaseWait):
					c.Log.Warn("claim.release.prepare_still_running", "waitedMs", a.cfg.ReleaseWait.Milliseconds())
				case <-ctx.Done():
				}
			}
			a.cleanup(ctx, c, "alert_source_unavailable")
		})
	}
	a.observeClaims()
}
