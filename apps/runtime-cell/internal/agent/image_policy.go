package agent

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// bakeTimeout bounds one image bake.
const bakeTimeout = 90 * time.Minute

type bakedImage struct {
	orgID, environmentID, sha string
}

func (a *Agent) taint(ref driver.MachineRef) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.tainted[ref.MachineID] = true
}

// untaint forgets a destroyed machine (ids are never reused).
func (a *Agent) untaint(ref driver.MachineRef) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.tainted, ref.MachineID)
}

func (a *Agent) isTainted(machineID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.tainted[machineID]
}

// ranPRCode reports whether the claim is a PR claim or holds a machine that
// ran PR code.
func (a *Agent) ranPRCode(c *claims.Claim) bool {
	if c.Acquire.Side == protocol.SidePr {
		return true
	}
	id := c.Machines().Workload.MachineID
	return id != "" && a.isTainted(id)
}

// isCleanSetupClaim is a setup claim that never ran PR code.
func (a *Agent) isCleanSetupClaim(c *claims.Claim) bool {
	return c.Acquire.Consumer == protocol.ConsumerSetup && !a.ranPRCode(c)
}

// bake answers image.bake (S-52): an image is built on a clean machine from
// a default-branch commit, never from a claim that ran PR code. The hub and
// the worker already checked the commit; the cell refuses a bake tied to a
// PR claim, to another kind of claim, or to another commit.
func (a *Agent) bake(claimID string, b protocol.ImageBakeBody) error {
	if !a.acceptingWork() {
		return nack("not_accepting", "cell is not accepting work")
	}
	if !a.cfg.Driver.Capabilities().Bake {
		return nack("bake_unsupported", "this cell's %s driver builds no image", a.cfg.Driver.Kind())
	}
	var bakeClaim *claims.Claim
	if claimID != "" {
		c, ok := a.claims.Get(claimID)
		if !ok {
			return nack("unknown_claim", "%s", claimID)
		}
		bakeClaim = c
		acq := c.Acquire
		switch {
		case a.ranPRCode(c):
			c.Log.Error("bake.refused", "reason", "pr_claim")
			return nack("pr_claim", "a claim that ran PR code never becomes an image (S-52)")
		case acq.Consumer != protocol.ConsumerSetup:
			return nack("not_setup_claim", "only a setup claim can ask for a bake")
		case acq.OrgID != b.OrgID || acq.EnvironmentID != b.EnvironmentID:
			return nack("wrong_environment", "the bake is for another org or environment than the claim")
		case acq.Sha != b.Sha:
			return nack("sha_mismatch", "the bake commit is not the one the setup claim booted")
		}
	}
	key, err := a.cfg.OrgKey(b.OrgID)
	if err != nil {
		return nack("org_key", "no key for the org")
	}
	finishBake, ok := a.reserveBake(b.OrgID, b.EnvironmentID)
	if !ok {
		return nack("bake_in_progress", "this environment already has a bake in progress")
	}
	accepted := false
	defer func() {
		if !accepted {
			finishBake()
		}
	}()
	spec := driver.BakeSpec{CellID: a.cfg.CellID, EnvironmentID: b.EnvironmentID, OrgID: b.OrgID, RecipeSHA: b.RecipeSha, SHA: b.Sha, KMSKeyRef: key, Size: a.cfg.WorkloadSize}
	if bakeClaim != nil {
		spec.Source = bakeClaim.Machines().Workload
	}
	// Pinning lets the worker release the logical claim immediately. Keep
	// its full physical budget until the bake helper actually finishes.
	finishMemory := func() {}
	if a.mem != nil && bakeClaim != nil {
		release, ok := a.mem.retain(claimID, a.budget.ClaimMemory(claimSize(bakeClaim.Acquire)).BootMB)
		if !ok {
			return nack("no_capacity", "the setup's full physical budget is not available for baking")
		}
		finishMemory = func() { release(); a.nudgeHeartbeat() }
		a.nudgeHeartbeat()
	}
	// A driver that bakes from the setup machine's output takes it now,
	// before the ack lets the worker release the claim.
	if p := a.cfg.BakePinner; p != nil {
		if spec.Source.MachineID == "" {
			finishMemory()
			return nack("bake_source", "this cell's %s driver bakes from a setup claim's machine", a.cfg.Driver.Kind())
		}
		if err := p.PinBakeSource(spec.Source); err != nil {
			finishMemory()
			log := a.log.With("env", b.EnvironmentID, "sha", b.Sha)
			log.Error("bake.refused", "reason", "bake_source", "err", err)
			return nack("bake_source", "the setup machine's output cannot be baked")
		}
	}
	log := a.log.With("env", b.EnvironmentID, "sha", b.Sha)
	a.goTracked(func(ctx context.Context) {
		defer finishBake()
		cleanupPending := false
		defer func() {
			if !cleanupPending {
				finishMemory()
			}
		}()
		ctx, cancel := context.WithTimeout(ctx, bakeTimeout)
		defer cancel()
		img, err := a.cfg.Driver.Bake(ctx, spec)
		if err != nil {
			if errors.Is(err, driver.ErrResourceCleanupPending) {
				// A daemon failure is not physical release. Quarantine this
				// budget until operator/reaper cleanup and cell reconciliation.
				cleanupPending = true
				log.Error("bake.cleanup_pending", "alarm", true, "err", err)
				a.nudgeHeartbeat()
			}
			a.m.bakes.Inc("failed")
			log.Error("bake.failed", "err", err)
			return
		}
		a.mu.Lock()
		a.baked[img.ImageID] = bakedImage{orgID: b.OrgID, environmentID: b.EnvironmentID, sha: b.Sha}
		a.latestBake[poolKey{b.OrgID, b.EnvironmentID}] = img.ImageID
		a.mu.Unlock()
		if a.cfg.BakeCatalog != nil {
			if err := a.cfg.BakeCatalog.AcknowledgeBake(ctx, img.ImageID); err != nil {
				log.Error("bake.catalog.cleanup_pending", "alarm", true, "err", err)
			}
		}
		a.m.bakes.Inc("done")
		log.Info("bake.done", "image", img.ImageID)
		a.poolFollowsBake(b.OrgID, b.EnvironmentID, img.ImageID)
	})
	accepted = true
	return nil
}

// The reservation lasts through the agent pointer and catalog acknowledgement.
// Concurrent same-environment requests fail explicitly before taking resources.
func (a *Agent) reserveBake(org, env string) (func(), bool) {
	k := poolKey{org, env}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.activeBakes == nil {
		a.activeBakes = map[poolKey]bool{}
	}
	if a.activeBakes[k] {
		return nil, false
	}
	a.activeBakes[k] = true
	var once sync.Once
	return func() { once.Do(func() { a.mu.Lock(); delete(a.activeBakes, k); a.mu.Unlock() }) }, true
}

// poolTarget answers pool.target (S-52): pool machines come only from an
// image this cell baked from the default branch, never from a claim's
// machine (pool.go keeps them).
func (a *Agent) poolTarget(claimID string, b protocol.PoolTargetBody) error {
	if claimID != "" {
		if c, ok := a.claims.Get(claimID); ok && a.ranPRCode(c) {
			c.Log.Error("pool.refused", "reason", "pr_claim")
			return nack("pr_claim", "a claim that ran PR code never becomes a pool machine (S-52)")
		}
		return nack("pool_from_claim", "pool machines come from a baked image, never from a claim")
	}
	// "latest" is the environment's last bake in this cell, or the next one
	// when none is done yet: the worker asks right after image.bake is
	// accepted, before the bake has made anything. A named image must be one
	// this cell baked for that environment; that refusal (S-52) comes before
	// any other.
	latest := b.ImageID == latestImage
	a.mu.Lock()
	if latest {
		b.ImageID = a.latestBake[poolKey{b.OrgID, b.EnvironmentID}]
	}
	img, baked := a.baked[b.ImageID]
	a.mu.Unlock()
	if !latest && (!baked || img.orgID != b.OrgID || img.environmentID != b.EnvironmentID) {
		return nack("image_not_baked", "the pool only takes an image this cell baked from the default branch (S-52)")
	}
	if a.cfg.Pooler == nil {
		return nack("pool_unsupported", "this cell's %s driver keeps no pool", a.cfg.Driver.Kind())
	}
	// A size this cell grants no claim would fill a pool nothing adopts.
	if err := poolClaimSize(b).Within(a.cfg.Driver.Capabilities().MaxClaimSize); err != nil {
		return nack("size_unavailable", "%v", err)
	}
	a.setPoolTarget(b)
	return nil
}
