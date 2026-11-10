package agent

import (
	"context"
	"errors"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/browser"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Browser probes (ADR-071): played in the cell's browser runner, a
// container of its own on the claim network, never in the VM and never by
// the observer machine (it cannot start containers). Like the observer's,
// the result is the cell's word on the step, executor and image, and the
// verdict reads it; the artifacts (screenshots, video, trace, HAR, pixel
// diffs) go to the evidence store with the round's grants.

// playsBrowser: a browser probe this cell plays itself. It needs a runner
// and the browser capture, which the hub sends only to a cell that names
// the feature and the cell reads only from a hub that accepts it. Anything
// else goes to the observer, which refuses it (browser_unavailable).
func (a *Agent) playsBrowser(b *protocol.ProbeRunBody) bool {
	return b.Probe.Spec.Browser != nil && a.cfg.Browser != nil && a.evidence.Asked(b.Evidence, protocol.EvidenceCaptureBrowser, protocol.FeatureBrowser)
}

// appTarget is the exposed http service the page loads: the first of the
// claim's expose.
func appTarget(c *claims.Claim) (protocol.Expose, bool) {
	for _, e := range c.Acquire.Expose {
		if e.Kind == protocol.ExposeKindHTTP {
			return e, true
		}
	}
	return protocol.Expose{}, false
}

func (a *Agent) runBrowser(ctx context.Context, c *claims.Claim, b *protocol.ProbeRunBody) {
	m := c.Machines()
	res := &protocol.StepResultBody{StepID: b.StepID, Executor: protocol.ExecutorObserver, ImageID: m.Workload.ImageID, VMHealth: protocol.VMHealthOk}
	target, ok := appTarget(c)
	if !ok {
		// Refused like an observer refusal: no probe field, inconclusive.
		c.Log.Info("probe.refused", "step", b.StepID, "reason", "target_not_exposed: the claim exposes no http service")
		a.sendStepResult(ctx, c, "probe.run", res)
		return
	}
	cap := browser.Capture{Runner: a.cfg.Browser, Redactor: redactorOf(c), Baseline: a.cfg.EvidenceHTTP}
	t0 := a.clock.Now()
	out, err := cap.Run(ctx, browser.Request{
		Evidence: b.Probe.Evidence,
		Probe:    *b.Probe.Spec.Browser,
		Spec:     browser.RunSpec{ClaimID: c.ID, Workload: m.Workload.MachineID, Service: target.Service, Port: int(target.Port)},
		Baseline: b.Evidence.Baseline,
		T0:       t0,
	})
	t1 := a.clock.Now()
	if a.stepCancelled(ctx, c, "probe.run", b.StepID, err) {
		return
	}
	if err != nil {
		var refused *observer.ProbeRefusedError
		if errors.As(err, &refused) {
			c.Log.Info("probe.refused", "step", b.StepID, "reason", refused.Error())
		} else {
			// The runner itself failed (it did not start, it crashed): the
			// round is inconclusive, never a finding about the app.
			c.Log.Warn("browser.unavailable", "step", b.StepID, "err", err)
		}
		a.sendStepResult(ctx, c, "probe.run", res)
		return
	}
	for _, d := range out.Dropped {
		c.Log.Info("browser.artifact.dropped", "step", b.StepID, "why", d)
	}
	p := &protocol.ProbeResult{
		StepID: b.StepID, Executor: "observer", ImageID: m.Workload.ImageID, Transport: protocol.ProbeResultTransportOk,
		Browser: out.Browser, Requests: out.Requests, DurationMs: max(t1.Sub(t0).Milliseconds(), 0),
	}
	// The back-end lanes of the same window (service logs, outbound calls).
	a.evidence.AttachProbe(ctx, evidenceOf(c), b, p, t0, t1)
	var refs []protocol.EvidenceRef
	for _, art := range out.Artifacts {
		if ref := a.evidence.Upload(ctx, evidenceOf(c), b.Evidence, art.Type, art.ContentType, art.Body, art.Truncated, art.Redactions); ref != nil {
			refs = append(refs, *ref)
		}
	}
	if len(refs) > 0 {
		if p.Evidence == nil {
			p.Evidence = &protocol.ProbeEvidence{T0: protocol.FormatTime(t0), WindowMs: max(t1.Sub(t0).Milliseconds(), 0)}
		}
		p.Evidence.Refs = append(p.Evidence.Refs, refs...)
	}
	res.Probe = p
	a.sendStepResult(ctx, c, "probe.run", res)
}
