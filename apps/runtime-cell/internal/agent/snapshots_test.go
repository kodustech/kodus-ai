//go:build unix

package agent

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/vmsnap"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// fakeSnapshots plays a snapshot driver over the fake sandboxes: a template
// or a session ends the machine, a round keeps it, a restore makes a new one.
type fakeSnapshots struct {
	sb        fake.Sandboxes
	mu        sync.Mutex
	made      []driver.MachineSpec
	restored  []driver.MemorySnapshot
	resets    []driver.MemorySnapshot
	templates map[string]driver.MemorySnapshot // org/key
	n         int
	forgotten []string // org/id
	// refuse fails every snapshot with this error.
	refuse error
}

func (f *fakeSnapshots) ForgetSession(_ context.Context, org, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.forgotten = append(f.forgotten, org+"/"+id)
	return nil
}

func (f *fakeSnapshots) SnapshotMachine(ctx context.Context, ref driver.MachineRef, purpose, key string) (driver.MemorySnapshot, driver.MachineRef, error) {
	f.mu.Lock()
	if f.refuse != nil {
		f.mu.Unlock()
		return driver.MemorySnapshot{}, driver.MachineRef{}, f.refuse
	}
	f.n++
	s := driver.MemorySnapshot{ID: fmt.Sprintf("ksn-%032x", f.n), OrgID: ref.Tags[driver.TagOrg], Purpose: purpose}
	if purpose == "template" {
		f.templates[s.OrgID+"/"+key] = s
	}
	f.mu.Unlock()
	if purpose == "round" {
		return s, ref, nil
	}
	return s, driver.MachineRef{}, f.sb.Driver.Destroy(ctx, ref)
}

func (f *fakeSnapshots) LatestTemplate(_ context.Context, org, key string) (driver.MemorySnapshot, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.templates[org+"/"+key]
	return s, ok, nil
}

func (f *fakeSnapshots) CreateSandboxFromSnapshot(ctx context.Context, req driver.SandboxRequest, s driver.MemorySnapshot) (driver.MachineRef, error) {
	f.mu.Lock()
	f.restored = append(f.restored, s)
	f.mu.Unlock()
	return f.sb.CreateSandbox(ctx, req)
}

func (f *fakeSnapshots) ResetToSnapshot(_ context.Context, ref driver.MachineRef, s driver.MemorySnapshot) (driver.MachineRef, error) {
	f.mu.Lock()
	f.resets = append(f.resets, s)
	f.mu.Unlock()
	return ref, nil
}

// recordingSandboxes records the specs the agent asks of sandboxes.
type recordingSandboxes struct {
	fake.Sandboxes
	f *fakeSnapshots
}

func (r recordingSandboxes) CreateSandbox(ctx context.Context, req driver.SandboxRequest) (driver.MachineRef, error) {
	r.f.mu.Lock()
	r.f.made = append(r.f.made, req.Spec)
	r.f.mu.Unlock()
	return r.Sandboxes.CreateSandbox(ctx, req)
}

func newSnapshotHarness(t *testing.T) (*harness, *fakeSnapshots) {
	t.Helper()
	root := t.TempDir()
	f := &fakeSnapshots{templates: map[string]driver.MemorySnapshot{}}
	h := newHarness(t, func(c *Config) {
		f.sb = fake.Sandboxes{Driver: c.Driver.(*fake.Driver), Root: root}
		c.Parts.Sandboxes = recordingSandboxes{Sandboxes: f.sb, f: f}
		c.Parts.Snapshots, c.Parts.Sessions = f, f
	})
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureReadyStart, protocol.FeatureSnapshots}})
	return h, f
}

func (h *harness) snapshot(claimID string, purpose protocol.ClaimSnapshotBodyPurpose) (*protocol.StepResultBody, error) {
	h.t.Helper()
	step := hubclient.NewID()
	if err := h.handle(claimID, protocol.MessageTypeClaimSnapshot, &protocol.ClaimSnapshotBody{StepID: step, Purpose: purpose}); err != nil {
		return nil, err
	}
	return h.conn.next(h.t, isResult(step)).(*protocol.StepResultBody), nil
}

// A sandbox that prepares a template is made as a setup's machine and not
// marked as having run untrusted code; it becomes its org's template under
// its key; a later sandbox of the key starts from it and says so; another
// org's sandbox of the same key boots cold.
func TestASandboxThatPreparesATemplateServesTheNextOneOfItsKey(t *testing.T) {
	h, f := newSnapshotHarness(t)
	body := h.sandboxBody("org-a")
	body.Prepares, body.TemplateKey, body.EgressAllow = boolp(true), str("repo:kodus-ai"), nil
	if err := h.handle("sbx-tpl", protocol.MessageTypeSandboxAcquire, body); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	if len(f.made) != 1 || !f.made[0].Setup || f.made[0].Secrets {
		t.Fatalf("the preparing sandbox's spec %+v", f.made)
	}
	if c, _ := h.a.claims.Get("sbx-tpl"); h.a.origin.Tainted(c.Machines().Workload.MachineID) {
		t.Fatal("a preparing sandbox counted as having run untrusted code")
	}
	r, err := h.snapshot("sbx-tpl", protocol.ClaimSnapshotBodyPurposeTemplate)
	if err != nil || r.Snapshot == nil || r.Snapshot.Purpose != protocol.ClaimSnapshotBodyPurposeTemplate || r.VMHealth != protocol.VMHealthOk {
		t.Fatalf("template %+v %v", r, err)
	}
	from := h.sandboxBody("org-a")
	from.TemplateKey = str("repo:kodus-ai")
	if err := h.handle("sbx-run", protocol.MessageTypeSandboxAcquire, from); err != nil {
		t.Fatal(err)
	}
	ready := h.conn.next(t, isReady).(*protocol.ClaimReadyBody)
	if ready.Start == nil || *ready.Start != protocol.ClaimReadyBodyStartTemplate || len(f.restored) != 1 || f.restored[0].ID != r.Snapshot.ID {
		t.Fatalf("start %v restored %+v", ready.Start, f.restored)
	}
	if c, _ := h.a.claims.Get("sbx-run"); !h.a.origin.Tainted(c.Machines().Workload.MachineID) {
		t.Fatal("a sandbox restored for use is not marked as running untrusted code")
	}
	other := h.sandboxBody("org-b")
	other.TemplateKey = str("repo:kodus-ai")
	if err := h.handle("sbx-b", protocol.MessageTypeSandboxAcquire, other); err != nil {
		t.Fatal(err)
	}
	if ready := h.conn.next(t, isReady).(*protocol.ClaimReadyBody); ready.Start == nil || *ready.Start != protocol.ClaimReadyBodyStartCold || len(f.restored) != 1 {
		t.Fatalf("org b's sandbox: start %v restored %+v", ready.Start, f.restored)
	}
}

// Only a sandbox that prepares a template becomes one (the cell refuses
// before the driver is asked); any sandbox may set itself aside as a session.
func TestOnlyAPreparingSandboxBecomesATemplate(t *testing.T) {
	h, _ := newSnapshotHarness(t)
	h.sandboxReady("sbx-1", "org-a")
	if _, err := h.snapshot("sbx-1", protocol.ClaimSnapshotBodyPurposeTemplate); err == nil {
		t.Fatal("a sandbox for use became a template")
	}
	if r, err := h.snapshot("sbx-1", protocol.ClaimSnapshotBodyPurposeSession); err != nil || r.Snapshot == nil {
		t.Fatalf("session %+v %v", r, err)
	}
}

// A claim's round snapshot is the one its memory resets go back to: a
// reset to another snapshot id fails the round (never boots something
// else), and a cell with no snapshot driver refuses both.
func TestAMemoryResetGoesBackToTheClaimsOwnRound(t *testing.T) {
	h, f := newSnapshotHarness(t)
	h.sandboxReady("sbx-1", "org-a")
	r, err := h.snapshot("sbx-1", protocol.ClaimSnapshotBodyPurposeRound)
	if err != nil || r.Snapshot == nil {
		t.Fatalf("round %+v %v", r, err)
	}
	reset := func(ref string) *protocol.StepResultBody {
		step := hubclient.NewID()
		if err := h.handle("sbx-1", protocol.MessageTypeMachineReset, &protocol.MachineResetBody{StepID: step, Snapshot: protocol.Snapshot{Kind: protocol.SnapshotKindMemory, Ref: ref}}); err != nil {
			t.Fatalf("machine.reset: %v", err)
		}
		return h.conn.next(t, isResult(step)).(*protocol.StepResultBody)
	}
	if res := reset(r.Snapshot.ID); res.Exec != nil || len(f.resets) != 1 {
		t.Fatalf("reset to the round %+v (resets %v)", res, f.resets)
	}
	if res := reset("ksn-00000000000000000000000000000000"); res.Exec == nil || res.Exec.ExitCode == 0 || len(f.resets) != 1 {
		t.Fatalf("a reset to another snapshot: %+v", res)
	}
	if res := h.op("sbx-1", protocol.SandboxOp{Op: protocol.SandboxOpKindStat}); res.Sandbox == nil || !res.Sandbox.Ok {
		t.Fatalf("the guest agent after the resets: %+v", res)
	}

	plain, _ := newSandboxHarness(t, 0)
	plain.sandboxReady("sbx-2", "org-a")
	err = plain.handle("sbx-2", protocol.MessageTypeClaimSnapshot, &protocol.ClaimSnapshotBody{StepID: hubclient.NewID(), Purpose: protocol.ClaimSnapshotBodyPurposeRound})
	if nackCode(err) != "snapshot_unsupported" {
		t.Fatalf("a cell with no snapshot driver: %v", err)
	}
	body := plain.sandboxBody("org-a")
	body.Prepares, body.TemplateKey, body.EgressAllow = boolp(true), str("repo:a"), nil
	if err := plain.handle("sbx-3", protocol.MessageTypeSandboxAcquire, body); nackCode(err) != "snapshot_unsupported" {
		t.Fatalf("a preparing sandbox on a cell with no snapshot driver: %v", err)
	}
}

// A round the store's room refuses never touched the machine: the step
// says it runs (vmHealth ok) and the guest still answers; a snapshot that
// failed otherwise may have ended it and says unreachable.
func TestARefusedSnapshotLeavesTheMachineHealthy(t *testing.T) {
	h, f := newSnapshotHarness(t)
	h.sandboxReady("sbx-1", "org-a")
	f.refuse = fmt.Errorf("firecracker: %w", &vmsnap.RefusedError{Reason: "the store's file system has 9 GB free"})
	r, err := h.snapshot("sbx-1", protocol.ClaimSnapshotBodyPurposeRound)
	if err != nil || r.Snapshot != nil || r.VMHealth != protocol.VMHealthOk {
		t.Fatalf("a refused round: %+v %v", r, err)
	}
	if res := h.op("sbx-1", protocol.SandboxOp{Op: protocol.SandboxOpKindStat}); res.Sandbox == nil || !res.Sandbox.Ok {
		t.Fatalf("the guest agent after a refused round: %+v", res)
	}
	f.refuse = errors.New("firecracker: PUT /snapshot/create: EOF")
	if r, err := h.snapshot("sbx-1", protocol.ClaimSnapshotBodyPurposeRound); err != nil || r.VMHealth != protocol.VMHealthUnreachable {
		t.Fatalf("a failed round: %+v %v", r, err)
	}
}

// snapshot.forget removes each named session of the org through the driver
// (a PR closed); the cell names snapshotForget only when its driver can.
func TestSnapshotForgetRemovesTheOrgsSessions(t *testing.T) {
	h, f := newSnapshotHarness(t)
	if hello := h.a.Hello(); !slices.Contains(hello.Features, protocol.FeatureSnapshotForget) {
		t.Fatalf("features %v lack snapshotForget", hello.Features)
	}
	ids := []string{fmt.Sprintf("ksn-%032x", 7), fmt.Sprintf("ksn-%032x", 8)}
	if err := h.handle("", protocol.MessageTypeSnapshotForget, &protocol.SnapshotForgetBody{OrgID: "org-a", SnapshotIds: ids}); err != nil {
		t.Fatal(err)
	}
	if len(f.forgotten) != 2 || f.forgotten[0] != "org-a/"+ids[0] || f.forgotten[1] != "org-a/"+ids[1] {
		t.Fatalf("forgotten %v", f.forgotten)
	}
}

// A sandbox that prepares a template, or starts from one, makes its own
// machine: the blank pool sandbox stays in the pool for the next claim that
// can use it, never taken and left with no claim to end it.
func TestASandboxWithASnapshotPlanLeavesTheBlankPoolSandboxInThePool(t *testing.T) {
	root := t.TempDir()
	f := &fakeSnapshots{templates: map[string]driver.MemorySnapshot{}}
	h := newHarness(t, func(c *Config) {
		f.sb = fake.Sandboxes{Driver: c.Driver.(*fake.Driver), Root: root}
		c.Parts.Sandboxes = recordingSandboxes{Sandboxes: f.sb, f: f}
		c.Parts.Snapshots = f
		c.SandboxPool = 1
	})
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureReadyStart, protocol.FeatureSnapshots}})
	// One fill and no pool loop: a sandbox taken from the pool is not made again behind the test.
	h.a.sandboxPool.fill(context.Background())
	if h.a.sandboxPool.Ready() != 1 {
		t.Fatalf("the pool has %d ready, want 1", h.a.sandboxPool.Ready())
	}
	blank := h.a.sandboxPool.ready[0].ref.MachineID

	prepares := h.sandboxBody("org-a")
	prepares.Prepares, prepares.TemplateKey, prepares.EgressAllow = boolp(true), str("repo:kodus-ai"), nil
	if err := h.handle("sbx-tpl", protocol.MessageTypeSandboxAcquire, prepares); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	if got := h.a.claimMachine("sbx-tpl").MachineID; got == blank || h.a.sandboxPool.Ready() != 1 {
		t.Fatalf("the preparing sandbox runs on %s (blank %s), the pool has %d ready", got, blank, h.a.sandboxPool.Ready())
	}
	if _, err := h.snapshot("sbx-tpl", protocol.ClaimSnapshotBodyPurposeTemplate); err != nil {
		t.Fatal(err)
	}

	from := h.sandboxBody("org-a")
	from.TemplateKey = str("repo:kodus-ai")
	if err := h.handle("sbx-run", protocol.MessageTypeSandboxAcquire, from); err != nil {
		t.Fatal(err)
	}
	if ready := h.conn.next(t, isReady).(*protocol.ClaimReadyBody); ready.Start == nil || *ready.Start != protocol.ClaimReadyBodyStartTemplate {
		t.Fatalf("start %v", ready.Start)
	}
	if got := h.a.claimMachine("sbx-run").MachineID; got == blank || h.a.sandboxPool.Ready() != 1 {
		t.Fatalf("the restored sandbox runs on %s (blank %s), the pool has %d ready", got, blank, h.a.sandboxPool.Ready())
	}

	// A plain sandbox still takes it.
	h.sandboxReady("sbx-plain", "org-a")
	if got := h.a.claimMachine("sbx-plain").MachineID; got != blank {
		t.Fatalf("the plain sandbox runs on %s, want the blank one %s", got, blank)
	}
}
