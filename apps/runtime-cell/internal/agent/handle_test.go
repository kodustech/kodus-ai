package agent

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dedup"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

const step1 = "1f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b"

func str(s string) *string { return &s }

// Every frame the hub sends, and what the cell answers before any work.
func TestHandleAnswers(t *testing.T) {
	h := newHarness(t)
	h.ready("claim-1")
	exec := func(cwd *string) *protocol.ExecBody {
		return &protocol.ExecBody{StepID: hubclient.NewID(), Command: "id", TimeoutMs: 1000, Cwd: cwd}
	}
	for _, tc := range []struct {
		name  string
		claim string
		typ   protocol.MessageType
		body  any
		want  string // nack code; "" is an ack
	}{
		{"claimId not a path segment", "../..", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}, "invalid_envelope"},
		{"release of an unknown claim", "claim-x", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}, "unknown_claim"},
		{"exec on an unknown claim", "claim-x", protocol.MessageTypeExec, exec(nil), "unknown_claim"},
		{"exec.cancel on an unknown claim", "claim-x", protocol.MessageTypeExecCancel, &protocol.ExecCancelBody{StepID: step1}, "unknown_claim"},
		{"exec.cancel of no running step", "claim-1", protocol.MessageTypeExecCancel, &protocol.ExecCancelBody{StepID: step1}, ""},
		{"renew with a bad time", "claim-1", protocol.MessageTypeClaimRenew, &protocol.ClaimRenewBody{LeaseExpiresAt: "tomorrow"}, "invalid_body"},
		{"renew of an unknown claim", "claim-x", protocol.MessageTypeClaimRenew, &protocol.ClaimRenewBody{LeaseExpiresAt: "2030-01-01T00:00Z"}, "unknown_claim"},
		{"renew, seconds-less time (schema-valid)", "claim-1", protocol.MessageTypeClaimRenew, &protocol.ClaimRenewBody{LeaseExpiresAt: protocol.FormatTime(time.Now().Add(20 * time.Minute))[:16] + "Z"}, ""},
		{"exec cwd out of the workspace", "claim-1", protocol.MessageTypeExec, exec(str("../../etc")), "invalid_body"},
		{"exec cwd absolute", "claim-1", protocol.MessageTypeExec, exec(str("/etc")), "invalid_body"},
		{"exec cwd inside", "claim-1", protocol.MessageTypeExec, exec(str("src/app")), ""},
		{"egress.policy for an unknown claim", "claim-x", protocol.MessageTypeEgressPolicy, &protocol.EgressPolicyBody{Allow: []string{}, IssuedAt: "2030-01-01T00:00Z"}, "unknown_claim"},
		{"upload", "claim-1", protocol.MessageTypeUpload, &protocol.UploadBody{}, "not_implemented"},
		{"a cell frame from the hub", "", protocol.MessageTypeHeartbeat, &protocol.HeartbeatBody{}, "unexpected_type"},
		{"acquire without claimId", "", protocol.MessageTypeClaimAcquire, h.acquireBody(), "invalid_envelope"},
		{"acquire of a held id, another commit", "claim-1", protocol.MessageTypeClaimAcquire, otherSha(h.acquireBody()), "claim_exists"},
		{"acquire of a held id, the same claim again (rejoined)", "claim-1", protocol.MessageTypeClaimAcquire, h.acquireBody(), ""},
	} {
		if got := nackCode(h.handle(tc.claim, tc.typ, tc.body)); got != tc.want {
			t.Errorf("%s: answer %q, want %q", tc.name, got, tc.want)
		}
	}
}

// M3: a hardExpiresAt without seconds is schema-valid; it used to be nacked.
func TestAcquireTakesASecondsLessCeiling(t *testing.T) {
	h := newHarness(t)
	b := h.acquireBody()
	b.HardExpiresAt = protocol.FormatTime(h.clk.Now().Add(30 * time.Minute))[:16] + "Z"
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatalf("schema-valid ceiling refused: %v", err)
	}
	h.conn.next(t, isReady)
}

// H4: a step refused after the dedup store recorded it was acked as a
// duplicate on the hub's retry and never ran. Nothing refused is recorded.
func TestRefusedStepIsNotRecordedAsSeen(t *testing.T) {
	h := newHarness(t)
	h.ready("claim-1")
	h.a.deadman.Revoke()
	b := &protocol.ExecBody{StepID: step1, Command: "id", TimeoutMs: 1000}
	if code := nackCode(h.handle("claim-1", protocol.MessageTypeExec, b)); code != "not_accepting" {
		t.Fatalf("revoked cell: %q", code)
	}
	if v := h.a.steps.Admit("claim-1", step1, []byte("exec\x00id\x00workspace")); v != dedup.New {
		t.Fatalf("the refused step was recorded: %s", v)
	}
}

// H3, M9: claim.renew answers off the read loop, and acks only once the
// tags moved; a tag that did not move is a nack the hub retries.
func TestRenewAcksOnlyAfterTheTagsMoved(t *testing.T) {
	h := newHarness(t)
	h.ready("claim-1")
	until := protocol.FormatTime(h.clk.Now().Add(20 * time.Minute))
	err := h.a.Handle(context.Background(), msg("claim-1", protocol.MessageTypeClaimRenew, &protocol.ClaimRenewBody{LeaseExpiresAt: until}))
	run, ok := hubclient.IsLater(err)
	if !ok {
		t.Fatalf("claim.renew answered on the read loop: %v", err)
	}
	h.drv.FailSetExpiry = errors.New("RequestLimitExceeded")
	if code := nackCode(run(context.Background())); code != "renew_failed" {
		t.Fatalf("renew with tags behind: %q", code)
	}
	h.drv.FailSetExpiry = nil
	if err := run(context.Background()); err != nil {
		t.Fatalf("renew: %v", err)
	}
	for _, m := range h.drv.Machines() {
		if m.Ref.Tags[driver.TagExpires] != until {
			t.Fatalf("kodus:expires %s, want %s", m.Ref.Tags[driver.TagExpires], until)
		}
	}
}

// B2: a claim whose lease ended (the hub stopped renewing, the sweep or
// the dead-man took the machines) used to stay forever, with its slot, its
// egress allowlist and its SSH keys.
func TestAClaimWhoseLeaseEndedLeavesTheCell(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxClaims = 1 })
	h.ready("claim-1")
	if h.a.Heartbeat().FreeSlots != 0 || !h.keys.has("claim-1") {
		t.Fatal("setup: the claim should hold the only slot and its keys")
	}
	h.clk.Advance(h.a.cfg.InitialLease + time.Second)
	if n, err := h.a.leases.Sweep(context.Background()); err != nil || n != 2 {
		t.Fatalf("sweep: %d %v", n, err)
	}
	h.a.ReapDeadClaims(context.Background())
	if _, ok := h.a.claims.Get("claim-1"); ok {
		t.Fatal("the claim outlived its lease")
	}
	if h.keys.has("claim-1") {
		t.Fatal("the claim's keys were kept")
	}
	if got := h.egress.removedIDs(); len(got) != 1 || got[0] != "claim-1" {
		t.Fatalf("egress policy not removed: %v", got)
	}
	h.a.deadman.Contact() // the hub is there
	if hb := h.a.Heartbeat(); hb.FreeSlots != 1 || len(hb.Claims) != 0 {
		t.Fatalf("slot not recovered: %+v", hb)
	}
	h.ready("claim-2") // the cell takes work again
}

// The dead-man's 15-minute branch destroys every machine; the claims go too.
func TestAbandonedCellFreesItsSlots(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxClaims = 1 })
	h.ready("claim-1")
	h.clk.Advance(16 * time.Minute)
	h.a.deadman.Tick(context.Background())
	h.a.ReapDeadClaims(context.Background())
	if h.a.claims.Len() != 0 || len(h.drv.Machines()) != 0 {
		t.Fatalf("claims %d machines %d after abandonment", h.a.claims.Len(), len(h.drv.Machines()))
	}
}

// M11: step.result is resent until acked, like claim.ready.
func TestStepResultIsResentUntilAcked(t *testing.T) {
	h := newHarness(t)
	h.ready("claim-1")
	h.conn.mu.Lock()
	h.conn.script = []error{hubclient.ErrAckTimeout, hubclient.ErrClosed}
	h.conn.mu.Unlock()
	if err := h.handle("claim-1", protocol.MessageTypeExec, &protocol.ExecBody{StepID: step1, Command: "id", TimeoutMs: 1000}); err != nil {
		t.Fatal(err)
	}
	r := h.conn.next(t, isResult(step1)).(*protocol.StepResultBody)
	if r.Exec == nil || r.VMHealth != protocol.VMHealthOk {
		t.Fatalf("result %+v", r)
	}
	if n := h.conn.attempts(isResult(step1)); n != 3 {
		t.Fatalf("step.result sent %d times, want 3", n)
	}
}

// M12: a cancelled exec sends no result (nobody waits for it) and says so
// in the log; it used to report the VM unreachable.
func TestCancelledExecSendsNoResult(t *testing.T) {
	started := make(chan struct{})
	h := newHarness(t, func(c *Config) {
		c.Transport = stubTransport{exec: func(ctx context.Context, _ kodyexec.Request) (kodyexec.Result, error) {
			close(started)
			<-ctx.Done()
			return kodyexec.Result{}, ctx.Err()
		}}
	})
	h.ready("claim-1")
	if err := h.handle("claim-1", protocol.MessageTypeExec, &protocol.ExecBody{StepID: step1, Command: "sleep 100", TimeoutMs: 600_000}); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := h.handle("claim-1", protocol.MessageTypeExecCancel, &protocol.ExecCancelBody{StepID: step1}); err != nil {
		t.Fatal(err)
	}
	h.a.Wait()
	if n := h.conn.attempts(isResult(step1)); n != 0 {
		t.Fatalf("a cancelled exec sent %d results", n)
	}
	if !strings.Contains(h.logs.String(), "step.cancelled") {
		t.Fatalf("no log of the cancel: %s", h.logs.String())
	}
}

// H5: a VM that never answers ends the exec at timeoutMs plus the grace,
// as unreachable, with the error in the log.
func TestHungExecEndsAtItsDeadline(t *testing.T) {
	h := newHarness(t, func(c *Config) {
		c.Transport = stubTransport{exec: func(ctx context.Context, _ kodyexec.Request) (kodyexec.Result, error) {
			<-ctx.Done()
			return kodyexec.Result{}, ctx.Err()
		}}
	})
	h.ready("claim-1")
	if err := h.handle("claim-1", protocol.MessageTypeExec, &protocol.ExecBody{StepID: step1, Command: "id", TimeoutMs: 1}); err != nil {
		t.Fatal(err)
	}
	r := h.conn.next(t, isResult(step1)).(*protocol.StepResultBody)
	if r.VMHealth != protocol.VMHealthUnreachable || !strings.Contains(h.logs.String(), "exec.transport_failed") {
		t.Fatalf("result %+v", r)
	}
}

// liar is an observer that answers for another step, as the VM executor.
type liar struct{}

func (liar) Run(context.Context, []byte) (*protocol.StepResultBody, string, error) {
	return &protocol.StepResultBody{StepID: "9f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", Executor: protocol.ExecutorVM, ImageID: "img-forged", VMHealth: protocol.VMHealthOk}, "", nil
}

// H6: the observer's word does not choose the step, the executor or the
// image of a result.
func TestObserverCannotChooseTheStepOfItsResult(t *testing.T) {
	h := newHarness(t, func(c *Config) {
		c.Observers = func(context.Context, ClaimInfo, []observer.Target) (observer.Client, error) { return liar{}, nil }
	})
	h.ready("claim-1")
	probe := &protocol.ProbeRunBody{StepID: step1, Probe: protocol.Probe{
		ID: "p", Origin: protocol.ProbeOriginAgent, Purpose: "p", Expected: "200",
		Compare: []protocol.CompareField{protocol.CompareFieldStatus},
		Spec:    protocol.ProbeSpec{HTTP: &protocol.HTTPProbe{Target: protocol.ProbeTarget{Service: "api", Port: 80}, Method: protocol.HTTPMethodGet, Path: "/", TimeoutMs: 1000}},
	}}
	if err := h.handle("claim-1", protocol.MessageTypeProbeRun, probe); err != nil {
		t.Fatal(err)
	}
	r := h.conn.next(t, func(f any) bool { _, ok := f.(*protocol.StepResultBody); return ok }).(*protocol.StepResultBody)
	if r.StepID != step1 || r.Executor != protocol.ExecutorObserver || r.ImageID != "img-1" {
		t.Fatalf("observer chose: step %s executor %s image %s", r.StepID, r.Executor, r.ImageID)
	}
	if !strings.Contains(h.logs.String(), "observer.violation") {
		t.Fatal("no log of the observer's lie")
	}
}

// blockingCreate is the fake driver whose Create waits for its context.
type blockingCreate struct {
	*fake.Driver
	entered chan struct{}
}

func (b blockingCreate) Create(ctx context.Context, spec driver.MachineSpec) (driver.MachineRef, error) {
	select {
	case b.entered <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return driver.MachineRef{}, ctx.Err()
}

// H5: a release while the cloud API hangs used to wait for it forever; the
// preparation now ends with the release.
func TestReleaseStopsAHungPreparation(t *testing.T) {
	entered := make(chan struct{}, 1)
	h := newHarness(t, func(c *Config) {
		d := c.Driver.(*fake.Driver)
		c.Driver = blockingCreate{Driver: d, entered: entered}
	})
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, h.acquireBody()); err != nil {
		t.Fatal(err)
	}
	<-entered
	if err := h.handle("claim-1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { h.a.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("release waited for a hung Create")
	}
	if h.a.claims.Len() != 0 {
		t.Fatal("released claim still held")
	}
	if n := h.conn.attempts(isReady); n != 0 {
		t.Fatal("a released claim reported ready")
	}
}

// slowCreate is the fake driver whose Create takes a while, so frames reach
// the claim while its machines are being made.
type slowCreate struct{ *fake.Driver }

func (s slowCreate) Create(ctx context.Context, spec driver.MachineSpec) (driver.MachineRef, error) {
	time.Sleep(5 * time.Millisecond)
	return s.Driver.Create(ctx, spec)
}

// M6: image.bake and pool.target read the claim's machines while prepare
// writes them; under -race this used to be a data race.
func TestBakeDuringPreparationIsRaceFree(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Driver = slowCreate{c.Driver.(*fake.Driver)} })
	b := h.acquireBody()
	b.Consumer, b.HardExpiresAt = protocol.ConsumerSetup, protocol.FormatTime(h.clk.Now().Add(40*time.Minute))
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				_ = h.handle("claim-1", protocol.MessageTypeImageBake, &protocol.ImageBakeBody{OrgID: "org-a", EnvironmentID: "env-1", Sha: testSHA, RecipeSha: "r"})
				_ = h.handle("claim-1", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: "img-1"})
			}
		}()
	}
	wg.Wait()
	h.conn.next(t, isReady)
}

func TestExecCwdStaysInTheWorkspace(t *testing.T) {
	for in, want := range map[string]string{"": "workspace", ".": "workspace", "src": "workspace/src", "a/./b/../c": "workspace/a/c"} {
		got, err := execCwd(&in)
		if err != nil || got != want {
			t.Errorf("%q: %q %v", in, got, err)
		}
	}
	for _, in := range []string{"..", "../x", "a/../../x", "/etc", "a\\b", "a\x00b"} {
		if got, err := execCwd(&in); err == nil {
			t.Errorf("%q became %q", in, got)
		}
	}
}

func TestCellRevokedStopsWork(t *testing.T) {
	h := newHarness(t)
	if err := h.handle("", protocol.MessageTypeCellRevoked, &protocol.CellRevokedBody{Reason: "test"}); err != nil {
		t.Fatal(err)
	}
	if !h.a.deadman.Revoked() || h.a.deadman.Accepting() {
		t.Fatal("revoked cell still accepting")
	}
	if code := nackCode(h.handle("claim-1", protocol.MessageTypeClaimAcquire, h.acquireBody())); code != "not_accepting" {
		t.Fatalf("acquire on a revoked cell: %q", code)
	}
}

// A ready claim's state is the claims package's: released claims refuse
// steps at once.
func TestReleasedClaimRefusesSteps(t *testing.T) {
	h := newHarness(t)
	h.ready("claim-1")
	c, _ := h.a.claims.Get("claim-1")
	c.Release()
	if code := nackCode(h.handle("claim-1", protocol.MessageTypeExec, &protocol.ExecBody{StepID: step1, Command: "id", TimeoutMs: 1000})); code != "unknown_claim" {
		t.Fatalf("exec on a released claim: %q", code)
	}
	if c.State() != claims.Released {
		t.Fatal("state")
	}
}

// A claim whose lease ended while it was still booting (the sweep took its
// machines mid-build) used to keep its preparation and its egress policy:
// the next claim on the same source address was refused. It is released.
func TestAClaimWhoseLeaseEndedWhileBootingIsReleased(t *testing.T) {
	entered := make(chan struct{}, 1)
	h := newHarness(t, func(c *Config) {
		d := c.Driver.(*fake.Driver)
		c.Driver = blockingCreate{Driver: d, entered: entered}
	})
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, h.acquireBody()); err != nil {
		t.Fatal(err)
	}
	<-entered
	h.a.ReapDeadClaims(context.Background())
	if c, ok := h.a.claims.Get("claim-1"); !ok || c.State() != claims.Acquiring {
		t.Fatal("a booting claim with a live lease was reaped")
	}
	h.clk.Advance(h.a.cfg.InitialLease + time.Second)
	h.a.ReapDeadClaims(context.Background())
	done := make(chan struct{})
	go func() { h.a.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the booting claim's preparation outlived its lease")
	}
	if _, ok := h.a.claims.Get("claim-1"); ok {
		t.Fatal("the claim outlived its lease")
	}
	if got := h.egress.removedIDs(); len(got) != 1 || got[0] != "claim-1" {
		t.Fatalf("egress policy not removed: %v", got)
	}
	if n := h.conn.attempts(isReady); n != 0 {
		t.Fatal("a reaped claim reported ready")
	}
}

func otherSha(b *protocol.ClaimAcquireBody) *protocol.ClaimAcquireBody {
	b.Sha = strings.Repeat("e", 40)
	return b
}

// The hub lost its first round of a claim (a replica restart, a retried
// step) and asks again: the cell joins the boot already running instead of
// refusing, and that boot's claim.ready settles the new round. A claim
// already ready sends its claim.ready again.
func TestARetriedAcquireRejoinsTheBoot(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var once sync.Once
	open := func() { once.Do(func() { close(release) }) }
	h := newHarness(t, func(c *Config) {
		c.Driver = gatedCreate{Driver: c.Driver.(*fake.Driver), entered: entered, release: release}
	})
	// A failing assertion must not leave the boot waiting forever (runs before the harness's own cleanup).
	t.Cleanup(open)
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, h.acquireBody()); err != nil {
		t.Fatal(err)
	}
	<-entered
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, h.acquireBody()); err != nil {
		t.Fatalf("a retried acquire of the booting claim: %v", err)
	}
	if code := nackCode(h.handle("claim-1", protocol.MessageTypeClaimAcquire, otherSha(h.acquireBody()))); code != "claim_exists" {
		t.Fatalf("another commit under the same id: %q", code)
	}
	open()
	h.conn.next(t, isReady)
	before := h.conn.attempts(isReady)
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, h.acquireBody()); err != nil {
		t.Fatalf("a retried acquire of the ready claim: %v", err)
	}
	h.a.Wait()
	if h.conn.attempts(isReady) <= before {
		t.Fatal("the ready claim did not send claim.ready again")
	}
}

// gatedCreate is the fake driver whose first Create waits until released.
type gatedCreate struct {
	*fake.Driver
	entered chan struct{}
	release chan struct{}
}

func (g gatedCreate) Create(ctx context.Context, spec driver.MachineSpec) (driver.MachineRef, error) {
	select {
	case g.entered <- struct{}{}:
		<-g.release
	default:
	}
	return g.Driver.Create(ctx, spec)
}

// A claim acked but not yet through prepare's lease tracking (its network
// or pool adoption still running) has no lease: it is booting, not dead,
// and the reaper leaves it alone.
func TestABootingClaimWithoutALeaseYetIsNotReaped(t *testing.T) {
	entered := make(chan struct{}, 1)
	h := newHarness(t, func(c *Config) {
		c.Driver = blockingPrepare{Driver: c.Driver.(*fake.Driver), entered: entered}
	})
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, h.acquireBody()); err != nil {
		t.Fatal(err)
	}
	<-entered
	if _, tracked := h.a.leases.Get("claim-1"); tracked {
		t.Fatal("setup: the lease is already tracked")
	}
	h.clk.Advance(time.Minute)
	h.a.ReapDeadClaims(context.Background())
	// The reap decision is logged synchronously; the release itself runs in the background.
	if strings.Contains(h.logs.String(), "claim.reaped") {
		t.Fatal("a booting claim was reaped before its lease was tracked")
	}
	c, ok := h.a.claims.Get("claim-1")
	if !ok || c.State() != claims.Acquiring {
		t.Fatal("the booting claim left Acquiring")
	}
	// The hung preparation ends with the claim's release.
	if err := h.handle("claim-1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	h.a.Wait()
}

// blockingPrepare is the fake driver whose PrepareClaim waits for its context.
type blockingPrepare struct {
	*fake.Driver
	entered chan struct{}
}

func (b blockingPrepare) PrepareClaim(ctx context.Context, spec driver.ClaimNetworkSpec) (driver.ClaimNetwork, error) {
	select {
	case b.entered <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return driver.ClaimNetwork{}, ctx.Err()
}
