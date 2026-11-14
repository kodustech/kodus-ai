package agent

import (
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// claimRedactor builds the claim's redactor from every value the cell knows
// (S-51): the download token, the transport's keys, the configured secret
// sources.
func (a *Agent) claimRedactor(c *claims.Claim) *redact.Redactor {
	known := []redact.Known{{Label: "download-token", Value: c.Acquire.RepoToken}}
	for _, s := range a.cfg.Secrets {
		known = append(known, s.ClaimSecrets(c.ID)...)
	}
	if a.cfg.ClaimSecrets != nil {
		known = append(known, a.cfg.ClaimSecrets(info(c))...)
	}
	if a.cfg.SQLObservers != nil {
		for _, value := range a.cfg.SQLObservers.ObserverSQLSecrets(c.Machines().Workload.MachineID) {
			known = append(known, redact.Known{Label: "observer-sql", Value: value})
		}
	}
	return redact.New(known...)
}

// redactOutbound is the last pass before a frame leaves the cell (S-51).
func (a *Agent) redactOutbound(c *claims.Claim, body any) {
	r := c.Redactor()
	if r == nil {
		r = redact.New() // token patterns only
	}
	switch b := body.(type) {
	case *protocol.StepResultBody:
		if n := r.StepResult(b); n > 0 {
			c.Log.Warn("redacted", "step", b.StepID, "count", n)
		}
	case *protocol.StepStreamBody:
		r.StepStream(b)
	case *protocol.ClaimFailedBody:
		b.Reason, _ = r.String(b.Reason)
		b.Reason, _ = redact.Clip(b.Reason, redact.MaxReason)
	case *protocol.BlockedBody:
		b.Message, _ = r.String(b.Message)
		b.Message, _ = redact.Clip(b.Message, redact.MaxBlockMessage)
	}
}
