package agent

import (
	"context"
	"errors"
	"slices"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/telemetry"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// hardCeiling is the absolute lifetime per consumer (§10, S-08).
func hardCeiling(c protocol.Consumer) time.Duration {
	switch c {
	case protocol.ConsumerRuntime:
		return 60 * time.Minute
	case protocol.ConsumerMcp:
		return 4 * time.Hour
	case protocol.ConsumerPreview:
		// One start of a preview (HARD_EXPIRY_MINUTES.preview, docs/runtime/preview-urls.md §5.2).
		return 120 * time.Minute
	case protocol.ConsumerSetup, protocol.ConsumerCustomAgent, protocol.ConsumerSandbox:
		// the default ceiling below
	}
	return 45 * time.Minute // setup, custom_agent, sandbox, and anything newer
}

func (a *Agent) acquire(tctx context.Context, claimID string, acq protocol.ClaimAcquireBody) error {
	return a.acquireWith(tctx, claimID, acq, claims.SnapshotPlan{})
}

// acquireWith is acquire with what the claim asks of memory snapshots.
func (a *Agent) acquireWith(tctx context.Context, claimID string, acq protocol.ClaimAcquireBody, plan claims.SnapshotPlan) error {
	generation, available := a.alertAdmissionSnapshot()
	if !available || !a.deadman.Accepting() {
		return nack("not_accepting", "cell cannot accept work")
	}
	if claimID == "" {
		return nack("invalid_envelope", "claim.acquire without claimId")
	}
	hard, err := protocol.ParseTime(acq.HardExpiresAt)
	if err != nil {
		return nack("invalid_body", "hardExpiresAt")
	}
	now := a.clock.Now()
	if !hard.After(now) {
		return nack("ceiling_passed", "hardExpiresAt is in the past")
	}
	if hard.After(now.Add(hardCeiling(acq.Consumer) + time.Minute)) {
		return nack("ceiling_exceeded", "hardExpiresAt past the %s ceiling", acq.Consumer)
	}
	if acq.DiagnosticHold != nil && *acq.DiagnosticHold && (acq.Consumer != protocol.ConsumerSetup || acq.Side == protocol.SidePr) {
		return nack("diagnostic_hold_refused", "only a setup claim that is not a PR can be held for diagnosis")
	}
	if acq.SeedsCache != nil && *acq.SeedsCache && (acq.Consumer != protocol.ConsumerSetup || acq.Side == protocol.SidePr) {
		return nack("seeds_cache_refused", "only a setup claim that is not a PR can seed the build cache (S-52)")
	}
	run := ""
	if acq.RunID != nil {
		run = *acq.RunID
	}
	// "latest" is the environment's last bake here, fixed now for the whole
	// claim: a machine made for it and a pool machine it adopts carry that
	// image, and every step result names it, so a Run can check its base and
	// PR ran on the same bake. Before any bake here it stays "latest".
	if acq.ImageID == latestImage && acq.Consumer != protocol.ConsumerSetup {
		if id := a.origin.Latest(acq.OrgID, acq.EnvironmentID); id != "" {
			acq.ImageID = id
		}
	}
	if _, held := a.claims.Get(claimID); held {
		return a.rejoin(claimID, acq)
	}
	// Memory first (ADR-070): a claim that does not fit is refused before it
	// takes a slot or anything is made, and the worker asks again later.
	// Refused only to a hub that accepts cellMemory: an older hub reads the
	// nack as the claim's failure, not a wait, so it keeps the old behavior.
	need, counted := 0, false
	if a.mem != nil {
		need = a.claimMemoryNeed(acq, a.hasPoolMachine(acq, hard))
		ok, fresh, free := a.mem.Admit(claimID, need, a.cfg.RequireMemoryAdmission || a.hubAccepts(protocol.FeatureCellMemory))
		if !ok {
			a.log.Info("claim.no_capacity", "claim", claimID, "run", run, "side", acq.Side, "needMb", need, "freeMb", free, "allocatableMb", a.mem.Allocatable())
			return nack("no_capacity", "the claim needs %d MB of memory and %d of the cell's %d MB are free", need, max(free, 0), a.mem.Allocatable())
		}
		counted = fresh
	}
	// The claim's span: a child of the hub's acquire span, ended when the preparation settles.
	// Every line of the claim's logger carries its trace and span (telemetry.LogIDs).
	sctx, span := telemetry.Tracer().Start(tctx, "cell.claim.acquire", trace.WithAttributes(
		telemetry.ID(telemetry.ClaimID, claimID), telemetry.ID(telemetry.RunID, run), telemetry.ID(telemetry.OrganizationID, acq.OrgID),
		telemetry.ID(telemetry.EnvironmentID, acq.EnvironmentID), attribute.String(telemetry.ClaimSide, string(acq.Side)), attribute.String(telemetry.ClaimConsumer, string(acq.Consumer))))
	started := false
	defer func() {
		if !started {
			span.End()
		}
	}()
	// The claim's logger never carries the repo token or a key.
	c := claims.New(claimID, acq, a.log.With(append([]any{"claim", claimID, "run", run}, telemetry.LogIDs(sctx)...)...), now)
	// A rejoin keeps the first round's placeholders: these are dropped with c.
	secrets, droppedSecrets, err := a.orgSecretsFor(acq)
	if err != nil {
		if counted {
			a.mem.Forget(claimID)
		}
		return nack("internal", "secret placeholders: %v", err)
	}
	c.OrgSecrets = secrets
	c.Snapshot = plan
	switch err := a.claims.Add(c); {
	case errors.Is(err, claims.ErrExists):
		if counted {
			a.mem.Forget(claimID)
		}
		return a.rejoin(claimID, acq)
	case errors.Is(err, claims.ErrFull):
		if counted {
			a.mem.Forget(claimID)
		}
		return nack("no_capacity", "cell is full")
	}
	// Source loss can race registry insertion, even if it recovers before
	// this check. Never start work admitted under an earlier generation.
	if !a.alertAdmissionCurrent(generation) {
		c.Release()
		c.FinishPrepare() // bringUp will never own this claim.
		a.goTracked(func(ctx context.Context) { a.cleanup(ctx, c, "alert_source_unavailable") })
		return nack("not_accepting", "cell cannot accept work")
	}
	if counted {
		a.nudgeHeartbeat()
	}
	a.observeClaims()
	c.Log.Info("claim.acquire", "org", acq.OrgID, "environment", acq.EnvironmentID, "side", acq.Side, "consumer", acq.Consumer,
		"sha", acq.Sha, "imageId", acq.ImageID, "expose", len(acq.Expose), "hardExpiresAt", acq.HardExpiresAt, "size", claimSize(acq).String(), "memoryMb", need,
		"secrets", len(secrets))
	if len(droppedSecrets) > 0 {
		// By id and reason only: the machines never see these.
		c.Log.Warn("claim.secrets.dropped", "secrets", droppedSecrets)
	}
	started = true
	a.goTracked(func(ctx context.Context) {
		defer span.End()
		a.bringUp(ctx, c, hard)
	})
	return nil
}

// rejoin answers a claim.acquire of a claim this cell already holds: the
// hub lost the first round (its replica restarted, the worker retried the
// step) and asks again. The same claim, still booting, is joined: the ack
// stands and the preparation already running settles it (claim.ready or
// claim.failed, resent until acked). Already ready, its claim.ready goes
// out again. Anything else (another org, environment, commit or kind, or a
// claim that failed, is held or was released) is refused as before.
func (a *Agent) rejoin(claimID string, acq protocol.ClaimAcquireBody) error {
	c, ok := a.claims.Get(claimID)
	if !ok {
		return nack("claim_exists", "%s", claimID)
	}
	was := c.Acquire
	if was.OrgID != acq.OrgID || was.EnvironmentID != acq.EnvironmentID || was.Sha != acq.Sha || was.Side != acq.Side || was.Consumer != acq.Consumer || !sameRepos(was.Repos, acq.Repos) {
		return nack("claim_exists", "%s", claimID)
	}
	switch c.State() {
	case claims.Acquiring:
		c.Log.Info("claim.rejoined", "state", "acquiring")
		return nil
	case claims.Ready:
		c.Log.Info("claim.rejoined", "state", "ready")
		a.goTracked(func(ctx context.Context) {
			if err := a.deliver(ctx, c, "claim.ready", a.readyBody(c)); err != nil {
				c.Log.Warn("claim.rejoin.ready_failed", "err", err)
			}
		})
		return nil
	case claims.Failed, claims.Held, claims.Released:
		// nothing to rejoin: refused below
	}
	return nack("claim_exists", "%s", claimID)
}

// sameRepos is whether two acquires name the same other repositories, each
// in the same directory at the same commit (their tokens may be new ones).
func sameRepos(a, b []protocol.ClaimAcquireBodyReposItem) bool {
	return slices.EqualFunc(a, b, func(x, y protocol.ClaimAcquireBodyReposItem) bool {
		return x.Alias == y.Alias && x.Repo == y.Repo && x.Sha == y.Sha
	})
}
