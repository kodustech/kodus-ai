package agent

import (
	"context"
	"errors"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/vmsnap"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Memory snapshots of a claim's machine (docs/runtime/isolation-p3-snapshots.md),
// through Config.Parts.Snapshots:
//   - sandbox.acquire prepares: the sandbox becomes its org's template under
//     templateKey when claim.snapshot template asks. Its machine is made as a
//     setup's (no secret, the caller runs no PR code in it) and is not marked
//     as having run untrusted code.
//   - sandbox.acquire templateKey: start from the org's newest template of the
//     key when this cell holds one, else boot as usual (claim.ready start).
//   - sandbox.acquire resumeFrom: a session, restored once.
//   - claim.snapshot round, then machine.reset kind memory: the claim's own
//     machine back at its first ready state on every reset.
// What may become a snapshot is the driver's backend's rule (a machine handed
// secrets never becomes a template or a session), never decided here.

// snapshotPlanOf is what a sandbox.acquire asks of snapshots.
func snapshotPlanOf(b protocol.SandboxAcquireBody) claims.SnapshotPlan {
	var p claims.SnapshotPlan
	if b.Prepares != nil {
		p.Prepares = *b.Prepares
	}
	if b.TemplateKey != nil {
		p.TemplateKey = *b.TemplateKey
	}
	if b.ResumeFrom != nil {
		p.ResumeFrom = *b.ResumeFrom
	}
	return p
}

// sandboxSnapshotOf is the snapshot the sandbox claim starts from: its
// session, or its org's newest template of its key; ok false when it boots.
func (a *Agent) sandboxSnapshotOf(ctx context.Context, c *claims.Claim) (driver.MemorySnapshot, bool, error) {
	p := c.Snapshot
	switch {
	case p.ResumeFrom != "":
		if a.cfg.Parts.Snapshots == nil {
			return driver.MemorySnapshot{}, false, blockerErr(protocol.BlockerKindPlatform, "snapshot_unsupported", errors.New("this cell keeps no memory snapshot"))
		}
		return driver.MemorySnapshot{ID: p.ResumeFrom, OrgID: c.Acquire.OrgID, Purpose: string(protocol.ClaimSnapshotBodyPurposeSession)}, true, nil
	case p.TemplateKey != "" && !p.Prepares && a.cfg.Parts.Snapshots != nil:
		s, ok, err := a.cfg.Parts.Snapshots.LatestTemplate(ctx, c.Acquire.OrgID, p.TemplateKey)
		if err != nil {
			// A template that cannot be read is no reason to fail the
			// sandbox: it boots as one with no template would.
			c.Log.Warn("sandbox.template.unreadable", "err", err)
			return driver.MemorySnapshot{}, false, nil
		}
		return s, ok, nil
	}
	return driver.MemorySnapshot{}, false, nil
}

// claimSnapshot admits a claim.snapshot: the claim's workload kept as a
// snapshot for its purpose.
func (a *Agent) claimSnapshot(tctx context.Context, claimID string, b *protocol.ClaimSnapshotBody) error {
	if a.cfg.Parts.Snapshots == nil {
		return nack("snapshot_unsupported", "this cell's %s driver keeps no memory snapshot", a.cfg.Driver.Kind())
	}
	if c, ok := a.claims.Get(claimID); ok && b.Purpose == protocol.ClaimSnapshotBodyPurposeTemplate && !c.Snapshot.Prepares {
		return nack("not_template_source", "only a sandbox that prepares a template becomes one")
	}
	return a.admitStep(stepAdmission{trace: tctx, kind: protocol.MessageTypeClaimSnapshot, claimID: claimID, stepID: b.StepID, canon: []byte("claim.snapshot\x00" + string(b.Purpose))},
		func(ctx context.Context, c *claims.Claim) { a.runSnapshot(ctx, c, b) })
}

func (a *Agent) runSnapshot(ctx context.Context, c *claims.Claim, b *protocol.ClaimSnapshotBody) {
	workload := c.Machines().Workload
	res := &protocol.StepResultBody{StepID: b.StepID, Executor: protocol.ExecutorVM, ImageID: workload.ImageID, VMHealth: protocol.VMHealthOk}
	start := a.clock.Now()
	key := ""
	if b.Purpose == protocol.ClaimSnapshotBodyPurposeTemplate {
		key = c.Snapshot.TemplateKey
	}
	// The guest agent's stream ends with the machine (a template or a
	// session) or comes back with it (a round): it is dialled again on the
	// next op.
	a.guests.close(c.ID)
	snap, back, err := a.cfg.Parts.Snapshots.SnapshotMachine(ctx, workload, string(b.Purpose), key)
	if a.stepCancelled(ctx, c, "claim.snapshot", b.StepID, err) {
		return
	}
	d := a.clock.Now().Sub(start).Milliseconds()
	if err != nil {
		c.Log.Error("claim.snapshot", "step", b.StepID, "purpose", b.Purpose, "durationMs", d, "err", err)
		// A snapshot the rules or the store's room refuse never touched the
		// machine: it runs on as it was, and the step says so. Any other
		// failure may have ended it (a create that started does).
		if !errors.Is(err, vmsnap.ErrRefused) {
			res.VMHealth = protocol.VMHealthUnreachable
		}
		res.DurationMs = &d
		a.sendStepResult(ctx, c, "claim.snapshot", res)
		return
	}
	if b.Purpose == protocol.ClaimSnapshotBodyPurposeRound {
		c.SetRound(snap)
		c.SetWorkload(back)
	}
	c.Log.Info("claim.snapshot", "step", b.StepID, "purpose", b.Purpose, "snapshot", snap.ID, "durationMs", d)
	res.Snapshot = &protocol.StepResultBodySnapshot{ID: snap.ID, Purpose: b.Purpose, Ms: d}
	a.sendStepResult(ctx, c, "claim.snapshot", res)
}

// resetToRound is machine.reset kind memory: the claim's machine restored
// in its place from its round snapshot, reborn.
func (a *Agent) resetToRound(ctx context.Context, c *claims.Claim, ref string) error {
	round, ok := c.Round()
	if a.cfg.Parts.Snapshots == nil || !ok || round.ID != ref {
		return errors.New("the claim has no such round snapshot")
	}
	a.guests.close(c.ID)
	back, err := a.cfg.Parts.Snapshots.ResetToSnapshot(ctx, c.Machines().Workload, round)
	if err != nil {
		return err
	}
	c.SetWorkload(back)
	return nil
}

// forgetSessions answers snapshot.forget: the org's sessions go now (their
// PR closed or merged), each only if it is a session of that org; one this
// cell does not hold is already gone. The first other failure nacks, so the
// hub keeps the rest to ask again.
func (a *Agent) forgetSessions(ctx context.Context, b protocol.SnapshotForgetBody) error {
	f := a.cfg.Parts.Sessions
	if f == nil {
		return nack("snapshot_unsupported", "this cell keeps no memory snapshot")
	}
	for _, id := range b.SnapshotIds {
		if err := f.ForgetSession(ctx, b.OrgID, id); err != nil {
			a.log.Warn("snapshot.forget.failed", "org", b.OrgID, "snapshot", id, "err", err)
			return nack("forget_failed", "%s: %v", id, err)
		}
	}
	a.log.Info("snapshot.forget", "org", b.OrgID, "sessions", len(b.SnapshotIds))
	return nil
}
