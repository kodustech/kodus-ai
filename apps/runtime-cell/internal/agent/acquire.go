package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/outbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/transport"
)

// hardCeiling is the absolute lifetime per consumer (§10, S-08).
func hardCeiling(c protocol.Consumer) time.Duration {
	switch c {
	case protocol.ConsumerRuntime:
		return 60 * time.Minute
	case protocol.ConsumerMcp:
		return 4 * time.Hour
	}
	return 45 * time.Minute // setup, custom_agent, and anything newer
}

func (a *Agent) acquire(claimID string, acq protocol.ClaimAcquireBody) error {
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
		a.mu.Lock()
		if id := a.latestBake[poolKey{acq.OrgID, acq.EnvironmentID}]; id != "" {
			acq.ImageID = id
		}
		a.mu.Unlock()
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
		ok, fresh, free := a.mem.admit(claimID, need, a.cfg.RequireMemoryAdmission || a.hubAccepts(protocol.FeatureCellMemory))
		if !ok {
			a.log.Info("claim.no_capacity", "claim", claimID, "run", run, "side", acq.Side, "needMb", need, "freeMb", free, "allocatableMb", a.mem.allocatable)
			return nack("no_capacity", "the claim needs %d MB of memory and %d of the cell's %d MB are free", need, max(free, 0), a.mem.allocatable)
		}
		counted = fresh
	}
	// The claim's logger never carries the repo token or a key.
	c := claims.New(claimID, acq, a.log.With("claim", claimID, "run", run), now)
	switch err := a.claims.Add(c); {
	case errors.Is(err, claims.ErrExists):
		if counted {
			a.mem.forget(claimID)
		}
		return a.rejoin(claimID, acq)
	case errors.Is(err, claims.ErrFull):
		if counted {
			a.mem.forget(claimID)
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
		"sha", acq.Sha, "imageId", acq.ImageID, "expose", len(acq.Expose), "hardExpiresAt", acq.HardExpiresAt, "size", claimSize(acq).String(), "memoryMb", need)
	a.goTracked(func(ctx context.Context) { a.bringUp(ctx, c, hard) })
	return nil
}

// bringUp prepares the claim and settles it on the hub: claim.ready, or
// claim.failed (with a held claim's machines kept for diagnosis).
func (a *Agent) bringUp(ctx context.Context, c *claims.Claim, hard time.Time) {
	pctx, cancel := context.WithDeadline(ctx, hard)
	defer cancel()
	if !c.SetPrepareCancel(cancel) {
		c.FinishPrepare()
		a.cleanupReleased(ctx, c)
		return
	}
	err := a.prepare(pctx, c, hard)
	c.FinishPrepare()
	// Before cleanup forgets the claim's keys (S-51).
	r := a.claimRedactor(c)
	if err == nil {
		if !c.MarkReady(a.clock.Now(), r) {
			a.cleanupReleased(ctx, c)
			return
		}
		a.observeClaims()
		a.countReady(c)
		body := a.readyBody(c)
		c.Log.Info("claim.ready", timingAttrs(body.Timing)...)
		if err := a.deliver(ctx, c, "claim.ready", body); err != nil {
			var n *hubclient.NackError
			if errors.Is(err, protocol.ErrRefusedToSend) {
				// A ready body the protocol refuses (a bug of this cell): the hub
				// hears a failure now instead of waiting out the boot.
				a.cleanup(ctx, c, "ready_refused")
				_ = a.deliver(ctx, c, "claim.failed", failedBody(blockerErr(protocol.BlockerKindPlatform, "claim_ready_refused", err)))
				return
			}
			if errors.As(err, &n) {
				// The hub no longer waits for this claim (it timed out, the
				// connection it went out on dropped): nothing will use it.
				a.cleanup(ctx, c, "ready_nacked")
			}
		}
		return
	}
	c.Log.Error("claim.failed", "err", err, "prepareMs", a.clock.Now().Sub(c.AcquiredAt).Milliseconds())
	body := failedBody(err)
	c.SetRedactor(r)
	if a.isCleanSetupClaim(c) && c.Machines().Workload.MachineID != "" {
		body.Bundle = a.collectBundle(ctx, c, err)
	}
	if until, ok := a.startHold(ctx, c, hard); ok {
		if !c.MarkFailed(err, r, until) {
			a.cleanupReleased(ctx, c)
			return
		}
		a.observeClaims()
		// Its builds are over: the held machines are counted as a ready claim's.
		a.countReady(c)
		held := true
		body.Held = &held
		_ = a.deliver(ctx, c, "claim.failed", body)
		return
	}
	if !c.MarkFailed(err, r, time.Time{}) {
		a.cleanupReleased(ctx, c)
		return
	}
	a.observeClaims()
	// Clean up first: when the hub reads claim.failed nothing of the
	// claim is left on the cell.
	a.cleanup(ctx, c, "failed")
	_ = a.deliver(ctx, c, "claim.failed", body)
}

// cleanupReleased tears down a claim released while it was prepared. A
// release that stopped waiting for the preparation already cleaned up; what
// the preparation created after that is in the lease, released here.
func (a *Agent) cleanupReleased(ctx context.Context, c *claims.Claim) {
	a.cleanup(ctx, c, "released")
	if err := a.leases.Release(context.WithoutCancel(ctx), c.ID); err != nil && !errors.Is(err, lease.ErrUnknownClaim) {
		c.Log.Warn("claim.cleanup.machines", "err", err)
	}
}

// deliver redacts a claim frame (S-51) and hands it to the outbox: sent
// until acked, while the claim is still wanted.
func (a *Agent) deliver(ctx context.Context, c *claims.Claim, kind string, body any) error {
	a.redactOutbound(c, body)
	wanted := func() bool { return c.State() != claims.Released && a.allowAlertDelivery(kind) }
	if kind == "claim.failed" {
		wanted = nil // sent after the cleanup by design
	}
	return a.outbox.Deliver(ctx, outbox.Frame{ClaimID: c.ID, Kind: kind, Body: body, Log: c.Log, Wanted: wanted})
}

func timingAttrs(t *protocol.ReadyTiming) []any {
	if t == nil {
		return nil
	}
	out := []any{"prepareMs", t.PrepareMs}
	for _, f := range []struct {
		k string
		v *int64
	}{{"bootMs", t.BootMs}, {"buildMs", t.BuildMs}, {"upMs", t.UpMs}, {"seedMs", t.SeedMs}, {"readyMs", t.ReadyMs}, {"snapshotMs", t.SnapshotMs}} {
		if f.v != nil {
			out = append(out, f.k, *f.v)
		}
	}
	return out
}

// prepare creates the claim's network, its two machines, brings the code in
// and pushes the egress policy. ctx ends at the claim's ceiling or when the
// claim is released.
func (a *Agent) prepare(ctx context.Context, c *claims.Claim, hard time.Time) error {
	acq := c.Acquire
	mark := a.clock.Now()
	var tail *progressTail
	phase := func(name string) {
		now := a.clock.Now()
		ms := now.Sub(mark).Milliseconds()
		c.Log.Info("claim.phase", "phase", name, "ms", ms)
		var lines []string
		if tail != nil {
			lines, tail = tail.snapshot(), nil
		}
		a.progress(c, name, protocol.ClaimProgressBodyStateDone, &ms, lines)
		mark = now
	}
	// started tells the hub a long phase began; its output, while it runs,
	// goes out with it every few seconds (driver.WithOutput on bctx).
	started := func(name string) context.Context {
		a.progress(c, name, protocol.ClaimProgressBodyStateStarted, nil, nil)
		tail = &progressTail{now: a.clock.Now, send: func(lines []string) {
			a.progress(c, name, protocol.ClaimProgressBodyStateStarted, nil, lines)
		}}
		return driver.WithOutput(ctx, tail.line)
	}
	// A size above what this cell grants is refused before anything is
	// made: a claim never gets more than the cell's maximum.
	size := claimSize(acq)
	if err := size.Within(a.cfg.Driver.Capabilities().MaxClaimSize); err != nil {
		return blockerErr(protocol.BlockerKindResources, "size_unavailable", err)
	}
	key, err := a.cfg.OrgKey(acq.OrgID)
	if err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "org_key", err)
	}
	expose := make([]driver.ExposePort, 0, len(acq.Expose))
	for _, e := range acq.Expose {
		expose = append(expose, driver.ExposePort{Service: e.Service, Port: int(e.Port), Kind: string(e.Kind)})
	}
	// A ready pool machine of the environment is the claim's network and
	// workload; one that cannot be adopted is discarded, and the claim
	// makes its own.
	var pooled *driver.PoolMachine
	if m, ok := a.takePoolMachine(acq, hard); ok {
		if err := a.cfg.Pooler.Adopt(ctx, m, c.ID); err != nil {
			c.Log.Warn("claim.pool.adopt_failed", "machine", m.Workload.MachineID, "err", err)
			a.discardPoolMachine(m, "adopt_failed")
		} else {
			pooled = &m
			a.m.pool.Inc("adopted")
			c.Log.Info("claim.pool.adopted", "machine", m.Workload.MachineID)
			a.refillPool(poolKey{acq.OrgID, acq.EnvironmentID})
		}
	}
	// A base that boots a bake this cell made stays at its ready size (claimMemoryNeed):
	// its build reuses the bake's layers. Any other claim without a pool machine builds.
	if pooled == nil && !(acq.Side == protocol.SideBase && a.bootsLocalBake(acq)) {
		a.countBoot(c)
	}
	var net driver.ClaimNetwork
	if pooled != nil {
		net = pooled.Network
	} else if net, err = a.cfg.Driver.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: a.cfg.CellID, OrgID: acq.OrgID, ClaimID: c.ID, Expose: expose}); err != nil {
		return blockerErr(protocol.BlockerKindResources, "claim_network", err)
	}
	c.SetNetwork(net)
	phase("network")
	expires := initialExpiry(a.clock.Now(), a.cfg.InitialLease, acq.LeaseExpiresAt)
	if expires.After(hard) {
		expires = hard
	}
	l := lease.Lease{ClaimID: c.ID, OrgID: acq.OrgID, Network: net, ExpiresAt: expires, HardExpiresAt: hard}
	a.leases.Track(l)
	base := driver.MachineSpec{
		CellID: a.cfg.CellID, EnvironmentID: acq.EnvironmentID, OrgID: acq.OrgID, ClaimID: c.ID,
		ImageID: acq.ImageID, ImageRef: acq.ImageID, KMSKeyRef: key, ExpiresAt: expires, HardExpiresAt: hard,
	}
	work := base
	work.Role, work.Size, work.ClaimGroupID = driver.RoleWorkload, a.cfg.WorkloadSize, net.WorkloadGroupID
	// The claim's size is its workload's: the observer keeps the cell's.
	work.ClaimSize = size
	// Only a setup's workload may write what the environment keeps (S-52).
	work.Setup = acq.Consumer == protocol.ConsumerSetup && acq.Side != protocol.SidePr
	work.SeedsCache = work.Setup && acq.SeedsCache != nil && *acq.SeedsCache
	if a.cfg.Keys != nil {
		if work.UserData, err = a.cfg.Keys.PrepareClaim(c.ID); err != nil {
			return blockerErr(protocol.BlockerKindPlatform, "claim_keys", err)
		}
	}
	var workload driver.MachineRef
	if pooled != nil {
		// The pool machine keeps its pool tags; its expiry follows the
		// claim's lease from now on (renewed with it, under its ceiling).
		workload = pooled.Workload
		if err := a.cfg.Driver.SetExpiry(ctx, workload, expires); err != nil {
			return blockerErr(protocol.BlockerKindResources, "create_workload", err)
		}
	} else if workload, err = a.cfg.Driver.Create(ctx, work); err != nil {
		if errors.Is(err, driver.ErrSizeUnavailable) {
			return blockerErr(protocol.BlockerKindResources, "size_unavailable", err)
		}
		return blockerErr(protocol.BlockerKindResources, "create_workload", err)
	}
	c.SetWorkload(workload)
	if acq.Side == protocol.SidePr {
		// From here on the machine runs PR code: destroyed on release,
		// never baked, snapshotted or pooled (S-52).
		a.taint(workload)
	}
	l.Machines = append(l.Machines, workload)
	a.leases.Track(l)
	obs := base
	obs.Role, obs.Size, obs.ClaimGroupID = driver.RoleObserver, a.cfg.ObserverSize, net.ObserverGroupID
	observerRef, err := a.cfg.Driver.Create(ctx, obs)
	if err != nil {
		return blockerErr(protocol.BlockerKindResources, "create_observer", err)
	}
	c.SetObserver(observerRef)
	l.Machines = append(l.Machines, observerRef)
	a.leases.Track(l)
	phase("machines")

	// The code: tarball by API, extraction with no network, upload, revoke.
	url, err := a.cfg.Repo(acq)
	if err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "repo_source", err)
	}
	dir, err := claims.WorkDir(a.cfg.WorkDir, c.ID)
	if err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "workdir", err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "workdir", err)
	}
	if a.cfg.Composer == nil {
		defer os.RemoveAll(dir)
	} // else the checkout is the compose project's directory until cleanup
	repo := filepath.Join(dir, "repo")
	started("fetch")
	if _, err := tarball.FetchExtractRevoke(ctx, tarball.FetchOptions{URL: url, Token: acq.RepoToken, Dest: repo, WorkDir: dir, Extractor: a.cfg.Extractor, Revoker: a.cfg.Revoker}); err != nil {
		// The extractor refused an entry of the repository (a link out of it, a
		// .git entry): the repository's to change, not a retry. The isolated
		// extractor reports it as text.
		if strings.Contains(err.Error(), "tarball: refused ") {
			return blockerErr(protocol.BlockerKindToolchain, "repo_refused", err)
		}
		return blockerErr(protocol.BlockerKindPlatform, "repo_fetch", err)
	}
	// Kody's build files first, into a .kodus this cell checked is a real
	// directory: the recipe then goes into the same one.
	if err := writeAuthoredFiles(repo, acq.Recipe); err != nil {
		return blockerErr(protocol.BlockerKindToolchain, "authored_files", err)
	}
	if err := applyRecipe(repo, acq.Recipe); err != nil {
		return blockerErr(protocol.BlockerKindRecipeOutdated, "recipe_apply", err)
	}
	// Validate the base recipe before Upload: local-docker may build there,
	// while compose drivers build later in Up.
	if err := a.checkRecipeRequirements(c, repo); err != nil {
		return err
	}
	// What go.sum pins is all the mirror serves this claim for Go.
	if pins, err := goSumPins(repo); err != nil {
		c.Log.Warn("mirror.go_pins", "err", err)
	} else {
		c.SetGoPins(pins)
	}
	// What the Dockerfiles name is all the mirror serves this claim from Docker Hub.
	if pins, err := dockerfileImagePins(repo); err != nil {
		c.Log.Warn("mirror.image_pins", "err", err)
	} else {
		c.SetImagePins(pins)
	}
	phase("fetch")
	// The upload is also where a driver that boots from the checkout boots it
	// (local-docker): its phases are in claim.ready.timing.
	if err := a.cfg.Transport.Upload(started("upload"), workload, repo, transport.Workspace); err != nil {
		if errors.Is(err, driver.ErrWorkloadBoot) {
			return blockerErr(protocol.BlockerKindToolchain, "compose_up", err)
		}
		if errors.Is(err, driver.ErrWorkloadRecipe) {
			return blockerErr(protocol.BlockerKindRecipeOutdated, "recipe_load", err)
		}
		return blockerErr(protocol.BlockerKindPlatform, "repo_upload", err)
	}
	phase("upload")
	if a.cfg.Composer != nil {
		// A project that builds fetches during Up (the builder sits at an
		// address of the claim network's own Sources): its policy is in
		// place before, and pushed again below with the containers' addresses.
		if a.cfg.Egress != nil {
			if err := a.pushEgressBeforeUp(ctx, c); err != nil {
				return blockerErr(protocol.BlockerKindPlatform, "egress_policy", err)
			}
		}
		if err := a.bootCompose(started("compose"), c, workload, repo); err != nil {
			return err
		}
		phase("compose")
	}

	if a.cfg.Egress != nil {
		if err := a.applyEgress(ctx, c); err != nil {
			return blockerErr(protocol.BlockerKindPlatform, "egress_policy", err)
		}
		phase("egress")
	}
	// The recipe's setup, migrate and seed, once the policy names the
	// containers they run in: a setup command may fetch.
	if a.recipeSteps(c) {
		if err := a.runRecipe(started("recipe"), c, workload); err != nil {
			return err
		}
		phase("recipe")
	}
	return a.provisionObserverSQL(ctx, c, repo)
}

// recipeSteps is true when the claim's driver runs the recipe's boot steps
// and the recipe it booted has some.
func (a *Agent) recipeSteps(c *claims.Claim) bool {
	if _, ok := a.cfg.Composer.(driver.RecipeRunner); !ok {
		return false
	}
	file, dir := c.Compose()
	if file == nil {
		return false
	}
	rec, err := recipe.Load(dir)
	return err == nil && rec != nil && rec.HasBootSteps()
}

// runRecipe runs the recipe's boot steps through the driver; a failed step
// is the repository's blocker, named after it.
func (a *Agent) runRecipe(ctx context.Context, c *claims.Claim, workload driver.MachineRef) error {
	_, dir := c.Compose()
	err := a.cfg.Composer.(driver.RecipeRunner).RunRecipe(ctx, workload, dir)
	var step *driver.RecipeStepError
	switch {
	case err == nil:
		return nil
	case errors.Is(err, driver.ErrOutOfMemory):
		return blockerErr(protocol.BlockerKindResources, "out_of_memory", err)
	case errors.As(err, &step) && step.Step == "setup":
		return blockerErr(protocol.BlockerKindToolchain, "recipe_setup", err)
	case errors.As(err, &step):
		return blockerErr(protocol.BlockerKindSeedData, "recipe_"+step.Step, err)
	case errors.Is(err, driver.ErrWorkloadRecipe):
		return blockerErr(protocol.BlockerKindRecipeOutdated, "recipe_load", err)
	}
	return blockerErr(protocol.BlockerKindPlatform, "recipe_steps", err)
}

// bootCompose brings the claim's compose project up through the driver
// (Config.Composer) from the checkout's recipe and compose files, and keeps
// the containers' addresses as the claim's egress Sources.
func (a *Agent) bootCompose(ctx context.Context, c *claims.Claim, workload driver.MachineRef, repo string) error {
	rec, err := recipe.Load(repo)
	if err != nil {
		return blockerErr(protocol.BlockerKindRecipeOutdated, "recipe_load", err)
	}
	proj, err := loadClaimCompose(c, repo, rec)
	if err != nil {
		return err
	}
	// The Run's decoys (ADR-043): the config slot in every service's env,
	// after the recipe's so no recipe can hide it; the driver plants the
	// rest (the credentials file) at Up.
	canaries := claimCanaries(c.Acquire)
	if err := proj.AddEnvironment(driver.CanaryEnvOf(canaries)); err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "compose_load", err)
	}
	file, err := proj.Marshal()
	if err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "compose_load", err)
	}
	c.SetCompose(file, repo)
	sources, err := a.cfg.Composer.Up(driver.WithCanaries(ctx, canaries), workload, file, repo)
	if errors.Is(err, driver.ErrOutOfMemory) {
		return blockerErr(protocol.BlockerKindResources, "out_of_memory", err)
	}
	// A driver may run the recipe's seed inside Up, before the app starts
	// (docker-gvisor's golden data): its failure is the seed's.
	var step *driver.RecipeStepError
	if errors.As(err, &step) {
		return blockerErr(protocol.BlockerKindSeedData, "recipe_"+step.Step, err)
	}
	if err != nil {
		return blockerErr(protocol.BlockerKindToolchain, "compose_up", err)
	}
	c.SetSources(sources)
	c.Log.Info("compose.up", "containers", len(sources))
	return nil
}

// claimSize is the machine size the claim asked (claim.acquire size), zero
// when it asked none.
func claimSize(acq protocol.ClaimAcquireBody) driver.ClaimSize {
	if acq.Size == nil {
		return driver.ClaimSize{}
	}
	return driver.ClaimSize{MemoryMB: int(acq.Size.MemoryMb), CPUs: int(acq.Size.Cpus)}
}

// blockerError is a prepare failure with the Blocker kind and signature
// claim.failed reports.
type blockerError struct {
	kind      protocol.BlockerKind
	signature string
	err       error
}

func (e *blockerError) Error() string { return e.signature + ": " + e.err.Error() }
func (e *blockerError) Unwrap() error { return e.err }

func blockerErr(kind protocol.BlockerKind, signature string, err error) error {
	// A driver's failed host boundary is the cell's failure even when a
	// compose/recipe wrapper also marks it as a workload boot failure.
	if errors.Is(err, driver.ErrResourceCleanupPending) {
		kind, signature = protocol.BlockerKindPlatform, "resource_cleanup_pending"
	} else if errors.Is(err, driver.ErrResourceEnforcement) {
		kind, signature = protocol.BlockerKindPlatform, "resource_enforcement_unavailable"
	}
	return &blockerError{kind: kind, signature: signature, err: err}
}

// failedBody is claim.failed: what blocked the claim, by kind and signature.
func failedBody(err error) *protocol.ClaimFailedBody {
	reason, _ := redact.ClipMiddle(err.Error(), redact.MaxReason)
	b := &protocol.ClaimFailedBody{Kind: protocol.BlockerKindUnknown, Signature: "claim", Reason: reason}
	var be *blockerError
	if errors.As(err, &be) {
		b.Kind, b.Signature = be.kind, be.signature
	}
	return b
}

// initialExpiry is the machines' first kodus:expires: the lease the hub keeps
// for the claim when the acquire carries it (a setup's 30 minutes: a long
// build is not swept while it runs), else the cell's own initial lease. A
// lease in the past, or unreadable, falls back to the initial one; the caller
// still holds it under hardExpiresAt.
func initialExpiry(now time.Time, initial time.Duration, lease *string) time.Time {
	fallback := now.Add(initial)
	if lease == nil {
		return fallback
	}
	at, err := time.Parse(time.RFC3339Nano, *lease)
	if err != nil || !at.After(now) {
		return fallback
	}
	return at
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
	if was.OrgID != acq.OrgID || was.EnvironmentID != acq.EnvironmentID || was.Sha != acq.Sha || was.Side != acq.Side || was.Consumer != acq.Consumer {
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
	}
	return nack("claim_exists", "%s", claimID)
}
