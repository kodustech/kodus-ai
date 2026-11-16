package agent

import (
	"context"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Alert is one injector or proxy alert: a claim's test credential, or a
// bait the cell planted, left for a host it was not issued for; or a secret
// placeholder sent over plain HTTP (the proxy's placeholder_leak).
type Alert struct {
	Seq     int64
	ClaimID string
	Host    string
	// Kind is credential_exfiltration, bait_exfiltration or placeholder_leak.
	Kind string
	At   time.Time
}

// AlertSource long-polls alerts after a sequence number.
type AlertSource interface {
	Alerts(ctx context.Context, after int64) ([]Alert, error)
}

// alertRetry is the wait after a failed poll.
const alertRetry = 5 * time.Second

// watchAlerts turns every alert of feed i into a blocker on its claim
// until ctx ends.
func (a *Agent) watchAlerts(ctx context.Context, i int) {
	src := a.alertSources[i]
	var after int64
	for ctx.Err() == nil {
		got, err := src.Alerts(ctx, after)
		if err != nil {
			if ctx.Err() == nil {
				a.alertSourceFailedAt(i, err)
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
		a.alertSourceReadyAt(i)
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
	switch kind {
	case "bait_exfiltration":
		return "a planted bait"
	case "placeholder_leak":
		return "a secret's placeholder over plain HTTP"
	}
	return "its test credential"
}
