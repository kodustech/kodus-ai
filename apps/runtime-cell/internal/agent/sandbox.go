package agent

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Code sandboxes (docs/runtime/sandbox.md). A sandbox is a claim of consumer
// sandbox: the claim's network and one tool machine (driver.Sandboxer) with
// the guest agent inside, under the claim's lease and ceiling, swept and
// reaped like any claim's machines. No compose, no observer, no Run, no
// checkout from the cell: the caller fetches its code with sandbox.op exec.
// Every sandbox.op goes to the guest agent over its stream; the agent checks
// the claim and relays, it never touches the machine's files itself.

// sandboxImageID names a sandbox's machine in its step results.
const sandboxImageID = "sandbox"

// sandboxClaim is the claim a sandbox.acquire makes: an untrusted workload
// (side pr: destroyed on release, never baked, pooled back or reused).
func sandboxClaim(b protocol.SandboxAcquireBody) protocol.ClaimAcquireBody {
	return protocol.ClaimAcquireBody{
		OrgID: b.OrgID, EnvironmentID: protocol.SandboxEnvironmentID, ImageID: sandboxImageID,
		Side: protocol.SidePr, Sha: strings.Repeat("0", 40), Consumer: protocol.ConsumerSandbox,
		Expose: []protocol.Expose{}, HardExpiresAt: b.HardExpiresAt, LeaseExpiresAt: b.LeaseExpiresAt,
		EgressAllow: b.EgressAllow, EgressInspect: b.EgressInspect, EgressRecommended: b.EgressRecommended, Size: b.Size, Secrets: b.Secrets,
	}
}

func isSandbox(c *claims.Claim) bool { return c.Acquire.Consumer == protocol.ConsumerSandbox }

// sandboxAcquire admits a sandbox.acquire like any claim (ceiling, memory,
// slots, rejoin), then boots it with prepareSandbox.
func (a *Agent) sandboxAcquire(trace context.Context, claimID string, b protocol.SandboxAcquireBody) error {
	if a.cfg.Parts.Sandboxes == nil {
		return nack("not_supported", "this cell runs no sandboxes")
	}
	plan := snapshotPlanOf(b)
	if (plan.Prepares || plan.ResumeFrom != "") && a.cfg.Parts.Snapshots == nil {
		return nack("snapshot_unsupported", "this cell's %s driver keeps no memory snapshot", a.cfg.Driver.Kind())
	}
	return a.acquireWith(trace, claimID, sandboxClaim(b), plan)
}

// refusedOnSandbox is the nack for a frame a sandbox claim never takes (a
// probe, an exec outside the guest agent, a reset, a browser), nil for any
// other claim.
func (a *Agent) refusedOnSandbox(claimID string, kind protocol.MessageType) error {
	if c, ok := a.claims.Get(claimID); ok && isSandbox(c) {
		return nack("not_supported", "a sandbox claim takes sandbox.op, not %s", kind)
	}
	return nil
}

// guests holds each sandbox claim's stream to its guest agent.
type guests struct {
	mu sync.Mutex
	by map[string]*guest.Client
}

func (g *guests) put(claimID string, c *guest.Client) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.by == nil {
		g.by = map[string]*guest.Client{}
	}
	if old := g.by[claimID]; old != nil && old != c {
		_ = old.Close()
	}
	g.by[claimID] = c
}

func (g *guests) get(claimID string) *guest.Client {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.by[claimID]
}

func (g *guests) close(claimID string) {
	g.mu.Lock()
	c := g.by[claimID]
	delete(g.by, claimID)
	g.mu.Unlock()
	if c != nil {
		_ = c.Close()
	}
}

// guestReadyTimeout bounds the first answer of a new guest agent.
const guestReadyTimeout = 30 * time.Second

// dialGuest opens a stream to the machine's guest agent and waits for its
// first answer (a stat of the root): a sandbox is ready only when it answers.
//
// A machine the driver returned may still be booting (a microVM's guest
// agent answers its vsock some 0.4 s after the VMM runs): the dial is tried
// again until guestReadyTimeout.
func (a *Agent) dialGuest(ctx context.Context, ref driver.MachineRef, claimID string) (*guest.Client, error) {
	start := a.clock.Now()
	for {
		cl, err := a.dialGuestOnce(ctx, ref, claimID)
		if err == nil || ctx.Err() != nil || a.clock.Now().Sub(start) >= guestReadyTimeout {
			return cl, err
		}
		select {
		case <-ctx.Done():
			return nil, err
		case <-a.clock.After(guestDialRetry):
		}
	}
}

// guestDialRetry is the pause between two dials of a booting guest agent.
const guestDialRetry = 25 * time.Millisecond

func (a *Agent) dialGuestOnce(ctx context.Context, ref driver.MachineRef, claimID string) (*guest.Client, error) {
	// The stream lives as long as the claim (closed on its cleanup), not as
	// long as the preparation or the op that opened it.
	rw, err := a.cfg.Parts.Sandboxes.DialGuest(context.WithoutCancel(ctx), ref)
	if err != nil {
		return nil, err
	}
	cl := guest.NewClient(rw, a.cfg.CellID, claimID)
	cl.TraceContext = a.cfg.GuestTraceContext
	pctx, cancel := context.WithTimeout(ctx, guestReadyTimeout)
	defer cancel()
	r, err := cl.Do(pctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindStat})
	if err == nil && (!r.Ok || r.Type == nil || *r.Type != protocol.SandboxEntryTypeDir) {
		err = errors.New("the guest agent's root is not a directory")
	}
	if err != nil {
		_ = cl.Close()
		return nil, err
	}
	return cl, nil
}

// guestOf is the claim's stream, dialled again when the last one ended (a
// guest agent that died is restarted on the next op).
func (a *Agent) guestOf(ctx context.Context, c *claims.Claim) (*guest.Client, error) {
	if cl := a.guests.get(c.ID); cl != nil {
		select {
		case <-cl.Done():
		default:
			return cl, nil
		}
	}
	cl, err := a.dialGuest(ctx, c.Machines().Workload, c.ID)
	if err != nil {
		return nil, err
	}
	a.guests.put(c.ID, cl)
	return cl, nil
}

// takesBlankSandbox: the sandbox acquire may take a blank pool sandbox. Not
// one with org secrets on a cell that gives such machines its trust files
// (Config.CellTrust): a blank one was made before the claim, without them.
// Admission (hasPoolMachine) and preparation ask the same.
func (a *Agent) takesBlankSandbox(acq protocol.ClaimAcquireBody) bool {
	return !a.cfg.CellTrust || len(acq.Secrets) == 0
}

// takeBlankSandbox hands the claim a blank pool sandbox when it may take one
// and one fits.
func (a *Agent) takeBlankSandbox(c *claims.Claim, size driver.ClaimSize, hard time.Time) (pooledSandbox, bool) {
	if !a.takesBlankSandbox(c.Acquire) {
		return pooledSandbox{}, false
	}
	return a.sandboxPool.take(size, hard)
}

// prepareSandbox boots a sandbox claim: a blank pooled sandbox when one
// fits, else the claim's own network and machine; then the guest agent's
// first answer and the egress policy.
func (a *Agent) prepareSandbox(ctx context.Context, c *claims.Claim, hard time.Time) error {
	acq := c.Acquire
	ph := newPhases(a, c)
	size := a.sandboxSizeOf(acq)
	if err := size.Within(a.cfg.Driver.Capabilities().MaxClaimSize); err != nil {
		return blockerErr(protocol.BlockerKindResources, "size_unavailable", err)
	}
	expires := initialExpiry(a.clock.Now(), a.cfg.InitialLease, acq.LeaseExpiresAt)
	if expires.After(hard) {
		expires = hard
	}
	l := lease.Lease{ClaimID: c.ID, OrgID: acq.OrgID, ExpiresAt: expires, HardExpiresAt: hard}
	var cl *guest.Client
	// The claim is counted before it takes a blank sandbox: counted after,
	// the pool saw the blank's memory free while the claim held it and made
	// another past the cell's memory (TestBlankSandboxesAreCountedInTheCellsMemory
	// under -race). For that moment the blank is counted twice, never zero
	// times.
	a.countSandbox(c)
	from, fromOK, err := a.sandboxSnapshotOf(ctx, c)
	if err != nil {
		return err
	}
	// A blank pool sandbox was made before any claim, without the cell's
	// trust files: a claim whose machines need them makes its own. A claim
	// that prepares a template or starts from a snapshot makes its own too,
	// and is asked first: a blank one taken for it would leave the pool with
	// no claim to end it.
	var m pooledSandbox
	pooled := false
	if !fromOK && !c.Snapshot.Prepares {
		m, pooled = a.takeBlankSandbox(c, size, hard)
	}
	if pooled {
		// From here the blank sandbox is this claim's alone: in its lease,
		// destroyed on its release, never back in the pool.
		l.Network, l.Machines = m.net, []driver.MachineRef{m.ref}
		a.leases.Track(l)
		c.SetNetwork(m.net)
		c.SetWorkload(m.ref)
		a.origin.Taint(m.ref.MachineID)
		if err := a.cfg.Driver.SetExpiry(ctx, m.ref, expires); err != nil {
			return blockerErr(protocol.BlockerKindResources, "create_workload", err)
		}
		cl = m.guest
		c.Log.Info("sandbox.pool.taken", "machine", m.ref.MachineID, "ageMs", a.clock.Now().Sub(m.at).Milliseconds())
		ph.done("pool")
	} else {
		key, err := a.cfg.OrgKey(acq.OrgID)
		if err != nil {
			return blockerErr(protocol.BlockerKindPlatform, "org_key", err)
		}
		net, err := a.cfg.Driver.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: a.cfg.CellID, OrgID: acq.OrgID, ClaimID: c.ID})
		if err != nil {
			return blockerErr(protocol.BlockerKindResources, "claim_network", err)
		}
		c.SetNetwork(net)
		l.Network = net
		a.leases.Track(l)
		ph.done("network")
		spec := driver.MachineSpec{
			CellID: a.cfg.CellID, EnvironmentID: protocol.SandboxEnvironmentID, Role: driver.RoleWorkload, OrgID: acq.OrgID, ClaimID: c.ID,
			ImageID: sandboxImageID, Size: a.cfg.WorkloadSize, ClaimSize: size, ClaimGroupID: net.WorkloadGroupID, KMSKeyRef: key,
			ExpiresAt: expires, HardExpiresAt: hard, Secrets: len(c.OrgSecrets) > 0,
			// A sandbox that prepares a template runs only what a setup runs
			// (the caller's word, as for a setup claim) and holds no secret.
			Setup: c.Snapshot.Prepares,
		}
		var ref driver.MachineRef
		if fromOK {
			ref, err = a.cfg.Parts.Snapshots.CreateSandboxFromSnapshot(ctx, a.sandboxRequest(c, spec), from)
		} else {
			ref, err = a.cfg.Parts.Sandboxes.CreateSandbox(ctx, a.sandboxRequest(c, spec))
		}
		if err != nil {
			if errors.Is(err, driver.ErrSizeUnavailable) {
				return blockerErr(protocol.BlockerKindResources, "size_unavailable", err)
			}
			if errors.Is(err, driver.ErrDiskCapacity) {
				return blockerErr(protocol.BlockerKindResources, "disk_capacity", err)
			}
			if fromOK {
				return blockerErr(protocol.BlockerKindResources, "restore_workload", err)
			}
			return blockerErr(protocol.BlockerKindResources, "create_workload", err)
		}
		c.SetWorkload(ref)
		if !c.Snapshot.Prepares {
			a.origin.Taint(ref.MachineID)
		}
		switch {
		case fromOK && from.Purpose == "session":
			c.SetStart(string(protocol.ClaimReadyBodyStartSession))
		case fromOK:
			c.SetStart(string(protocol.ClaimReadyBodyStartTemplate))
		default:
			c.SetStart(string(protocol.ClaimReadyBodyStartCold))
		}
		l.Machines = []driver.MachineRef{ref}
		a.leases.Track(l)
		ph.done("machines")
	}
	if cl == nil {
		var err error
		if cl, err = a.dialGuest(ctx, c.Machines().Workload, c.ID); err != nil {
			return blockerErr(protocol.BlockerKindPlatform, "guest_agent", err)
		}
	}
	a.guests.put(c.ID, cl)
	ph.done("guest")
	if a.cfg.Egress != nil {
		if err := a.applyEgress(ctx, c); err != nil {
			return blockerErr(protocol.BlockerKindPlatform, "egress_policy", err)
		}
		ph.done("egress")
	}
	return nil
}

// sandboxReadyBody is claim.ready for a sandbox: no service, no observer
// (the frame names the sandbox machine), the tool image.
func (a *Agent) sandboxReadyBody(c *claims.Claim) *protocol.ClaimReadyBody {
	m := c.Machines()
	body := &protocol.ClaimReadyBody{
		Manifest: protocol.Manifest{Services: []protocol.ManifestService{}, Expose: []protocol.Expose{}, ImageID: sandboxImageID, SeedSha: "none"},
		Observer: protocol.ObserverState{ID: m.Workload.MachineID, State: protocol.ObserverPhaseReady},
		Timing:   a.readyTiming(c),
	}
	// template and session are values only a hub that accepts snapshots knows.
	if start := protocol.ClaimReadyBodyStart(c.Start()); start != "" && a.hubAccepts(protocol.FeatureReadyStart) &&
		(a.hubAccepts(protocol.FeatureSnapshots) || (start != protocol.ClaimReadyBodyStartTemplate && start != protocol.ClaimReadyBodyStartSession)) {
		body.Start = &start
	}
	return body
}

// sandboxOpGrace is how much longer than an exec's own timeout (or than
// sandboxOpTimeout for a file op) the cell waits for the guest agent.
const (
	sandboxOpGrace   = 15 * time.Second
	sandboxOpTimeout = 60 * time.Second
)

// sandboxOpFrame admits a sandbox.op on a sandbox claim.
func (a *Agent) sandboxOpFrame(trace context.Context, claimID string, b *protocol.SandboxOpBody) error {
	c, ok := a.claims.Get(claimID)
	if ok && !isSandbox(c) {
		return nack("not_supported", "sandbox.op runs on a sandbox claim only")
	}
	// The wire to the guest agent takes the claim's secrets on top of the
	// caller's env; the caller itself keeps the hub's bound.
	if err := protocol.CheckCallerEnv(b.Op); err != nil {
		return nack("invalid_body", "%v", err)
	}
	// The op itself is what the step runs (the at-most-once rule).
	canon := []byte("sandbox.op\x00" + string(b.Op.Op) + "\x00" + deref(b.Op.Path) + "\x00" + deref(b.Op.Command) + "\x00" + deref(b.Op.Cwd))
	return a.admitStep(stepAdmission{trace: trace, kind: protocol.MessageTypeSandboxOp, claimID: claimID, stepID: b.StepID, canon: canon},
		func(ctx context.Context, c *claims.Claim) { a.runSandboxOp(ctx, c, b) })
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (a *Agent) runSandboxOp(ctx context.Context, c *claims.Claim, b *protocol.SandboxOpBody) {
	wait := sandboxOpTimeout
	if b.Op.TimeoutMs != nil {
		wait = time.Duration(*b.Op.TimeoutMs) * time.Millisecond
	}
	octx, cancel := context.WithTimeout(ctx, wait+sandboxOpGrace)
	defer cancel()
	start := a.clock.Now()
	res := &protocol.StepResultBody{StepID: b.StepID, Executor: protocol.ExecutorVM, ImageID: sandboxImageID, VMHealth: protocol.VMHealthOk}
	cl, err := a.guestOf(octx, c)
	var out protocol.SandboxResult
	if err == nil {
		// The claim's secrets reach the command as placeholders, never values.
		out, err = cl.Do(octx, b.StepID, secretEnvFor(c, b.Op))
	}
	if a.stepCancelled(ctx, c, "sandbox.op", b.StepID, err) {
		return
	}
	d := a.clock.Now().Sub(start).Milliseconds()
	res.DurationMs = &d
	attrs := []any{"step", b.StepID, "op", b.Op.Op, "durationMs", d}
	a.m.sandboxOps.Inc(string(b.Op.Op), sandboxOpOutcome(out, err))
	a.m.sandboxOpMillis.Add(float64(d), string(b.Op.Op))
	if err != nil {
		// The guest agent did not answer: the machine is unreachable.
		res.VMHealth = protocol.VMHealthUnreachable
		c.Log.Warn("sandbox.op", append(attrs, "err", err)...)
	} else {
		res.Sandbox = &out
		if out.Error != nil {
			attrs = append(attrs, "refused", out.Error.Code)
		}
		if out.Exec != nil {
			attrs = append(attrs, "exitCode", out.Exec.ExitCode, "timedOut", out.Exec.TimedOut)
		}
		c.Log.Info("sandbox.op", attrs...)
	}
	a.sendStepResult(ctx, c, "sandbox.op", res)
}

// sandboxOpOutcome is the cell_sandbox_ops_total outcome: ok, refused (the
// guest answered with an error code) or failed (no answer).
func sandboxOpOutcome(out protocol.SandboxResult, err error) string {
	switch {
	case err != nil:
		return "failed"
	case out.Error != nil:
		return "refused"
	}
	return "ok"
}
