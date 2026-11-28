package firecracker

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guestinit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/vmsnap"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/hostnet"
)

func snapBackend(t *testing.T) (*Backend, *fakeVMM, *fakeNet) {
	t.Helper()
	vmm := &fakeVMM{t: t, state: map[string]string{}, args: map[string][]string{}}
	n := &fakeNet{taps: map[string]hostnet.Attachment{}}
	b := newBackend(t, vmm, n)
	b.store.Chown = func(string, int, int) error { return nil }
	return b, vmm, n
}

func setupSandbox(t *testing.T, b *Backend, name, network string, taints ...isolation.Taint) isolation.Machine {
	t.Helper()
	m, err := b.Create(context.Background(), isolation.Spec{
		Shape: isolation.ShapeSandbox, Name: name, Network: network, Memory: "128m", CPUs: "1", Org: "org-a", Setup: true, Taints: taints,
	})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func clone(t *testing.T, b *Backend, snap isolation.SnapshotRef, name, network, org string) (isolation.Machine, error) {
	t.Helper()
	return b.Restore(context.Background(), snap, isolation.Spec{Shape: isolation.ShapeSandbox, Name: name, Network: network, Org: org})
}

// A template is taken only once the guest's init froze the workload, with
// the VMM paused, the files left for the cell to sync; then its source
// ends, and the store holds the state and the memory file, read-only.
func TestATemplateIsTakenFrozenPausedAndEndsItsSource(t *testing.T) {
	b, vmm, _ := snapBackend(t)
	ctx := context.Background()
	src := setupSandbox(t, b, "kodus-setup-workload", "kodus-setup")
	snap, err := b.Snapshot(ctx, "kodus-setup-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"control prepare", "vm Paused", "snapshot/create sync=false"}
	if got := vmm.callsOf(src.ID); !slices.Equal(got, want) {
		t.Fatalf("the snapshot's steps %v, want %v", got, want)
	}
	if left := b.Remains("kodus-setup-workload"); len(left) > 0 {
		t.Fatalf("the template's source still holds %v: a machine that ran on after its snapshot would share what its clones hold", left)
	}
	m, dir, err := b.store.Open("org-a", snap.ID)
	if err != nil || m.Shape != isolation.ShapeSandbox || m.MemoryMB != 128 || m.Kit != b.cfg.Kit.Digest || !m.Network {
		t.Fatalf("the template %+v %v", m, err)
	}
	if fi, _ := os.Stat(filepath.Join(dir, vmsnap.FileMem)); fi.Mode().Perm() != 0o444 {
		t.Fatalf("memory file mode %v", fi.Mode())
	}
}

// Two machines restored from one template are each their own: their own
// VMM user, jail and tap (the load points eth0 at it), the template's
// memory shared through a hard link to the one file, the clock moved on by
// the VMM, and a rebirth that gives each its own seed, boot id, machine
// id, host name and address before Restore returns.
func TestTwoClonesOfATemplateAreEachTheirOwn(t *testing.T) {
	b, vmm, n := snapBackend(t)
	setupSandbox(t, b, "kodus-setup-workload", "kodus-setup")
	snap, err := b.Snapshot(context.Background(), "kodus-setup-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a"})
	if err != nil {
		t.Fatal(err)
	}
	_, dir, _ := b.store.Open("org-a", snap.ID)
	storeMem, _ := os.Stat(filepath.Join(dir, vmsnap.FileMem))
	var rebirths []guestinit.Rebirth
	var machines []isolation.Machine
	for _, name := range []string{"kodus-run-workload", "kodus-run-pool"} {
		m, err := clone(t, b, snap, name, "kodus-run", "org-a")
		if err != nil {
			t.Fatal(err)
		}
		machines = append(machines, m)
		if args := vmm.args[m.ID]; slices.Contains(args, "--config-file") {
			t.Fatalf("a restore booted from a config: %v", args)
		}
		load := vmm.loads[m.ID]
		tap := n.taps["kodus-run/"+name].Tap
		ov, _ := load["network_overrides"].([]any)
		if len(ov) != 1 || ov[0].(map[string]any)["host_dev_name"] != tap || load["clock_realtime"] != true {
			t.Fatalf("load %v (tap %s)", load, tap)
		}
		if mb, _ := load["mem_backend"].(map[string]any); mb["backend_type"] != "File" || mb["backend_path"] != "/mem" {
			t.Fatalf("memory backend %v", load["mem_backend"])
		}
		if fi, err := os.Stat(filepath.Join(b.rootDir(m.ID), "mem")); err != nil || !os.SameFile(fi, storeMem) {
			t.Fatalf("the clone's memory is not the template's file: %v", err)
		}
		cs := vmm.controls[m.ID]
		if len(cs) != 1 || cs[0].Op != guestinit.OpRebirth || cs[0].Rebirth == nil {
			t.Fatalf("controls %+v", cs)
		}
		r := *cs[0].Rebirth
		if r.Net == nil || r.Net.MAC != n.taps["kodus-run/"+name].MAC || r.Net.IP.String() != m.IP("kodus-run") || r.Hostname != m.ID {
			t.Fatalf("rebirth %+v for %+v", r, m)
		}
		rebirths = append(rebirths, r)
		if got := vmm.callsOf(m.ID); !slices.Equal(got, []string{"logger", "snapshot/load", "control rebirth"}) {
			t.Fatalf("a restore's steps %v", got)
		}
	}
	one, two := rebirths[0], rebirths[1]
	if bytes.Equal(one.Seed, two.Seed) || one.BootID == two.BootID || one.MachineID == two.MachineID || one.Hostname == two.Hostname || one.Net.MAC == two.Net.MAC || one.Net.IP == two.Net.IP {
		t.Fatalf("two clones share a value: %+v %+v", one, two)
	}
	if machines[0].ID == machines[1].ID || argValues(vmm.args[machines[0].ID], "--uid")[0] == argValues(vmm.args[machines[1].ID], "--uid")[0] {
		t.Fatal("two clones share a jail or a VMM user")
	}
	for _, m := range machines {
		if err := b.Destroy(context.Background(), m.Name, isolation.DestroyOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := b.store.Open("org-a", snap.ID); err != nil {
		t.Fatalf("destroying its clones took the template: %v", err)
	}
}

// A machine handed the org's secrets never becomes a snapshot, whether the
// taint came with its spec or later; the refusal comes before the guest is
// even asked, and the machine runs on.
func TestAMachineWithSecretsNeverBecomesASnapshot(t *testing.T) {
	b, vmm, _ := snapBackend(t)
	ctx := context.Background()
	born := setupSandbox(t, b, "kodus-a-workload", "kodus-a", isolation.TaintSecrets)
	later := setupSandbox(t, b, "kodus-b-workload", "kodus-b")
	if err := b.Taint(ctx, "kodus-b-workload", isolation.TaintSecrets); err != nil {
		t.Fatal(err)
	}
	if err := b.Taint(ctx, "kodus-b-workload", "seecrets"); err == nil {
		t.Fatal("an unknown taint was taken as clean")
	}
	for _, m := range []isolation.Machine{born, later} {
		for _, p := range []isolation.Purpose{isolation.PurposeTemplate, isolation.PurposeSession} {
			if _, err := b.Snapshot(ctx, m.Name, isolation.SnapshotRequest{Purpose: p, Org: "org-a"}); !errors.Is(err, vmsnap.ErrRefused) {
				t.Fatalf("%s with secrets became a %s: %v", m.Name, p, err)
			}
		}
		if calls := vmm.callsOf(m.ID); len(calls) != 0 || vmm.state[m.ID] != "Running" {
			t.Fatalf("%s: %v, state %s", m.Name, calls, vmm.state[m.ID])
		}
	}
}

// A snapshot belongs to the org of its machine: the caller's word for the
// org is checked against the record, and a restore finds the snapshot only
// under the org of the machine it makes.
func TestASnapshotNeverCrossesOrgs(t *testing.T) {
	b, _, _ := snapBackend(t)
	ctx := context.Background()
	setupSandbox(t, b, "kodus-a-workload", "kodus-a")
	if _, err := b.Snapshot(ctx, "kodus-a-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-b"}); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("org b snapshotted org a's machine: %v", err)
	}
	snap, err := b.Snapshot(ctx, "kodus-a-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a"})
	if err != nil {
		t.Fatal(err)
	}
	forged := snap
	forged.Org = "org-b"
	if _, err := clone(t, b, forged, "kodus-b-workload", "kodus-b", "org-b"); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("org b restored org a's template: %v", err)
	}
	if left := b.Remains("kodus-b-workload"); len(left) > 0 {
		t.Fatalf("a refused restore left %v", left)
	}
}

// When the guest's init refuses (a sandbox running a process of its
// workload), nothing is snapshotted and the machine runs on, not paused.
func TestASnapshotTheGuestRefusesLeavesTheMachineRunning(t *testing.T) {
	b, vmm, _ := snapBackend(t)
	m := setupSandbox(t, b, "kodus-a-workload", "kodus-a")
	vmm.refuse = guestinit.OpPrepare
	_, err := b.Snapshot(context.Background(), "kodus-a-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a"})
	if err == nil || !strings.Contains(err.Error(), "python3(77)") {
		t.Fatalf("refusal %v", err)
	}
	if vmm.state[m.ID] != "Running" || len(b.Remains("kodus-a-workload")) == 0 {
		t.Fatalf("state %s remains %v", vmm.state[m.ID], b.Remains("kodus-a-workload"))
	}
	if ents, _ := os.ReadDir(filepath.Join(b.store.Dir(), vmsnap.OrgKey("org-a"))); len(ents) != 0 {
		t.Fatalf("a refused snapshot left %d entries", len(ents))
	}
}

// The create writes the guest's whole memory through the VMM's page cache,
// charged to its cgroup: once the machine will never run its guest again,
// its memory.max gets room for the whole file (a 1 GiB setup's VMM was
// OOM-killed by its cgroup mid-create on the KVM host). A snapshot the
// guest refuses never lifts it: that machine runs on.
func TestASnapshotsCreateHasRoomInItsCgroupForTheMemoryFile(t *testing.T) {
	b, vmm, _ := snapBackend(t)
	m := setupSandbox(t, b, "kodus-a-workload", "kodus-a")
	limit := filepath.Join(b.cgroupDir(m.ID), "memory.max")
	if err := os.MkdirAll(filepath.Dir(limit), 0o755); err != nil {
		t.Fatal(err)
	}
	const before = int64(1000) << 20
	if err := os.WriteFile(limit, []byte(strconv.FormatInt(before, 10)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	vmm.refuse = guestinit.OpPrepare
	if _, err := b.Snapshot(context.Background(), "kodus-a-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a"}); err == nil {
		t.Fatal("the guest refused, the snapshot was taken")
	}
	if got, _ := os.ReadFile(limit); strings.TrimSpace(string(got)) != strconv.FormatInt(before, 10) {
		t.Fatalf("a machine that runs on has memory.max %s", got)
	}
	vmm.refuse = ""
	var during string
	vmm.onCreate = func(string) {
		raw, _ := os.ReadFile(limit)
		during = strings.TrimSpace(string(raw))
		// A cgroup directory of the real file system goes with its files; this one is a plain directory.
		_ = os.RemoveAll(filepath.Dir(limit))
	}
	if _, err := b.Snapshot(context.Background(), "kodus-a-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a"}); err != nil {
		t.Fatal(err)
	}
	if want := strconv.FormatInt(before+128<<20, 10); during != want {
		t.Fatalf("memory.max during the create %s, want %s (the guest's 128 MiB more)", during, want)
	}
}

// A snapshot the VMM failed to write ends the machine anyway (part of it
// may exist) and leaves no snapshot behind.
func TestASnapshotThatFailsMidwayEndsTheMachineAndLeavesNoSnapshot(t *testing.T) {
	b, vmm, _ := snapBackend(t)
	setupSandbox(t, b, "kodus-a-workload", "kodus-a")
	vmm.failCreate = true
	if _, err := b.Snapshot(context.Background(), "kodus-a-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a"}); err == nil {
		t.Fatal("a failed snapshot succeeded")
	}
	if left := b.Remains("kodus-a-workload"); len(left) > 0 {
		t.Fatalf("left %v", left)
	}
	if ents, _ := os.ReadDir(filepath.Join(b.store.Dir(), vmsnap.OrgKey("org-a"))); len(ents) != 0 {
		t.Fatalf("a failed snapshot left %d entries", len(ents))
	}
}

// A session restores once: its files go once its machine runs, and a
// second restore finds nothing.
func TestASessionRestoresOnce(t *testing.T) {
	b, _, _ := snapBackend(t)
	ctx := context.Background()
	if _, err := b.Create(ctx, isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-a-workload", Network: "kodus-a", Memory: "128m", Org: "org-a"}); err != nil {
		t.Fatal(err)
	}
	snap, err := b.Snapshot(ctx, "kodus-a-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeSession, Org: "org-a"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := clone(t, b, snap, "kodus-a2-workload", "kodus-a2", "org-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := clone(t, b, snap, "kodus-a3-workload", "kodus-a3", "org-a"); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("a session restored twice: %v", err)
	}
	if _, err := os.Stat(filepath.Join(b.store.Dir(), vmsnap.OrgKey("org-a"), snap.ID)); !os.IsNotExist(err) {
		t.Fatalf("a restored session's files stay: %v", err)
	}
}

// A template restores only on the kit and host it was taken on.
func TestATemplateRestoresOnlyOnItsKitAndHost(t *testing.T) {
	b, _, _ := snapBackend(t)
	setupSandbox(t, b, "kodus-a-workload", "kodus-a")
	snap, err := b.Snapshot(context.Background(), "kodus-a-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a"})
	if err != nil {
		t.Fatal(err)
	}
	b.here.Host = "another host"
	if _, err := clone(t, b, snap, "kodus-b-workload", "kodus-b", "org-a"); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("restored on another host: %v", err)
	}
}

// A snapshot's create may take longer than an ordinary API call: the VMM
// writes the whole memory first. It used to share the 30 s bound of every
// call, and a 1 GiB sandbox snapshotted right after a 3 GB write on gp3
// timed out and lost its machine.
func TestASnapshotsCreateIsBoundByTheMemoryItWrites(t *testing.T) {
	old := apiTimeout
	apiTimeout = 50 * time.Millisecond
	t.Cleanup(func() { apiTimeout = old })
	b, vmm, _ := snapBackend(t)
	setupSandbox(t, b, "kodus-a-workload", "kodus-a")
	vmm.createTakes = 200 * time.Millisecond
	if _, err := b.Snapshot(context.Background(), "kodus-a-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a"}); err != nil {
		t.Fatalf("a create slower than one API call: %v", err)
	}
}

func claimSandbox(t *testing.T, b *Backend, name, network, claim string, taints ...isolation.Taint) isolation.Machine {
	t.Helper()
	m, err := b.Create(context.Background(), isolation.Spec{
		Shape: isolation.ShapeSandbox, Name: name, Network: network, Memory: "128m", CPUs: "1", Org: "org-a", Claim: claim, Taints: taints,
	})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// A claim's machine with its secrets and its PR's code becomes the claim's
// round snapshot and comes back at once in its own place (name, address),
// reborn; each reset restores it again, reborn again, at the same address;
// the snapshot restores into no other machine or claim, and goes with the
// claim.
func TestARoundSnapshotRestoresTheClaimsOwnMachineInPlaceEachReset(t *testing.T) {
	b, vmm, _ := snapBackend(t)
	ctx := context.Background()
	src := claimSandbox(t, b, "kodus-run1-workload", "kodus-run1", "run1", isolation.TaintSecrets, isolation.TaintPRCode, isolation.TaintCanaries)
	ip := src.IP("kodus-run1")
	snap, m, err := b.SnapshotRound(ctx, "kodus-run1-workload")
	if err != nil {
		t.Fatal(err)
	}
	if snap.Purpose != isolation.PurposeRound || m.Name != src.Name || m.IP("kodus-run1") != ip {
		t.Fatalf("round %+v machine %+v (was at %s)", snap, m, ip)
	}
	if r, _, _ := b.recordOf(m.Name); !slices.Contains(r.Taints, isolation.TaintSecrets) || r.Claim != "run1" {
		t.Fatalf("the restored machine lost its claim or taints: %+v", r)
	}
	boots := map[string]bool{}
	for i := range 3 {
		if i > 0 {
			if m, err = b.RestoreInPlace(ctx, "kodus-run1-workload", snap); err != nil {
				t.Fatal(err)
			}
		}
		if m.IP("kodus-run1") != ip {
			t.Fatalf("reset %d moved the machine to %s", i, m.IP("kodus-run1"))
		}
		cs := vmm.controls[m.ID]
		r := cs[len(cs)-1].Rebirth
		if r == nil || boots[r.BootID] || r.Net.IP.String() != ip {
			t.Fatalf("reset %d rebirth %+v", i, r)
		}
		boots[r.BootID] = true
	}
	if _, err := b.Snapshot(ctx, "kodus-run1-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a"}); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("a machine with secrets became a template once it had a round: %v", err)
	}
	other := claimSandbox(t, b, "kodus-run2-workload", "kodus-run2", "run2")
	if _, err := b.RestoreInPlace(ctx, "kodus-run2-workload", snap); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("another claim's machine took the round: %v", err)
	}
	if len(b.Remains(other.Name)) == 0 {
		t.Fatal("a refused reset ended the other claim's machine")
	}
	if _, err := clone(t, b, snap, "kodus-run1-pool", "kodus-run1", "org-a"); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("another machine of the claim took the round: %v", err)
	}
	if err := b.ForgetClaim("org-a", "run1"); err != nil {
		t.Fatal(err)
	}
	if _, err := b.RestoreInPlace(ctx, "kodus-run1-workload", snap); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("a released claim's round restored: %v", err)
	}
}

// A pooled machine never takes a round: its record is the pool's.
func TestAPooledMachineTakesNoRound(t *testing.T) {
	b, _, _ := snapBackend(t)
	if _, err := b.Create(context.Background(), isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-p-pool", Network: "kodus-p", Memory: "128m", Org: "org-a", Claim: "p", Pool: true}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := b.SnapshotRound(context.Background(), "kodus-p-pool"); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("a pooled machine took a round: %v", err)
	}
}

// A new template of a key replaces the org's others of that key; the
// newest is the one a claim of the key starts from; another key and
// another org are untouched.
func TestANewTemplateOfAKeyReplacesTheOthers(t *testing.T) {
	b, _, _ := snapBackend(t)
	take := func(name, key string) isolation.SnapshotRef {
		setupSandbox(t, b, name, "kodus-"+name)
		s, err := b.Snapshot(context.Background(), name, isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a", Key: key})
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	old := take("s1", "repo:a")
	keep := take("s2", "repo:b")
	newest := take("s3", "repo:a")
	if got, ok, err := b.LatestTemplate("org-a", "repo:a", isolation.ShapeSandbox); err != nil || !ok || got.ID != newest.ID {
		t.Fatalf("latest of repo:a %+v %v %v", got, ok, err)
	}
	if _, _, err := b.store.Open("org-a", old.ID); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("the replaced template stays: %v", err)
	}
	if _, _, err := b.store.Open("org-a", keep.ID); err != nil {
		t.Fatalf("another key's template went: %v", err)
	}
	if _, ok, _ := b.LatestTemplate("org-b", "repo:a", isolation.ShapeSandbox); ok {
		t.Fatal("org b found org a's template")
	}
	b.here.Kit = "sha256:another-kit"
	if _, ok, _ := b.LatestTemplate("org-a", "repo:a", isolation.ShapeSandbox); ok {
		t.Fatal("a template of another kit is offered")
	}
}

// A round snapshot holds what its claim ran (a PR's code): it goes when the
// claim is released (ForgetClaim), and a sweep removes one whose claim no
// longer has a machine here, past OrphanGrace, whatever RoundTTL says (a
// release the cell missed: a restart of the hub, the worker or the cell).
// While its machine lives, the sweep keeps it.
func TestARoundGoesWithItsClaimAndASweepRemovesAnOrphanOne(t *testing.T) {
	b, _, _ := snapBackend(t)
	ctx := context.Background()
	b.cfg.Snapshots.RoundTTL = 5 * time.Hour
	claimSandbox(t, b, "kodus-run1-workload", "kodus-run1", "run1")
	r1, _, err := b.SnapshotRound(ctx, "kodus-run1-workload")
	if err != nil {
		t.Fatal(err)
	}
	if err := b.ForgetClaim("org-a", "run1"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := b.store.Open("org-a", r1.ID); err == nil {
		t.Fatal("a released claim's round is still kept")
	}
	claimSandbox(t, b, "kodus-run2-workload", "kodus-run2", "run2")
	r2, _, err := b.SnapshotRound(ctx, "kodus-run2-workload")
	if err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(2 * vmsnap.OrphanGrace)
	if _, err := b.SweepSnapshots(later); err != nil {
		t.Fatal(err)
	}
	if _, _, err := b.store.Open("org-a", r2.ID); err != nil {
		t.Fatalf("the sweep removed a live claim's round: %v", err)
	}
	if err := b.Destroy(ctx, "kodus-run2-workload", isolation.DestroyOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.SweepSnapshots(time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, _, err := b.store.Open("org-a", r2.ID); err != nil {
		t.Fatalf("a round of a machine gone an instant ago went before OrphanGrace: %v", err)
	}
	if _, err := b.SweepSnapshots(later); err != nil {
		t.Fatal(err)
	}
	if _, _, err := b.store.Open("org-a", r2.ID); err == nil {
		t.Fatal("a round whose claim has no machine was kept until RoundTTL")
	}
}

// A session goes at once when its PR closes (ForgetSession), and only a
// session of that org: a template is refused, another org's session and one
// already gone are nothing to remove.
func TestASessionIsForgottenAtOnceAndOnlyASession(t *testing.T) {
	b, _, _ := snapBackend(t)
	ctx := context.Background()
	if _, err := b.Create(ctx, isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-a-workload", Network: "kodus-a", Memory: "128m", Org: "org-a"}); err != nil {
		t.Fatal(err)
	}
	sess, err := b.Snapshot(ctx, "kodus-a-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeSession, Org: "org-a"})
	if err != nil {
		t.Fatal(err)
	}
	setupSandbox(t, b, "kodus-setup-workload", "kodus-setup")
	tpl, err := b.Snapshot(ctx, "kodus-setup-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a"})
	if err != nil {
		t.Fatal(err)
	}
	if err := b.ForgetSession("org-b", sess.ID); err != nil {
		t.Fatalf("another org's forget: %v", err)
	}
	if _, _, err := b.store.Open("org-a", sess.ID); err != nil {
		t.Fatalf("another org's forget removed the session: %v", err)
	}
	if err := b.ForgetSession("org-a", tpl.ID); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("a template forgotten as a session: %v", err)
	}
	if err := b.ForgetSession("org-a", sess.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := b.store.Open("org-a", sess.ID); err == nil {
		t.Fatal("the session is still kept")
	}
	if err := b.ForgetSession("org-a", sess.ID); err != nil {
		t.Fatalf("forgetting it again: %v", err)
	}
}
