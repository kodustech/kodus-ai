package agent

import (
	"context"
	"encoding/json"
	"path/filepath"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/coverage"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// collectsCoverage: c's boot instruments its Node services (feature
// exercisedLines). Only a Run's claims, PR or base side, on a cell that
// answers claim.exercised and a driver that flushes: never a setup, which a
// bake may keep, nor a sandbox.
func (a *Agent) collectsCoverage(c *claims.Claim) bool {
	return a.cfg.ExercisedLines && a.cfg.Parts.Coverage != nil && c.Acquire.Consumer == protocol.ConsumerRuntime &&
		(c.Acquire.Side == protocol.SidePr || c.Acquire.Side == protocol.SideBase)
}

// instrumentCoverage gives a Run's Node services NODE_V8_COVERAGE and the
// flush preload (the driver mounts the files at Up) and keeps which ones.
// Coverage the cell cannot set up leaves the boot as it was: the answer is
// then unknown, never a failed claim.
func (a *Agent) instrumentCoverage(c *claims.Claim, proj *compose.Project) error {
	if !a.collectsCoverage(c) {
		return nil
	}
	dir, err := claims.WorkDir(a.cfg.WorkDir, c.ID)
	if err != nil {
		return err
	}
	if _, _, err := coverage.Prepare(dir, a.cfg.CoverageCap); err != nil {
		// Never an uncapped directory: the claim boots as with the
		// feature off, and its answer is unknown.
		c.Log.Warn("claim.coverage.uncapped", "err", err)
		return nil
	}
	services, err := proj.AddNodeCoverage(compose.NodeCoverage{Dir: sandbox.CoverageTarget, Preload: sandbox.CoveragePreloadTarget})
	if err != nil {
		return err
	}
	c.SetCoverage(services)
	c.Log.Info("claim.coverage.instrumented", "services", len(services))
	return nil
}

// releaseCoverage takes the cap off the claim's coverage directory before
// the directory is removed.
func (a *Agent) releaseCoverage(c *claims.Claim, dir string) {
	if !a.cfg.ExercisedLines {
		return
	}
	if err := coverage.Release(dir, a.cfg.CoverageCap); err != nil {
		c.Log.Warn("claim.coverage.release_failed", "err", err, "alarm", true)
	}
}

// recoverCoverageCaps unmounts the caps a cell that stopped without its
// releases left under the claims' directories.
func (a *Agent) recoverCoverageCaps() {
	if !a.cfg.ExercisedLines {
		return
	}
	n, err := a.cfg.CoverageCap.Recover(filepath.Join(a.cfg.WorkDir, "claims"))
	if err != nil {
		a.log.Warn("coverage.recover_failed", "err", err, "alarm", true)
	}
	if n > 0 {
		a.log.Info("coverage.recovered", "caps", n)
	}
}

// coverageOf is the claim's coverage files for its Up (zero: none). It
// asks for coverage even with no Node image named: the driver instruments
// the built services whose image runs Node.
func (a *Agent) coverageOf(c *claims.Claim) driver.Coverage {
	services, on := c.Coverage()
	dir, err := claims.WorkDir(a.cfg.WorkDir, c.ID)
	if !on || err != nil {
		return driver.Coverage{}
	}
	return driver.Coverage{Dir: filepath.Join(dir, coverage.DirName), Preload: filepath.Join(dir, coverage.PreloadName), Services: services}
}

// coveredAfterUp keeps the services the driver says the claim's last Up
// instrumented: the ones the agent named and the built ones it found
// running Node.
func (a *Agent) coveredAfterUp(c *claims.Claim, workload driver.MachineRef) {
	if _, on := c.Coverage(); on && a.cfg.Parts.Coverage != nil {
		services := a.cfg.Parts.Coverage.CoverageServices(workload)
		c.SetCoverage(services)
		c.Log.Info("claim.coverage.services", "services", len(services))
	}
}

// claimExercised admits a claim.exercised: which of the PR's changed lines
// the claim's services ran, answered by step.result exercised.
func (a *Agent) claimExercised(tctx context.Context, claimID string, b *protocol.ClaimExercisedBody) error {
	canon, err := json.Marshal(b.Exercised)
	if err != nil {
		return nack("invalid_body", "exercised: %v", err)
	}
	return a.admitStep(stepAdmission{trace: tctx, kind: protocol.MessageTypeClaimExercised, claimID: claimID, stepID: b.StepID, canon: append([]byte("claim.exercised\x00"), canon...)},
		func(ctx context.Context, c *claims.Claim) { a.runExercised(ctx, c, b) })
}

func (a *Agent) runExercised(ctx context.Context, c *claims.Claim, b *protocol.ClaimExercisedBody) {
	workload := c.Machines().Workload
	start := a.clock.Now()
	_, checkout := c.Compose()
	cov := a.coverageOf(c)
	ex := a.coverage.Count(ctx, coverage.Claim{Log: c.Log, Workload: workload, Services: cov.Services, Dir: cov.Dir, Checkout: checkout}, b.Exercised)
	if a.stepCancelled(ctx, c, "claim.exercised", b.StepID, ctx.Err()) {
		return
	}
	d := a.clock.Now().Sub(start).Milliseconds()
	a.sendStepResult(ctx, c, "claim.exercised", &protocol.StepResultBody{
		StepID: b.StepID, Executor: protocol.ExecutorVM, ImageID: workload.ImageID, VMHealth: protocol.VMHealthOk, Exercised: &ex, DurationMs: &d,
	})
}

// flushCoverageBeforeReset has a Run claim's instrumented services write
// what the round ran before the reset recreates them (coverage.Counter
// FlushBeforeReset).
func (a *Agent) flushCoverageBeforeReset(ctx context.Context, c *claims.Claim, workload driver.MachineRef) {
	cov := a.coverageOf(c)
	if len(cov.Services) == 0 {
		return
	}
	a.coverage.FlushBeforeReset(ctx, coverage.Claim{Log: c.Log, Workload: workload, Services: cov.Services, Dir: cov.Dir})
}
