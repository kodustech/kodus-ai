package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/checkout"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/transport"
)

// prepare creates the claim's network, its two machines, brings the code in
// and pushes the egress policy. ctx ends at the claim's ceiling or when the
// claim is released.
//
// The steps run in this order and each leaves what the next needs in the
// preparation. The first that fails ends it, with the blocker it names.
func (a *Agent) prepare(ctx context.Context, c *claims.Claim, hard time.Time) error {
	p := &preparation{a: a, ctx: ctx, c: c, acq: c.Acquire, hard: hard, phases: newPhases(a, ctx, c)}
	defer p.finish()
	for _, step := range []func() error{
		p.network,     // the claim's network, or a warm pool machine's
		p.machines,    // the workload and the observer, under the claim's lease
		p.code,        // the checkout: fetched, the recipe laid over it, checked
		p.upload,      // into the workload
		p.compose,     // a driver that boots the project itself
		p.egress,      // the policy that names the claim's addresses
		p.recipeSteps, // the recipe's setup, migrate and seed
		p.observerSQL, // the observer's read-only database account
	} {
		if err := step(); err != nil {
			return err
		}
	}
	return nil
}

// preparation is one claim being prepared: what each step leaves for the
// next. It lives for one prepare call.
type preparation struct {
	a      *Agent
	ctx    context.Context
	c      *claims.Claim
	acq    protocol.ClaimAcquireBody
	hard   time.Time
	phases *phases

	size   driver.ClaimSize
	key    string
	pooled *driver.PoolMachine
	net    driver.ClaimNetwork

	workload driver.MachineRef
	// repo is the checkout on the cell.
	repo string
	// after runs when the preparation ends, whatever its outcome.
	after []func()
}

func (p *preparation) finish() {
	for i := len(p.after) - 1; i >= 0; i-- {
		p.after[i]()
	}
}

// network takes a ready pool machine of the environment when one fits, or
// makes the claim's own network.
func (p *preparation) network() error {
	a, c, acq := p.a, p.c, p.acq
	// A size above what this cell grants is refused before anything is
	// made: a claim never gets more than the cell's maximum.
	p.size = claimSize(acq)
	if err := p.size.Within(a.cfg.Driver.Capabilities().MaxClaimSize); err != nil {
		return blockerErr(protocol.BlockerKindResources, "size_unavailable", err)
	}
	key, err := a.cfg.OrgKey(acq.OrgID)
	if err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "org_key", err)
	}
	p.key = key
	expose := make([]driver.ExposePort, 0, len(acq.Expose))
	for _, e := range acq.Expose {
		expose = append(expose, driver.ExposePort{Service: e.Service, Port: int(e.Port), Kind: string(e.Kind)})
	}
	// A ready pool machine of the environment is the claim's network and
	// workload; one that cannot be adopted is discarded, and the claim
	// makes its own.
	if m, ok := a.takePoolMachine(acq, p.hard); ok {
		if err := a.cfg.Pooler.Adopt(p.ctx, m, c.ID); err != nil {
			c.Log.Warn("claim.pool.adopt_failed", "machine", m.Workload.MachineID, "err", err)
			a.pool.Discard(m, "adopt_failed")
		} else {
			p.pooled = &m
			a.m.pool.Inc("adopted")
			c.Log.Info("claim.pool.adopted", "machine", m.Workload.MachineID)
			a.pool.Refill(acq.OrgID, acq.EnvironmentID)
		}
	}
	// A base that boots a bake this cell made stays at its ready size (claimMemoryNeed):
	// its build reuses the bake's layers. Any other claim without a pool machine builds.
	if p.pooled == nil && !(acq.Side == protocol.SideBase && a.bootsLocalBake(acq)) {
		a.countBoot(c)
	}
	if p.pooled != nil {
		p.net = p.pooled.Network
	} else if p.net, err = a.cfg.Driver.PrepareClaim(p.ctx, driver.ClaimNetworkSpec{CellID: a.cfg.CellID, OrgID: acq.OrgID, ClaimID: c.ID, Expose: expose}); err != nil {
		return blockerErr(protocol.BlockerKindResources, "claim_network", err)
	}
	c.SetNetwork(p.net)
	p.phases.done("network")
	return nil
}

// machines creates the workload (or takes the pool machine's) and the
// observer. Each joins the claim's lease as soon as it exists, so the
// dead-man switch and the sweep own it whatever happens next.
func (p *preparation) machines() error {
	a, c, acq := p.a, p.c, p.acq
	expires := initialExpiry(a.clock.Now(), a.cfg.InitialLease, acq.LeaseExpiresAt)
	if expires.After(p.hard) {
		expires = p.hard
	}
	l := lease.Lease{ClaimID: c.ID, OrgID: acq.OrgID, Network: p.net, ExpiresAt: expires, HardExpiresAt: p.hard}
	a.leases.Track(l)
	base := driver.MachineSpec{
		CellID: a.cfg.CellID, EnvironmentID: acq.EnvironmentID, OrgID: acq.OrgID, ClaimID: c.ID,
		ImageID: acq.ImageID, ImageRef: acq.ImageID, KMSKeyRef: p.key, ExpiresAt: expires, HardExpiresAt: p.hard,
	}
	work := base
	work.Role, work.Size, work.ClaimGroupID = driver.RoleWorkload, a.cfg.WorkloadSize, p.net.WorkloadGroupID
	// The claim's size is its workload's: the observer keeps the cell's.
	work.ClaimSize = p.size
	// Only a setup's workload may write what the environment keeps (S-52).
	work.Setup = acq.Consumer == protocol.ConsumerSetup && acq.Side != protocol.SidePr
	work.SeedsCache = work.Setup && acq.SeedsCache != nil && *acq.SeedsCache
	var err error
	if a.cfg.Keys != nil {
		if work.UserData, err = a.cfg.Keys.PrepareClaim(c.ID); err != nil {
			return blockerErr(protocol.BlockerKindPlatform, "claim_keys", err)
		}
	}
	if p.pooled != nil {
		// The pool machine keeps its pool tags; its expiry follows the
		// claim's lease from now on (renewed with it, under its ceiling).
		p.workload = p.pooled.Workload
		if err := a.cfg.Driver.SetExpiry(p.ctx, p.workload, expires); err != nil {
			return blockerErr(protocol.BlockerKindResources, "create_workload", err)
		}
	} else if p.workload, err = a.cfg.Driver.Create(p.ctx, work); err != nil {
		if errors.Is(err, driver.ErrSizeUnavailable) {
			return blockerErr(protocol.BlockerKindResources, "size_unavailable", err)
		}
		return blockerErr(protocol.BlockerKindResources, "create_workload", err)
	}
	c.SetWorkload(p.workload)
	if acq.Side == protocol.SidePr {
		// From here on the machine runs PR code: destroyed on release,
		// never baked, snapshotted or pooled (S-52).
		a.origin.Taint(p.workload.MachineID)
	}
	l.Machines = append(l.Machines, p.workload)
	a.leases.Track(l)
	obs := base
	obs.Role, obs.Size, obs.ClaimGroupID = driver.RoleObserver, a.cfg.ObserverSize, p.net.ObserverGroupID
	observerRef, err := a.cfg.Driver.Create(p.ctx, obs)
	if err != nil {
		return blockerErr(protocol.BlockerKindResources, "create_observer", err)
	}
	c.SetObserver(observerRef)
	l.Machines = append(l.Machines, observerRef)
	a.leases.Track(l)
	p.phases.done("machines")
	return nil
}

// code brings the checkout onto the cell (tarball by API, extraction with no
// network, token revoked), lays Kody's files and the default branch's recipe
// over it, checks what the recipe requires, and reads what it pins.
func (p *preparation) code() error {
	a, c, acq := p.a, p.c, p.acq
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
		p.after = append(p.after, func() { os.RemoveAll(dir) })
	} // else the checkout is the compose project's directory until cleanup
	p.repo = filepath.Join(dir, "repo")
	p.phases.started("fetch")
	if _, err := tarball.FetchExtractRevoke(p.ctx, tarball.FetchOptions{URL: url, Token: acq.RepoToken, Dest: p.repo, WorkDir: dir, Extractor: a.cfg.Extractor, Revoker: a.cfg.Revoker}); err != nil {
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
	if err := checkout.WriteAuthoredFiles(p.repo, acq.Recipe); err != nil {
		return blockerErr(protocol.BlockerKindToolchain, "authored_files", err)
	}
	if err := checkout.ApplyRecipe(p.repo, acq.Recipe); err != nil {
		return blockerErr(protocol.BlockerKindRecipeOutdated, "recipe_apply", err)
	}
	// Validate the base recipe before Upload: local-docker may build there,
	// while compose drivers build later in Up.
	if err := a.checkRecipeRequirements(c, p.repo); err != nil {
		return err
	}
	// What go.sum pins is all the mirror serves this claim for Go.
	if pins, err := checkout.GoSumPins(p.repo); err != nil {
		c.Log.Warn("mirror.go_pins", "err", err)
	} else {
		c.SetGoPins(pins)
	}
	// What the Dockerfiles name is all the mirror serves this claim from Docker Hub.
	if pins, err := checkout.DockerfileImagePins(p.repo); err != nil {
		c.Log.Warn("mirror.image_pins", "err", err)
	} else {
		c.SetImagePins(pins)
	}
	p.phases.done("fetch")
	return nil
}

// upload puts the checkout in the workload. It is also where a driver that
// boots from the checkout boots it (local-docker): its phases are in
// claim.ready.timing.
func (p *preparation) upload() error {
	if err := p.a.cfg.Transport.Upload(p.phases.started("upload"), p.workload, p.repo, transport.Workspace); err != nil {
		if errors.Is(err, driver.ErrWorkloadBoot) {
			return blockerErr(protocol.BlockerKindToolchain, "compose_up", err)
		}
		if errors.Is(err, driver.ErrWorkloadRecipe) {
			return blockerErr(protocol.BlockerKindRecipeOutdated, "recipe_load", err)
		}
		return blockerErr(protocol.BlockerKindPlatform, "repo_upload", err)
	}
	p.phases.done("upload")
	return nil
}

// compose brings the project up through a driver that boots it itself.
func (p *preparation) compose() error {
	a := p.a
	if a.cfg.Composer == nil {
		return nil
	}
	// A project that builds fetches during Up (the builder sits at an
	// address of the claim network's own Sources): its policy is in
	// place before, and pushed again by egress with the containers' addresses.
	if a.cfg.Egress != nil {
		if err := a.pushEgressBeforeUp(p.ctx, p.c); err != nil {
			return blockerErr(protocol.BlockerKindPlatform, "egress_policy", err)
		}
	}
	if err := a.bootCompose(p.phases.started("compose"), p.c, p.workload, p.repo); err != nil {
		return err
	}
	p.phases.done("compose")
	return nil
}

// egress pushes the claim's policy with every address it now has.
func (p *preparation) egress() error {
	if p.a.cfg.Egress == nil {
		return nil
	}
	if err := p.a.applyEgress(p.ctx, p.c); err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "egress_policy", err)
	}
	p.phases.done("egress")
	return nil
}

// recipeSteps runs the recipe's setup, migrate and seed, once the policy
// names the containers they run in: a setup command may fetch.
func (p *preparation) recipeSteps() error {
	if !p.a.recipeSteps(p.c) {
		return nil
	}
	if err := p.a.runRecipe(p.phases.started("recipe"), p.c, p.workload); err != nil {
		return err
	}
	p.phases.done("recipe")
	return nil
}

func (p *preparation) observerSQL() error {
	return p.a.provisionObserverSQL(p.ctx, p.c, p.repo)
}

// phases tells the log and the hub where a claim's preparation is: each
// phase's duration when it ends, and a long phase's output while it runs.
type phases struct {
	a    *Agent
	ctx  context.Context
	c    *claims.Claim
	mark time.Time
	tail *progressTail
}

func newPhases(a *Agent, ctx context.Context, c *claims.Claim) *phases {
	return &phases{a: a, ctx: ctx, c: c, mark: a.clock.Now()}
}

// done ends the phase: its time since the last one, and the output it left.
func (p *phases) done(name string) {
	now := p.a.clock.Now()
	ms := now.Sub(p.mark).Milliseconds()
	p.c.Log.Info("claim.phase", "phase", name, "ms", ms)
	var lines []string
	if p.tail != nil {
		lines, p.tail = p.tail.snapshot(), nil
	}
	p.a.progress(p.c, name, protocol.ClaimProgressBodyStateDone, &ms, lines)
	p.mark = now
}

// started tells the hub a long phase began; its output, while it runs,
// goes out with it every few seconds (driver.WithOutput on the returned
// context).
func (p *phases) started(name string) context.Context {
	p.a.progress(p.c, name, protocol.ClaimProgressBodyStateStarted, nil, nil)
	p.tail = &progressTail{now: p.a.clock.Now, send: func(lines []string) {
		p.a.progress(p.c, name, protocol.ClaimProgressBodyStateStarted, nil, lines)
	}}
	return driver.WithOutput(p.ctx, p.tail.line)
}

// claimSize is the machine size the claim asked (claim.acquire size), zero
// when it asked none.
func claimSize(acq protocol.ClaimAcquireBody) driver.ClaimSize {
	if acq.Size == nil {
		return driver.ClaimSize{}
	}
	return driver.ClaimSize{MemoryMB: int(acq.Size.MemoryMb), CPUs: int(acq.Size.Cpus)}
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
