//go:build unix

package agent

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
)

// A cell whose sandboxes are the fake driver's with the real guest agent.
func newSandboxHarness(t *testing.T, pool int) (*harness, string) {
	t.Helper()
	root := t.TempDir()
	h := newHarness(t, func(c *Config) {
		c.Parts.Sandboxes = fake.Sandboxes{Driver: c.Driver.(*fake.Driver), Root: root}
		c.SandboxPool = pool
	})
	return h, root
}

func (h *harness) sandboxBody(org string) *protocol.SandboxAcquireBody {
	return &protocol.SandboxAcquireBody{OrgID: org, HardExpiresAt: protocol.FormatTime(h.clk.Now().Add(40 * time.Minute)), EgressAllow: []string{"github.com"}}
}

func (h *harness) sandboxReady(claimID, org string) *protocol.ClaimReadyBody {
	h.t.Helper()
	if err := h.handle(claimID, protocol.MessageTypeSandboxAcquire, h.sandboxBody(org)); err != nil {
		h.t.Fatalf("sandbox.acquire: %v", err)
	}
	return h.conn.next(h.t, isReady).(*protocol.ClaimReadyBody)
}

func (h *harness) op(claimID string, op protocol.SandboxOp) *protocol.StepResultBody {
	h.t.Helper()
	step := hubclient.NewID()
	if err := h.handle(claimID, protocol.MessageTypeSandboxOp, &protocol.SandboxOpBody{StepID: step, Op: op}); err != nil {
		h.t.Fatalf("sandbox.op: %v", err)
	}
	return h.conn.next(h.t, isResult(step)).(*protocol.StepResultBody)
}

func i64(n int64) *int64 { return &n }
func boolp(b bool) *bool { return &b }

func TestASandboxBootsOneMachineAndItsGuestAgentAnswers(t *testing.T) {
	h, _ := newSandboxHarness(t, 0)
	ready := h.sandboxReady("sbx-1", "org-a")
	if len(ready.Manifest.Services) != 0 || ready.Manifest.ImageID != "sandbox" {
		t.Fatalf("manifest %+v", ready.Manifest)
	}
	if n := len(h.drv.Machines()); n != 1 {
		t.Fatalf("%d machines, want the sandbox alone (no observer)", n)
	}
	content := base64.StdEncoding.EncodeToString([]byte("hello\n"))
	if r := h.op("sbx-1", protocol.SandboxOp{Op: protocol.SandboxOpKindWrite, Path: str("repo/a.txt"), Content: &content, Mkdirs: boolp(true)}); r.Sandbox == nil || !r.Sandbox.Ok {
		t.Fatalf("write: %+v", r)
	}
	r := h.op("sbx-1", protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: str("cat a.txt"), Cwd: str("repo"), TimeoutMs: i64(5000)})
	if r.Executor != protocol.ExecutorVM || r.Sandbox == nil || r.Sandbox.Exec == nil || r.Sandbox.Exec.Stdout != "hello\n" {
		t.Fatalf("exec: %+v", r)
	}
	// The egress policy names the hosts the acquire allowed.
	h.egress.mu.Lock()
	defer h.egress.mu.Unlock()
	if len(h.egress.applied) == 0 || !strings.Contains(strings.Join(h.egress.applied[len(h.egress.applied)-1].ExtraAllow, ","), "github.com") {
		t.Fatalf("egress %+v", h.egress.applied)
	}
}

func TestAReleasedSandboxIsGone(t *testing.T) {
	h, root := newSandboxHarness(t, 0)
	h.sandboxReady("sbx-1", "org-a")
	m := h.drv.Machines()[0].Ref
	if err := h.handle("sbx-1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	h.a.Wait()
	if len(h.drv.Machines()) != 0 || len(h.egress.removedIDs()) != 1 {
		t.Fatalf("machines %v, egress removed %v", h.drv.Machines(), h.egress.removedIDs())
	}
	if _, err := (fake.Sandboxes{Driver: h.drv, Root: root}).DialGuest(context.Background(), m); err == nil {
		t.Fatal("the released sandbox's guest agent still answers")
	}
	if _, err := os.Stat(filepath.Join(root, m.MachineID)); !os.IsNotExist(err) {
		t.Fatal("the released sandbox's files are still there")
	}
	err := h.handle("sbx-1", protocol.MessageTypeSandboxOp, &protocol.SandboxOpBody{StepID: hubclient.NewID(), Op: protocol.SandboxOp{Op: protocol.SandboxOpKindStat}})
	if nackCode(err) != "unknown_claim" {
		t.Fatalf("op after release: %v", err)
	}
}

func TestASandboxClaimTakesNoOtherStep(t *testing.T) {
	h, _ := newSandboxHarness(t, 0)
	h.sandboxReady("sbx-1", "org-a")
	if err := h.handle("sbx-1", protocol.MessageTypeExec, &protocol.ExecBody{StepID: hubclient.NewID(), Command: "id", TimeoutMs: 1000}); nackCode(err) != "not_supported" {
		t.Fatalf("exec: %v", err)
	}
	if err := h.handle("sbx-1", protocol.MessageTypeMachineReset, &protocol.MachineResetBody{StepID: hubclient.NewID(), Snapshot: protocol.Snapshot{Kind: "compose_volumes", Ref: "x"}}); nackCode(err) != "not_supported" {
		t.Fatalf("reset: %v", err)
	}
	// And a sandbox.op never runs on a claim that is not a sandbox.
	h.ready("run-1")
	if err := h.handle("run-1", protocol.MessageTypeSandboxOp, &protocol.SandboxOpBody{StepID: hubclient.NewID(), Op: protocol.SandboxOp{Op: protocol.SandboxOpKindStat}}); nackCode(err) != "not_supported" {
		t.Fatalf("sandbox.op on a Run claim: %v", err)
	}
	b := h.acquireBody()
	b.Consumer = protocol.ConsumerSandbox
	if err := h.handle("run-2", protocol.MessageTypeClaimAcquire, b); nackCode(err) != "invalid_body" {
		t.Fatalf("claim.acquire of consumer sandbox: %v", err)
	}
}

func TestACellWithoutSandboxesNamesNoneAndRefusesThem(t *testing.T) {
	h := newHarness(t)
	for _, f := range h.a.Hello().Features {
		if f == protocol.FeatureSandbox {
			t.Fatal("named sandbox")
		}
	}
	if err := h.handle("sbx-1", protocol.MessageTypeSandboxAcquire, h.sandboxBody("org-a")); nackCode(err) != "not_supported" {
		t.Fatalf("sandbox.acquire: %v", err)
	}
	s, _ := newSandboxHarness(t, 0)
	named := false
	for _, f := range s.a.Hello().Features {
		named = named || f == protocol.FeatureSandbox
	}
	if !named {
		t.Fatal("a cell with sandboxes does not name them")
	}
}

func TestADeadGuestAgentIsDialledAgainOnTheNextOp(t *testing.T) {
	h, _ := newSandboxHarness(t, 0)
	h.sandboxReady("sbx-1", "org-a")
	_ = h.a.guests.get("sbx-1").Close()
	if r := h.op("sbx-1", protocol.SandboxOp{Op: protocol.SandboxOpKindStat}); r.Sandbox == nil || !r.Sandbox.Ok {
		t.Fatalf("stat after the stream died: %+v", r)
	}
}

// runPool runs the sandbox pool as Run does, owned by the test: its end
// stops the pool and waits for it (its drain too) before the sandboxes'
// directories go. A pool run on a bare goroutine kept making a sandbox
// while TempDir's cleanup removed its root ("directory not empty").
func (h *harness) runPool() {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.a.sandboxPool.run(ctx)
	}()
	h.t.Cleanup(func() {
		cancel()
		<-done
	})
}

func waitPool(t *testing.T, a *Agent, n int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for a.sandboxPool.Ready() < n {
		if time.Now().After(deadline) {
			t.Fatalf("the pool has %d ready, want %d", a.sandboxPool.Ready(), n)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestTwoOrgsNeverShareAPooledSandbox(t *testing.T) {
	h, _ := newSandboxHarness(t, 2)
	h.runPool()
	waitPool(t, h.a, 2)
	h.sandboxReady("sbx-a", "org-a")
	h.sandboxReady("sbx-b", "org-b")
	a, b := h.a.claimMachine("sbx-a"), h.a.claimMachine("sbx-b")
	if a.MachineID == b.MachineID || a.Tags[driver.TagRole] != string(driver.RolePool) || b.Tags[driver.TagRole] != string(driver.RolePool) {
		t.Fatalf("sbx-a on %s, sbx-b on %s", a.MachineID, b.MachineID)
	}
	// What one org wrote is not in the other's.
	content := base64.StdEncoding.EncodeToString([]byte("org a only"))
	h.op("sbx-a", protocol.SandboxOp{Op: protocol.SandboxOpKindWrite, Path: str("secret"), Content: &content})
	if r := h.op("sbx-b", protocol.SandboxOp{Op: protocol.SandboxOpKindRead, Path: str("secret")}); r.Sandbox.Ok {
		t.Fatal("org b read org a's file")
	}
	// Released, the pooled machine is destroyed and never handed out again.
	if err := h.handle("sbx-a", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	gone := func() bool {
		for _, m := range h.drv.Machines() {
			if m.Ref.MachineID == a.MachineID {
				return false
			}
		}
		return true
	}
	for deadline := time.Now().Add(10 * time.Second); !gone(); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the released pooled sandbox is still there")
		}
	}
	waitPool(t, h.a, 2)
	h.sandboxReady("sbx-c", "org-a")
	if c := h.a.claimMachine("sbx-c"); c.MachineID == a.MachineID {
		t.Fatal("a released sandbox was handed out again")
	}
}

func (a *Agent) claimMachine(id string) driver.MachineRef {
	c, _ := a.claims.Get(id)
	return c.Machines().Workload
}

// ctxBoundSandboxes ends each guest stream with the context it was dialled
// with, as a docker exec started with exec.CommandContext does.
type ctxBoundSandboxes struct{ fake.Sandboxes }

func (s ctxBoundSandboxes) DialGuest(ctx context.Context, ref driver.MachineRef) (io.ReadWriteCloser, error) {
	rw, err := s.Sandboxes.DialGuest(ctx, ref)
	if err == nil {
		go func() { <-ctx.Done(); _ = rw.Close() }()
	}
	return rw, err
}

func TestASandboxStreamOutlivesThePreparationThatOpenedIt(t *testing.T) {
	root := t.TempDir()
	h := newHarness(t, func(c *Config) {
		c.Parts.Sandboxes = ctxBoundSandboxes{fake.Sandboxes{Driver: c.Driver.(*fake.Driver), Root: root}}
	})
	h.sandboxReady("sbx-1", "org-a")
	first := h.a.guests.get("sbx-1")
	if r := h.op("sbx-1", protocol.SandboxOp{Op: protocol.SandboxOpKindStat}); r.Sandbox == nil || !r.Sandbox.Ok {
		t.Fatalf("stat: %+v", r)
	}
	if h.a.guests.get("sbx-1") != first {
		t.Fatal("the stream opened at boot ended with the boot and was dialled again")
	}
}

// withSandboxSize gives the cell a sandbox size of its own (-sandbox-memory-mb,
// -sandbox-cpus) under a maximum of 16 GB and 8 CPUs.
func withSandboxSize(memoryMB, cpus int) func(*Config) {
	return func(c *Config) {
		fakeOf(c.Driver).MaxClaimSize = driver.ClaimSize{MemoryMB: 16_384, CPUs: 8}
		c.SandboxSize = driver.ClaimSize{MemoryMB: memoryMB, CPUs: cpus}
	}
}

func fakeOf(d driver.MachineDriver) *fake.Driver { return d.(*fake.Driver) }

func withSandboxes(root string, pool int) func(*Config) {
	return func(c *Config) {
		c.Parts.Sandboxes, c.SandboxPool = fake.Sandboxes{Driver: fakeOf(c.Driver), Root: root}, pool
	}
}

func (h *harness) machineOf(claimID string) fake.Machine {
	h.t.Helper()
	id := h.a.claimMachine(claimID).MachineID
	for _, m := range h.drv.Machines() {
		if m.Ref.MachineID == id {
			return m
		}
	}
	h.t.Fatalf("no machine for %s", claimID)
	return fake.Machine{}
}

// A sandbox opened with no size reserves the sandbox default, not the Run
// size. It used to get the cell's default Run size: its machine's memory limit
// was -gvisor-mem-limit (12 GB on cell-dev-1) while the cell counted 2 GB, and
// the hub, told nothing, admitted it at 12 GB.
func TestASandboxOpenedWithNoSizeReservesTheSandboxDefaultNotTheRunSize(t *testing.T) {
	h := newHarness(t, withMemory(14_745), withSandboxSize(2_048, 2), withSandboxes(t.TempDir(), 0))
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureCellMemory}})
	if got := h.a.Hello().Capabilities.SandboxSize; got == nil || *got != (protocol.MachineSize{MemoryMb: 2_048, Cpus: 2}) {
		t.Fatalf("hello sandboxSize %+v, want 2048 MB / 2 CPUs", got)
	}
	h.sandboxReady("sbx-1", "org-a")
	if got := h.machineOf("sbx-1").Spec.ClaimSize; got != (driver.ClaimSize{MemoryMB: 2_048, CPUs: 2}) {
		t.Fatalf("the sandbox's machine is %s, want the sandbox size", got)
	}
	if got := h.a.Heartbeat().Memory.CommittedMb; got != 2_048 {
		t.Fatalf("committed %d MB, want the sandbox size", got)
	}
}

// A sandbox that asks a larger size, within the cell's maximum, runs and is
// counted at it from its boot: it used to be counted at the cell's ready
// figure (2 GB) whatever it asked.
func TestASandboxThatAsksALargerSizeIsCountedAtIt(t *testing.T) {
	h := newHarness(t, withMemory(14_745), withSandboxSize(2_048, 2), withSandboxes(t.TempDir(), 0))
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureCellMemory}})
	body := h.sandboxBody("org-a")
	body.Size = &protocol.MachineSize{MemoryMb: 8_192, Cpus: 4}
	if err := h.handle("sbx-1", protocol.MessageTypeSandboxAcquire, body); err != nil {
		t.Fatalf("sandbox.acquire: %v", err)
	}
	h.conn.next(t, isReady)
	if got := h.machineOf("sbx-1").Spec.ClaimSize; got != (driver.ClaimSize{MemoryMB: 8_192, CPUs: 4}) {
		t.Fatalf("the sandbox's machine is %s", got)
	}
	if got := h.a.Heartbeat().Memory.CommittedMb; got != 8_192 {
		t.Fatalf("committed %d MB, want the size it asked", got)
	}
}

// vmBudgetDriver counts a sandbox for more than its memory, as the microvm
// driver does: its VMM and page cache room on top of its guest's memory.
type vmBudgetDriver struct{}

func (vmBudgetDriver) SandboxMemoryMB(size driver.ClaimSize) int {
	if size.MemoryMB == 0 {
		size.MemoryMB = 12_288
	}
	return size.MemoryMB + 896
}

// On a cell whose machines are microVMs a sandbox holds its VMM and page
// cache as well as its guest's memory: the cell counts it at the driver's
// figure, not at its size alone, which would let the cell commit more than
// the host holds.
func TestASandboxIsCountedAtWhatTheDriverSaysItsMachineHolds(t *testing.T) {
	vm := func(c *Config) { c.Parts.SandboxMemory = vmBudgetDriver{} }
	h := newHarness(t, withMemory(14_745), vm, withSandboxSize(2_048, 2), withSandboxes(t.TempDir(), 0))
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureCellMemory}})
	h.sandboxReady("sbx-1", "org-a")
	if got := h.a.Heartbeat().Memory.CommittedMb; got != 2_048+896 {
		t.Fatalf("committed %d MB, want the sandbox's guest and VMM", got)
	}
	if got := h.a.sandboxMemoryMB(driver.ClaimSize{MemoryMB: 4_096, CPUs: 2}); got != 4_096+896 {
		t.Fatalf("a 4 GiB sandbox is counted at %d MB", got)
	}
}

// A sandbox size the cell does not grant is refused at startup, not at the
// first sandbox.
func TestASandboxSizeAboveTheCellsMaximumIsRefusedAtStartup(t *testing.T) {
	d := fake.New()
	d.Isolation, d.MaxClaimSize = driver.IsolationVM, driver.ClaimSize{MemoryMB: 4_096, CPUs: 2}
	cfg := Config{
		CellID: "cell-1", Driver: d, Transport: stubTransport{},
		Observers: func(context.Context, ClaimInfo, []observer.Target) (observer.Client, error) {
			return nil, errors.New("no observer")
		},
		Repo:      func(protocol.ClaimAcquireBody) (string, error) { return "", nil },
		Extractor: tarball.InProcessExtractor{}, Revoker: nopRevoker{}, OrgKey: func(string) (string, error) { return "k", nil },
		Parts:       driver.Parts{Sandboxes: fake.Sandboxes{Driver: d, Root: t.TempDir()}},
		SandboxSize: driver.ClaimSize{MemoryMB: 8_192, CPUs: 2},
	}
	if _, err := New(cfg); err == nil || !strings.Contains(err.Error(), "sandbox size") {
		t.Fatalf("New: %v", err)
	}
}

// Blank sandboxes hold memory the cell admits claims from: the pool makes
// only what fits, a claim that takes one is counted for it instead, at the
// same size, and the pool refills once a claim gives memory back. A claim of
// another size never takes one.
func TestBlankSandboxesAreCountedInTheCellsMemory(t *testing.T) {
	root := t.TempDir()
	h := newHarness(t, withMemory(5_000), withSandboxSize(2_048, 2), withSandboxes(root, 3))
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureCellMemory}})
	h.runPool()
	waitPool(t, h.a, 2)
	if got := h.a.Heartbeat().Memory.CommittedMb; got != 4_096 || h.a.sandboxPool.Ready() != 2 {
		t.Fatalf("committed %d MB with %d blank sandboxes, want two of 2048 MB (a third does not fit)", got, h.a.sandboxPool.Ready())
	}
	h.sandboxReady("sbx-1", "org-a")
	if got := h.a.Heartbeat().Memory.CommittedMb; got != 4_096 || h.a.sandboxPool.Ready() != 1 {
		t.Fatalf("after a claim took one: committed %d MB, %d blank", got, h.a.sandboxPool.Ready())
	}
	if err := h.handle("sbx-1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	h.a.Wait() // the release's cleanup gives the memory back
	h.a.sandboxPool.wake()
	waitPool(t, h.a, 2)
	if got := h.a.Heartbeat().Memory.CommittedMb; got != 4_096 {
		t.Fatalf("after the release and the refill: committed %d MB", got)
	}
	// A sandbox of another size makes its own machine, counted at its size: no blank is taken.
	body := h.sandboxBody("org-a")
	body.Size = &protocol.MachineSize{MemoryMb: 512, Cpus: 1}
	if err := h.handle("sbx-2", protocol.MessageTypeSandboxAcquire, body); err != nil {
		t.Fatalf("sandbox.acquire: %v", err)
	}
	h.conn.next(t, isReady)
	if m := h.machineOf("sbx-2"); m.Spec.Role == driver.RolePool || m.Spec.ClaimSize != (driver.ClaimSize{MemoryMB: 512, CPUs: 1}) || h.a.sandboxPool.Ready() != 2 || h.a.Heartbeat().Memory.CommittedMb != 4_608 {
		t.Fatalf("sbx-2 on a %s %s machine, %d blank, committed %d MB", m.Spec.Role, m.Spec.ClaimSize, h.a.sandboxPool.Ready(), h.a.Heartbeat().Memory.CommittedMb)
	}
}

// slowGuest is a sandbox whose guest agent is still booting for its first dials.
type slowGuest struct {
	fake.Sandboxes
	mu    *sync.Mutex
	fails *int
}

func (s slowGuest) DialGuest(ctx context.Context, ref driver.MachineRef) (io.ReadWriteCloser, error) {
	s.mu.Lock()
	if *s.fails > 0 {
		*s.fails--
		s.mu.Unlock()
		return nil, errors.New("vsock: the guest does not answer on that port: EOF")
	}
	s.mu.Unlock()
	return s.Sandboxes.DialGuest(ctx, ref)
}

// A sandbox whose guest agent is still booting when the machine is made is
// dialled again until it answers. The first dial used to be the only one: a
// microVM sandbox through the cell failed guest_agent ("the guest does not
// answer on that port: EOF") 0.4 s before its guest agent came up.
func TestASandboxWhoseGuestAgentIsStillBootingIsDialledUntilItAnswers(t *testing.T) {
	root := t.TempDir()
	fails, mu := 3, &sync.Mutex{}
	h := newHarness(t, func(c *Config) {
		c.Parts.Sandboxes = slowGuest{Sandboxes: fake.Sandboxes{Driver: c.Driver.(*fake.Driver), Root: root}, mu: mu, fails: &fails}
	})
	h.sandboxReady("sbx-slow", "org-a")
	if fails != 0 {
		t.Fatalf("%d dials left", fails)
	}
}
