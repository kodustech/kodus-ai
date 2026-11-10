package agent

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/browser"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

func (a *Agent) browserExploreFrame(claimID string, b *protocol.BrowserExploreBody) error {
	if a.cfg.BrowserExplore == nil || !a.hubAccepts(protocol.FeatureBrowserExplore) {
		return nack("browser_explore_unavailable", "browser exploration was not negotiated")
	}
	if err := browser.CheckExploreRequest(b.Request); err != nil {
		return nack("invalid_body", "browser exploration request refused")
	}
	c, ok := a.claims.Get(claimID)
	if !ok || c.State() == claims.Released {
		return nack("unknown_claim", "claim unavailable")
	}
	if c.Acquire.Consumer != protocol.ConsumerRuntime || c.Acquire.Side != protocol.SideBase {
		return nack("exploration_scope", "browser exploration requires the base runtime claim")
	}
	canon, _ := json.Marshal(b.Request)
	return a.admitStep(stepAdmission{kind: protocol.MessageTypeBrowserExplore, claimID: claimID, stepID: b.StepID, canon: append([]byte("browser.explore\x00"), canon...)}, func(ctx context.Context, c *claims.Claim) { a.runBrowserExplore(ctx, c, b) })
}
func (a *Agent) runBrowserExplore(ctx context.Context, c *claims.Claim, b *protocol.BrowserExploreBody) {
	started := a.clock.Now()
	diagnostic := browserExploreDiagnostic{reason: browserExploreNoTarget}
	m := c.Machines()
	redactions := int64(0)
	result := protocol.BrowserExploreResult{Status: protocol.BrowserExploreStatusUnavailable, Candidates: []protocol.BrowserExploreCandidate{}}
	if target, ok := appTarget(c); ok {
		diagnostic.reason = ""
		value, err := (browser.Explorer{Runner: a.cfg.BrowserExplore, Redactor: redactorOf(c), Redactions: &redactions}).Run(ctx, browser.RunSpec{ClaimID: c.ID, Workload: m.Workload.MachineID, Service: target.Service, Port: int(target.Port)}, b.Request)
		if a.stepCancelled(ctx, c, "browser.explore", b.StepID, ctx.Err()) {
			return
		}
		if err == nil {
			result = value
		} else if errors.Is(err, context.DeadlineExceeded) {
			result.Status = protocol.BrowserExploreStatusTimeout
			diagnostic.reason = browserExploreDeadline
		} else if errors.Is(err, browser.ErrJobRefused) {
			result.Status = protocol.BrowserExploreStatusBlocked
			diagnostic.reason = browserExploreRefused
		} else {
			diagnostic.reason = browserExploreRunnerError
		}
	}
	diagnostic.durationMs = max(0, a.clock.Now().Sub(started).Milliseconds())
	a.sendStepResult(ctx, c, "browser.explore", &protocol.StepResultBody{StepID: b.StepID, Executor: protocol.ExecutorObserver, ImageID: m.Workload.ImageID, VMHealth: protocol.VMHealthOk, BrowserExploration: &result, Redactions: &redactions}, diagnostic)
}
