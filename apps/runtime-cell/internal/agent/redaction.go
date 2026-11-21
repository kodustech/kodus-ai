package agent

import (
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// claimRedactor builds the claim's redactor from every value the cell knows
// (S-51): the download tokens (the claim's own and every other
// repository's), the transport's keys, the configured secret sources.
func (a *Agent) claimRedactor(c *claims.Claim) *redact.Redactor {
	return redact.New(a.claimKnown(c)...)
}

// claimKnown is the claim redactor's list: every exact value the cell knows
// of the claim.
func (a *Agent) claimKnown(c *claims.Claim) []redact.Known {
	known := []redact.Known{{Label: "download-token", Value: c.Acquire.RepoToken}}
	for _, r := range c.Acquire.Repos {
		known = append(known, redact.Known{Label: "download-token", Value: r.RepoToken})
	}
	for _, s := range a.cfg.Secrets {
		known = append(known, s.ClaimSecrets(c.ID)...)
	}
	if a.cfg.ClaimSecrets != nil {
		known = append(known, a.cfg.ClaimSecrets(info(c))...)
	}
	if a.cfg.Parts.SQLObservers != nil {
		for _, value := range a.cfg.Parts.SQLObservers.ObserverSQLSecrets(c.Machines().Workload.MachineID) {
			known = append(known, redact.Known{Label: "observer-sql", Value: value})
		}
	}
	return known
}

// bakeSecrets are the values no shared image of a bake may carry: the setup
// claim's redactor's list and its org secrets' placeholders.
func (a *Agent) bakeSecrets(c *claims.Claim) []string {
	var out []string
	for _, k := range a.claimKnown(c) {
		out = append(out, k.Value)
	}
	for _, p := range secretEnv(c) {
		out = append(out, p)
	}
	return out
}

// redactOutbound is the last pass before a frame leaves the cell (S-51),
// with the claim's redactor, or before it is set (the preparation) one of
// the values the claim's sources give now.
func (a *Agent) redactOutbound(c *claims.Claim, body any) {
	r := c.Redactor()
	if r == nil {
		r = a.claimRedactor(c)
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
	case *protocol.ClaimProgressBody:
		b.Lines = redactLines(r, b.Lines)
		b.Phases = redactPhases(r, b.Phases)
	}
}

// redactLines are a step's last lines as they leave the cell: redacted with
// the claim's values, each bounded; nil for none.
func redactLines(r *redact.Redactor, lines []string) []string {
	if len(lines) == 0 {
		return nil
	}
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		clean, _ := r.String(l)
		clean, _ = redact.Clip(clean, redact.MaxBundleLine)
		out = append(out, clean)
	}
	return out
}
