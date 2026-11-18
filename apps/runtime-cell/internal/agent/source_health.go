package agent

import (
	"context"
	"sync"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
)

// alertSourceHealth is the alert feeds' state: work is admitted only while
// every feed (the injector's, the proxy's) answers and none lost history.
type alertSourceHealth struct {
	mu         sync.RWMutex
	ready      []bool // per source, in alertSources order
	latched    bool
	generation uint64
}

func (h *alertSourceHealth) allReady() bool {
	for _, r := range h.ready {
		if !r {
			return false
		}
	}
	return len(h.ready) > 0
}

// alertSources are the feeds the agent watches: the injector's
// (credential and bait exfiltration) and the proxy's (a placeholder over
// plain HTTP), whichever the cell has.
func alertSources(cfg Config) []AlertSource {
	var out []AlertSource
	for _, s := range []AlertSource{cfg.Alerts, cfg.EgressAlerts} {
		if s != nil {
			out = append(out, s)
		}
	}
	return out
}

// alertAdmissionSnapshot fences an acquire that crosses a failed poll, even
// if a later poll recovers before that acquire adds itself to the registry.
func (a *Agent) alertAdmissionSnapshot() (uint64, bool) {
	if len(a.alertSources) == 0 {
		return 0, true
	}
	a.sourceHealth.mu.RLock()
	defer a.sourceHealth.mu.RUnlock()
	return a.sourceHealth.generation, a.sourceHealth.allReady() && !a.sourceHealth.latched
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

// alertSourceReady marks the first feed answering (a cell with one feed).
func (a *Agent) alertSourceReady() { a.alertSourceReadyAt(0) }

// alertSourceReadyAt marks feed i answering; work is admitted once every
// feed does.
func (a *Agent) alertSourceReadyAt(i int) {
	a.sourceHealth.mu.Lock()
	if a.sourceHealth.latched || i >= len(a.sourceHealth.ready) {
		a.sourceHealth.mu.Unlock()
		return
	}
	was := a.sourceHealth.allReady()
	a.sourceHealth.ready[i] = true
	now := a.sourceHealth.allReady()
	a.sourceHealth.mu.Unlock()
	if !now {
		return
	}
	a.m.alertSourceAvailable.Set(1)
	if !was {
		a.log.Info("alerts.source_available")
		a.nudgeHeartbeat()
	}
}

// alertSourceFailed fails the first feed (a cell with one feed).
func (a *Agent) alertSourceFailed(err error) { a.alertSourceFailedAt(0, err) }

// alertSourceFailedAt stops the unobserved window as infrastructure
// failure. No claim is marked compromised and no security-violation frame
// is forged.
func (a *Agent) alertSourceFailedAt(i int, err error) {
	reason := eventlog.FailureReason(err)
	a.sourceHealth.mu.Lock()
	if i < len(a.sourceHealth.ready) {
		a.sourceHealth.ready[i] = false
	}
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
