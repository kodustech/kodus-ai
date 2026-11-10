package agent

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dedup"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// stepAdmission is what admitStep needs to know of a step frame.
type stepAdmission struct {
	kind    protocol.MessageType
	claimID string
	stepID  string
	// canon is the canonical bytes of what the step runs, for the
	// at-most-once rule.
	canon []byte
	// allowHeld: the step may run on a claim held for diagnosis (exec).
	allowHeld bool
}

// admitStep checks everything that can refuse the step, records it for the
// at-most-once rule last (a step recorded and then refused would be acked
// as a duplicate on the hub's retry and never run), acks, and runs work in
// the background once the claim is ready.
func (a *Agent) admitStep(s stepAdmission, work func(context.Context, *claims.Claim)) error {
	c, ok := a.claims.Get(s.claimID)
	if !ok || c.State() == claims.Released {
		return nack("unknown_claim", "%s", s.claimID)
	}
	if why := c.Compromised(); why != "" {
		return nack("claim_compromised", "the claim runs nothing more: %s", why)
	}
	if !s.allowHeld && c.State() == claims.Held {
		return nack("diagnostic_hold", "a claim held for diagnosis runs no %s", s.kind)
	}
	if !a.acceptingWork() {
		return nack("not_accepting", "cell is not accepting work")
	}
	ctx, cancel := context.WithCancel(a.runContext())
	var admissionErr error
	switch a.steps.AdmitIf(s.claimID, s.stepID, s.canon, func() bool {
		admissionErr = c.TryAddStep(s.stepID, cancel, a.cfg.MaxClaimSteps)
		return admissionErr == nil
	}) {
	case dedup.Duplicate:
		cancel()
		return nil // seen: ack, never run again
	case dedup.Conflict:
		cancel()
		a.m.stepConflicts.Inc()
		c.Log.Warn("step.conflict", "step", s.stepID, "kind", s.kind)
		return nack("step_conflict", "stepId %s seen with another command", s.stepID)
	case dedup.Refused:
		if errors.Is(admissionErr, claims.ErrStepCapacity) {
			return nack("step_capacity", "claim active step limit %d reached; no work started", a.cfg.MaxClaimSteps)
		}
		return nack("unknown_claim", "%s", s.claimID)
	}
	c.Log.Info("step.start", "step", s.stepID, "kind", s.kind)
	a.goTracked(func(context.Context) {
		defer func() {
			cancel()
			c.RemoveStep(s.stepID)
		}()
		select {
		case <-c.Settled():
		case <-ctx.Done():
			return
		}
		switch c.State() {
		case claims.Ready:
		case claims.Held:
			if !s.allowHeld {
				return
			}
		default:
			return // failed or released: the claim already reported
		}
		work(ctx, c)
	})
	return nil
}

// stepCancelled reports a step that ended because the hub cancelled it or
// released the claim: nobody waits for its result, so none is sent.
func (a *Agent) stepCancelled(ctx context.Context, c *claims.Claim, kind, stepID string, err error) bool {
	if ctx.Err() == nil {
		return false
	}
	a.m.steps.Inc(kind, "cancelled")
	c.Log.Info("step.cancelled", "step", stepID, "kind", kind, "err", err)
	return true
}

// browserExploreDiagnostic enriches only the completion event. Neither it
// nor a raw runner error becomes part of the frame delivered to the hub.
type browserExploreDiagnostic struct {
	durationMs int64
	reason     browserExploreReason
}
type browserExploreReason string

const (
	browserExploreRunnerError browserExploreReason = "runner_error"
	browserExploreDeadline    browserExploreReason = "deadline_exceeded"
	browserExploreRefused     browserExploreReason = "job_refused"
	browserExploreNoTarget    browserExploreReason = "target_not_exposed"
)

func (r browserExploreReason) safe() string {
	switch r {
	case browserExploreRunnerError, browserExploreDeadline, browserExploreRefused, browserExploreNoTarget:
		return string(r)
	}
	return string(browserExploreRunnerError)
}

// Keep cardinality closed even if a future internal caller bypasses decoding.
func browserExploreOutcome(status protocol.BrowserExploreStatus) string {
	switch status {
	case protocol.BrowserExploreStatusObserved, protocol.BrowserExploreStatusBlocked, protocol.BrowserExploreStatusTimeout, protocol.BrowserExploreStatusUnavailable, protocol.BrowserExploreStatusFailed:
		return string(status)
	}
	return string(protocol.BrowserExploreStatusFailed)
}

// sendStepResult logs and delivers a step.result (redacted, retried).
func (a *Agent) sendStepResult(ctx context.Context, c *claims.Claim, kind string, r *protocol.StepResultBody, diagnostics ...browserExploreDiagnostic) {
	c.CompleteStep(r.StepID)
	attrs := []any{"step", r.StepID, "kind", kind, "executor", r.Executor, "vmHealth", r.VMHealth}
	switch {
	case r.Exec != nil:
		attrs = append(attrs, "exitCode", r.Exec.ExitCode, "durationMs", r.Exec.DurationMs)
	case r.Probe != nil:
		attrs = append(attrs, "transport", r.Probe.Transport, "durationMs", r.Probe.DurationMs)
	case r.BrowserExploration != nil:
		exploration := r.BrowserExploration
		outcome := browserExploreOutcome(exploration.Status)
		duration := exploration.DurationMs
		if len(diagnostics) > 0 {
			duration = max(0, diagnostics[0].durationMs)
			attrs = append(attrs, "runnerDurationMs", exploration.DurationMs)
			if reason := diagnostics[0].reason; reason != "" {
				attrs = append(attrs, "reason", reason.safe())
			}
		}
		attrs = append(attrs, "status", outcome, "durationMs", duration, "cliCalls", exploration.CliCalls, "actionsCompleted", exploration.ActionsCompleted, "candidateCount", len(exploration.Candidates), "truncated", exploration.Truncated)
		a.m.browserExplorations.Inc(outcome)
	case r.DurationMs != nil:
		attrs = append(attrs, "durationMs", *r.DurationMs)
	}
	c.Log.Info("step.result", attrs...)
	a.m.steps.Inc(kind, string(r.VMHealth))
	_ = a.deliver(ctx, c, "step.result", r)
}

func (a *Agent) runProbe(ctx context.Context, frameID string, c *claims.Claim, b *protocol.ProbeRunBody) {
	if a.playsBrowser(b) {
		a.runBrowser(ctx, c, b)
		return
	}
	m := c.Machines()
	targets := observerTargets(c)
	t0 := a.clock.Now()
	res, err := a.observe(ctx, frameID, c, b, targets)
	t1 := a.clock.Now()
	if a.stepCancelled(ctx, c, "probe.run", b.StepID, err) {
		return
	}
	if err != nil {
		// The observer did not answer: the probe is inconclusive.
		c.Log.Warn("observer.unavailable", "step", b.StepID, "err", err)
		res = &protocol.StepResultBody{VMHealth: protocol.VMHealthOk}
	}
	// What the observer says is evidence about the probe, never about which
	// step it answers nor which machine it ran on: the step, the executor
	// and the image are the cell's (S-15, ADR-053).
	if res.StepID != "" && res.StepID != b.StepID {
		c.Log.Error("observer.violation", "step", b.StepID, "answered", res.StepID)
	}
	res.StepID, res.Executor = b.StepID, protocol.ExecutorObserver
	res.ImageID = m.Workload.ImageID
	if res.Probe != nil {
		res.Probe.ImageID = m.Workload.ImageID
		// What the app did in [t0, t1]; never anything the gate compares.
		a.attachProbeEvidence(ctx, c, b, res.Probe, t0, t1)
	}
	a.sendStepResult(ctx, c, "probe.run", res)
}

func (a *Agent) observe(ctx context.Context, frameID string, c *claims.Claim, b *protocol.ProbeRunBody, targets []observer.Target) (*protocol.StepResultBody, error) {
	client, err := a.cfg.Observers(ctx, info(c), targets)
	if err != nil {
		return nil, err
	}
	// The observer gets the database ask only: never the upload grants (it
	// uploads nothing), and nothing at all for a hub that does not take the
	// effects back.
	fwd := *b
	fwd.Evidence = nil
	if a.asked(b.Evidence, protocol.EvidenceCaptureDb, protocol.FeatureDBEffects) {
		fwd.Evidence = &protocol.EvidenceRequest{Capture: []protocol.EvidenceCapture{protocol.EvidenceCaptureDb}}
	}
	frame, err := protocol.Encode(protocol.Header{ID: frameID, CellID: a.cfg.CellID, ClaimID: c.ID}, &fwd)
	if err != nil {
		return nil, err
	}
	res, refused, err := client.Run(ctx, frame)
	if refused != "" {
		c.Log.Info("probe.refused", "step", b.StepID, "reason", refused)
	}
	if err == nil && res == nil {
		err = errors.New("observer answered without a step.result")
	}
	return res, err
}

func (a *Agent) runExec(ctx context.Context, c *claims.Claim, b *protocol.ExecBody, cwd string) {
	// The download token never goes to the VM, not even as a value to mask:
	// the cell redacts the output on its side (S-51).
	req := kodyexec.Request{Command: b.Command, TimeoutMs: b.TimeoutMs, Cwd: cwd, Limits: a.cfg.ExecLimits}
	// kody-exec ends the command at timeoutMs; past that and the grace the
	// VM is not answering.
	ectx, cancel := context.WithTimeout(ctx, time.Duration(b.TimeoutMs)*time.Millisecond+a.cfg.ExecGrace)
	defer cancel()
	workload := c.Machines().Workload
	start := a.clock.Now()
	out, err := a.cfg.Transport.Exec(ectx, workload, req)
	if a.stepCancelled(ctx, c, "exec", b.StepID, err) {
		return
	}
	res := &protocol.StepResultBody{StepID: b.StepID, Executor: protocol.ExecutorVM, ImageID: workload.ImageID, VMHealth: protocol.VMHealthOk}
	if err != nil {
		c.Log.Warn("exec.transport_failed", "step", b.StepID, "err", err)
		res.VMHealth = protocol.VMHealthUnreachable
	} else {
		res.Exec = &protocol.ExecResult{ExitCode: int64(out.ExitCode), Stdout: out.Stdout, Stderr: out.Stderr, Truncated: out.Truncated, DurationMs: out.DurationMs}
		res.Exec.Refs = a.execCast(ctx, c, b, start, out)
	}
	a.sendStepResult(ctx, c, "exec", res)
}

func (a *Agent) runReset(ctx context.Context, c *claims.Claim, b *protocol.MachineResetBody) {
	workload := c.Machines().Workload
	res := &protocol.StepResultBody{StepID: b.StepID, Executor: protocol.ExecutorVM, ImageID: workload.ImageID, VMHealth: protocol.VMHealthOk}
	start := a.clock.Now()
	err := a.cfg.Driver.Reset(ctx, workload, driver.SnapshotRef{Kind: string(b.Snapshot.Kind), Ref: b.Snapshot.Ref})
	if err == nil {
		err = a.composeUpAgain(ctx, c, workload)
	}
	if a.stepCancelled(ctx, c, "machine.reset", b.StepID, err) {
		return
	}
	d := a.clock.Now().Sub(start).Milliseconds()
	attrs := []any{"step", b.StepID, "snapshot", b.Snapshot.Kind}
	if a.cfg.BootTimes != nil && err == nil {
		// The driver's own measure of this reset, when it has one.
		if t, ok := a.cfg.BootTimes.BootTiming(c.ID); ok && t.Kind == "reset" && !t.At.Before(start.Add(-time.Second)) {
			d = t.TotalMs
			attrs = append(attrs, "downMs", t.DownMs, "restoreMs", t.RestoreMs, "upMs", t.UpMs, "seedMs", t.SeedMs, "readyMs", t.ReadyMs)
		}
	}
	res.DurationMs = &d
	if err != nil {
		c.Log.Error("machine.reset", append(attrs, "durationMs", d, "err", err)...)
		// Reset/configuration failure does not establish workload health.
		// A typed nonzero VM control result keeps the round inconclusive.
		res.Exec = &protocol.ExecResult{ExitCode: 1, Stderr: "reset did not complete", DurationMs: d}
	} else {
		c.Log.Info("machine.reset", append(attrs, "durationMs", d)...)
	}
	a.sendStepResult(ctx, c, "machine.reset", res)
}

// composeUpAgain brings a ComposeBooter's project up after a reset (the
// reset took it down) and pushes the egress policy again when the
// containers came back on other addresses.
func (a *Agent) composeUpAgain(ctx context.Context, c *claims.Claim, workload driver.MachineRef) error {
	file, dir := c.Compose()
	if a.cfg.Composer == nil || file == nil {
		return nil
	}
	sources, err := a.cfg.Composer.Up(driver.WithCanaries(ctx, claimCanaries(c.Acquire)), workload, file, dir)
	if err != nil {
		return fmt.Errorf("compose up after reset: %w", err)
	}
	c.SetSources(sources)
	if a.cfg.Egress != nil {
		if err := a.applyEgress(ctx, c); err != nil {
			return fmt.Errorf("egress policy after reset: %w", err)
		}
	}
	// down -v made new containers and volumes: the recipe's steps run again,
	// so the round starts as the first boot did.
	if a.recipeSteps(c) {
		if err := a.runRecipe(ctx, c, workload); err != nil {
			return fmt.Errorf("recipe after reset: %w", err)
		}
	}
	return a.provisionObserverSQL(ctx, c, dir)
}
