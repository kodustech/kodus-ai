package agent

import (
	"context"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Alert is one injector alert: a claim's test credential, or a bait the
// cell planted, left for a host it was not issued for.
type Alert struct {
	Seq     int64
	ClaimID string
	Host    string
	// Kind is credential_exfiltration or bait_exfiltration.
	Kind string
	At   time.Time
}

// AlertSource long-polls alerts after a sequence number.
type AlertSource interface {
	Alerts(ctx context.Context, after int64) ([]Alert, error)
}

// alertRetry is the wait after a failed poll.
const alertRetry = 5 * time.Second

// watchAlerts turns every exfiltration alert into a blocker on its claim
// until ctx ends.
func (a *Agent) watchAlerts(ctx context.Context) {
	var after int64
	for ctx.Err() == nil {
		got, err := a.cfg.Alerts.Alerts(ctx, after)
		if err != nil {
			if ctx.Err() == nil {
				a.alertSourceFailed(ctx, err)
				if eventlog.HistoryLost(err) {
					return
				}
				select {
				case <-a.clock.After(alertRetry):
				case <-ctx.Done():
				}
			}
			continue
		}
		for _, al := range got {
			after = max(after, al.Seq)
			a.onExfiltration(ctx, al)
		}
		a.alertSourceReady()
	}
}

// onExfiltration stops the claim (its running steps end, new ones are
// refused) and reports it to the hub as an unsolicited blocked frame of kind
// security_violation, with the alert kind as signature: the hub marks the
// claim compromised and the Run halts. The machines stay for the hub to
// release: they are the evidence.
func (a *Agent) onExfiltration(ctx context.Context, al Alert) {
	a.m.alerts.Inc(al.Kind)
	c, ok := a.claims.Get(al.ClaimID)
	if !ok || c.State() == claims.Released {
		a.log.Warn("alert.unknown_claim", "claim", al.ClaimID, "kind", al.Kind, "host", al.Host)
		return
	}
	if !c.Compromise(al.Kind) {
		return
	}
	c.Log.Error("claim.compromised", "alarm", true, "kind", al.Kind, "host", al.Host, "at", protocol.FormatTime(al.At))
	signature := al.Kind
	if !protocol.SecurityViolationSignature.MatchString(signature) {
		// The protocol takes an alert kind in lower snake case only.
		signature = "exfiltration"
	}
	body := &protocol.BlockedBody{
		Kind:      protocol.BlockerKindSecurityViolation,
		Signature: signature,
		Message:   "the claim's code sent " + describe(al.Kind) + " to " + al.Host + "; the claim runs nothing more",
	}
	_ = a.deliver(ctx, c, "blocked", body)
}

func describe(kind string) string {
	if kind == "bait_exfiltration" {
		return "a planted bait"
	}
	return "its test credential"
}
