package agent

import (
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/evidence"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

func redactorOf(c *claims.Claim) *redact.Redactor {
	if r := c.Redactor(); r != nil {
		return r
	}
	return redact.New() // token patterns only
}

// evidenceOf is the claim as the evidence collector sees it.
func evidenceOf(c *claims.Claim) evidence.Claim {
	return evidence.Claim{ID: c.ID, Log: c.Log, Workload: c.Machines().Workload, Redactor: redactorOf(c)}
}
