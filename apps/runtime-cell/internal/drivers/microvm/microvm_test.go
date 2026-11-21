package microvm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/vmsnap"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement"
)

// memBackend keeps machines in memory, as the firecracker backend keeps
// its records on disk.
type memBackend struct {
	mu       sync.Mutex
	m        map[string]isolation.Listed
	specs    map[string]isolation.Spec
	snaps    map[string]isolation.SnapshotRef
	keys     map[string]string // template id -> key
	restores []isolation.Spec
	// restored are the machines a restore made, by name.
	restored map[string]bool
	forgot   []string
	n        int
	guestFS  *guest.FS
	// dataPeak is what every machine's data disk holds (DataAllocated).
	dataPeak int64
	// restoreErr fails every restore (a disk that failed), not a refusal.
	restoreErr error
	// dialFails is how many dials find the guest agent still booting.
	dialFails int
	snapshots bool
}

func newMemBackend() *memBackend {
	return &memBackend{m: map[string]isolation.Listed{}, specs: map[string]isolation.Spec{}, snaps: map[string]isolation.SnapshotRef{}, keys: map[string]string{}}
}

func (b *memBackend) Capabilities() isolation.Capabilities {
	return isolation.Capabilities{Backend: isolation.Firecracker, Isolation: driver.IsolationMicroVM, Suspend: "hibernate", NestedDocker: true, SnapshotMemory: b.snapshots, Guest: "vsock", KVM: true, Arch: []string{"x86_64"}}
}

func (b *memBackend) Create(_ context.Context, s isolation.Spec) (isolation.Machine, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.m[s.Name]; ok {
		return isolation.Machine{}, errors.New("exists")
	}
	b.n++
	addr := map[string]string{s.Network: netip.MustParseAddr(fmt.Sprintf("10.213.0.%d", 127+b.n)).String()}
	b.m[s.Name] = isolation.Listed{Name: s.Name, ID: "kfc-" + s.Name, Labels: s.Labels, Addresses: addr}
	b.specs[s.Name] = s
	return isolation.Machine{Name: s.Name, ID: "kfc-" + s.Name, Addresses: addr}, nil
}

func (b *memBackend) Discard(ctx context.Context, n string) error {
	return b.Destroy(ctx, n, isolation.DestroyOptions{})
}
func (b *memBackend) Start(context.Context, string) error { return nil }
func (b *memBackend) Pause(context.Context, string) error { return nil }

// Snapshot follows the backend's rules on the spec it recorded, as the
// firecracker backend does on its record, and ends the machine.
func (b *memBackend) Snapshot(ctx context.Context, n string, req isolation.SnapshotRequest) (isolation.SnapshotRef, error) {
	b.mu.Lock()
	s, ok := b.specs[n]
	b.mu.Unlock()
	if !ok {
		return isolation.SnapshotRef{}, errors.New("no machine")
	}
	if err := vmsnap.Admit(vmsnap.Facts{Org: s.Org, Claim: s.Claim, Setup: s.Setup, Pool: s.Pool, Taints: s.Taints}, req.Purpose, req.Org); err != nil {
		return isolation.SnapshotRef{}, err
	}
	sum := sha256.Sum256([]byte(n))
	ref := isolation.SnapshotRef{ID: "ksn-" + hex.EncodeToString(sum[:16]), Machine: n, Org: s.Org, Purpose: req.Purpose}
	b.mu.Lock()
	b.snaps[ref.ID] = ref
	if req.Key != "" {
		b.keys[ref.ID] = req.Key
	}
	b.mu.Unlock()
	return ref, b.Destroy(ctx, n, isolation.DestroyOptions{})
}

func (b *memBackend) Restore(ctx context.Context, snap isolation.SnapshotRef, s isolation.Spec) (isolation.Machine, error) {
	b.mu.Lock()
	kept, ok := b.snaps[snap.ID]
	b.restores = append(b.restores, s)
	failed := b.restoreErr
	b.mu.Unlock()
	if failed != nil {
		return isolation.Machine{}, failed
	}
	if !ok || kept.Org != s.Org || snap.Key != "" && b.keys[snap.ID] != snap.Key {
		return isolation.Machine{}, vmsnap.ErrRefused
	}
	b.mu.Lock()
	if b.restored == nil {
		b.restored = map[string]bool{}
	}
	b.restored[s.Name] = true
	b.mu.Unlock()
	return b.Create(ctx, s)
}

func (b *memBackend) Taint(_ context.Context, n string, why isolation.Taint) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	s, ok := b.specs[n]
	if !ok {
		return errors.New("no machine")
	}
	s.Taints = append(s.Taints, why)
	b.specs[n] = s
	return nil
}

func (b *memBackend) SweepSnapshots(time.Time) ([]string, error) { return nil, nil }

func (b *memBackend) ForgetSession(org, id string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if s, ok := b.snaps[id]; ok && s.Org == org {
		if s.Purpose != isolation.PurposeSession {
			return vmsnap.ErrRefused
		}
		delete(b.snaps, id)
	}
	return nil
}

func (b *memBackend) DataAllocated(string) (int64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.dataPeak, nil
}

func (b *memBackend) SnapshotRound(ctx context.Context, n string) (isolation.SnapshotRef, isolation.Machine, error) {
	b.mu.Lock()
	s := b.specs[n]
	l := b.m[n]
	b.mu.Unlock()
	snap, err := b.Snapshot(ctx, n, isolation.SnapshotRequest{Purpose: isolation.PurposeRound, Org: s.Org})
	if err != nil {
		return isolation.SnapshotRef{}, isolation.Machine{}, err
	}
	m, err := b.recreate(ctx, s, l)
	return snap, m, err
}

// recreate makes the machine again at its old addresses, as a restore in
// its place does.
func (b *memBackend) recreate(ctx context.Context, s isolation.Spec, l isolation.Listed) (isolation.Machine, error) {
	m, err := b.Create(ctx, s)
	if err != nil {
		return m, err
	}
	b.mu.Lock()
	kept := b.m[s.Name]
	kept.Addresses = l.Addresses
	b.m[s.Name] = kept
	b.mu.Unlock()
	m.Addresses = l.Addresses
	return m, nil
}

func (b *memBackend) RestoreInPlace(ctx context.Context, n string, snap isolation.SnapshotRef) (isolation.Machine, error) {
	b.mu.Lock()
	s, l, kept := b.specs[n], b.m[n], b.snaps[snap.ID]
	b.mu.Unlock()
	if kept.Machine != n || kept.Purpose != isolation.PurposeRound {
		return isolation.Machine{}, vmsnap.ErrRefused
	}
	_ = b.Destroy(ctx, n, isolation.DestroyOptions{})
	return b.recreate(ctx, s, l)
}

func (b *memBackend) LatestTemplate(org, key string, _ isolation.Shape) (isolation.SnapshotRef, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, k := range b.keys {
		if s := b.snaps[id]; k == key && s.Org == org {
			return s, true, nil
		}
	}
	return isolation.SnapshotRef{}, false, nil
}

func (b *memBackend) ForgetClaim(org, claim string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.forgot = append(b.forgot, org+"/"+claim)
	return nil
}

func (b *memBackend) Destroy(_ context.Context, n string, _ isolation.DestroyOptions) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.m, n)
	return nil
}

// DialGuest serves the real guest agent on b.guestFS when set (its commands
// run on the host, with b.guestPath), else a stream that is closed.
func (b *memBackend) DialGuest(ctx context.Context, _ string) (io.ReadWriteCloser, error) {
	b.mu.Lock()
	booting := b.dialFails > 0
	if booting {
		b.dialFails--
	}
	b.mu.Unlock()
	if booting {
		return nil, errors.New("vsock: the guest does not answer on that port: EOF")
	}
	c, s := net.Pipe()
	if b.guestFS == nil {
		_ = s.Close()
		return c, nil
	}
	life := context.WithoutCancel(ctx) // the stream outlives the dial, as a VM's does
	go func() { defer func() { _ = s.Close() }(); _ = guest.Serve(life, s, s, b.guestFS) }()
	return c, nil
}

func (b *memBackend) Inventory(context.Context) ([]isolation.Listed, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]isolation.Listed, 0, len(b.m))
	for _, l := range b.m {
		out = append(out, l)
	}
	return out, nil
}

// memPlace keeps networks and their labels in memory.
type memPlace struct {
	mu   sync.Mutex
	nets map[string]map[string]string
}

func (p *memPlace) Name() string { return "hostnet" }
func (p *memPlace) CreateNetwork(_ context.Context, s placement.NetworkSpec) (netip.Prefix, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.nets[s.Name]; ok {
		return netip.Prefix{}, errors.New("exists")
	}
	p.nets[s.Name] = s.Labels
	return netip.MustParsePrefix("10.213.0.0/24"), nil
}

func (p *memPlace) AttachEgress(context.Context, string, string) (string, error) {
	return "10.212.255.1", nil
}
func (p *memPlace) DetachEgress(context.Context, string, string) error { return nil }
func (p *memPlace) RemoveNetwork(_ context.Context, n string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.nets, n)
	return nil
}

func (p *memPlace) NetworkLabels(_ context.Context, n string) (map[string]string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.nets[n], nil
}

const cell = "cell-1"

func newDriver(t *testing.T) (*Driver, *memBackend, *memPlace) {
	t.Helper()
	b, p := newMemBackend(), &memPlace{nets: map[string]map[string]string{}}
	d, err := New(Config{CellID: cell, Backend: b, Place: p, Egress: true, MaxMemoryMB: 8192, MaxCPUs: 4})
	if err != nil {
		t.Fatal(err)
	}
	return d, b, p
}

// What the driver can do follows its backend, in one place (Parts): a
// backend that keeps no memory gives no snapshot, session or bake part, so
// hello cannot say snapshotMemory for a cell that refuses every snapshot.
func TestTheBackendDecidesTheSnapshotAndBakeParts(t *testing.T) {
	d, b, _ := newDriver(t)
	if p := d.Parts(); p.Snapshots != nil || p.Sessions != nil || p.Baker != nil || p.BakePinner != nil {
		t.Fatal("a backend that keeps no memory still gives a snapshot or bake part")
	}
	b.snapshots = true
	if p := d.Parts(); p.Snapshots == nil || p.Sessions == nil || p.Baker == nil || p.BakePinner == nil {
		t.Fatal("a backend that keeps memory, with nested docker, gives no snapshot or bake part")
	}
}

func TestTheMicroVMDriverKeepsTheDriverContract(t *testing.T) {
	drivertest.Run(t, func(t *testing.T) drivertest.Subject {
		d, b, p := newDriver(t)
		return drivertest.Subject{
			Driver: d, CellID: cell, Lifecycle: true,
			Spec: func(claimID string, n driver.ClaimNetwork) driver.MachineSpec {
				s := drivertest.BaseSpec(cell, claimID, n)
				s.ClaimGroupID = networkName(claimID)
				return s
			},
			ForeignMachine: func(t *testing.T) driver.MachineRef {
				_, _ = b.Create(context.Background(), isolation.Spec{Name: "kodus-other-workload", Labels: map[string]string{driver.TagCell: "cell-2", driver.TagClaim: "other"}})
				return driver.MachineRef{MachineID: "kodus-other-workload", Tags: map[string]string{driver.TagCell: "cell-2", driver.TagClaim: "other"}}
			},
			ForeignNetwork: func(t *testing.T) driver.ClaimNetwork {
				p.nets["kodus-other"] = map[string]string{driver.TagCell: "cell-2"}
				return driver.ClaimNetwork{WorkloadGroupID: "kodus-other", ObserverGroupID: "kodus-other"}
			},
			Parts: d.Parts(),
			UndatedMachine: func(t *testing.T, ceiling string) string {
				name := fmt.Sprintf("kodus-undated-%d-workload", len(b.m))
				labels := map[string]string{driver.TagCell: cell, driver.TagClaim: "undated", driver.TagRole: string(driver.RoleWorkload)}
				if ceiling != "" {
					labels[driver.TagHardExpires] = ceiling
				}
				if _, err := b.Create(context.Background(), isolation.Spec{Name: name, Labels: labels}); err != nil {
					t.Fatal(err)
				}
				return name
			},
		}
	})
}

func spec(claim string) driver.MachineSpec {
	now := time.Now()
	return driver.MachineSpec{
		CellID: cell, EnvironmentID: "env-1", Role: driver.RoleWorkload, OrgID: "org-a", ClaimID: claim,
		ClaimGroupID: networkName(claim), KMSKeyRef: "kms-org-a", ExpiresAt: now.Add(time.Minute), HardExpiresAt: now.Add(time.Hour),
	}
}

// A sandbox is a machine of the sandbox shape with the claim's size and
// half its memory as /workspace, on the claim's own network, which reaches
// the egress.
func TestASandboxIsTheSandboxShapeOnItsClaimsNetwork(t *testing.T) {
	d, b, _ := newDriver(t)
	ctx := context.Background()
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: "claim-1"})
	if err != nil || n.EgressAddress != "10.212.255.1" {
		t.Fatalf("network %+v %v", n, err)
	}
	s := spec("claim-1")
	s.ClaimSize = driver.ClaimSize{MemoryMB: 1024, CPUs: 1}
	ref, err := d.CreateSandbox(ctx, driver.SandboxRequest{Spec: s})
	if err != nil {
		t.Fatal(err)
	}
	got := b.specs[ref.MachineID]
	if got.Shape != isolation.ShapeSandbox || got.Memory != "1024m" || got.CPUs != "1" || got.WorkspaceSize != "512m" || got.Network != n.WorkloadGroupID {
		t.Fatalf("backend spec %+v", got)
	}
	if ref.PrivateAddress == "" {
		t.Fatal("no address on the claim's network")
	}
	other := spec("claim-1")
	other.ClaimGroupID = networkName("claim-2")
	if _, err := d.CreateSandbox(ctx, driver.SandboxRequest{Spec: other}); !errors.Is(err, driver.ErrNotOwned) {
		t.Fatalf("a machine on another claim's network: %v", err)
	}
}

// A setup's machine becomes a template of its org and ends; a machine of a
// claim that carries secrets or a credential, or a pooled one, never
// becomes a snapshot; a template restores only into a claim of its org,
// never as a template source itself.
func TestOnlyACleanSetupMachineBecomesATemplateOfItsOrg(t *testing.T) {
	d, b, _ := newDriver(t)
	ctx := context.Background()
	for _, c := range []string{"claim-1", "claim-2", "claim-3", "claim-4", "claim-5"} {
		if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: c}); err != nil {
			t.Fatal(err)
		}
	}
	setup := spec("claim-1")
	setup.Setup = true
	src, err := d.CreateSandbox(ctx, driver.SandboxRequest{Spec: setup})
	if err != nil {
		t.Fatal(err)
	}
	tpl, err := d.Snapshot(ctx, src, isolation.PurposeTemplate)
	if err != nil || tpl.Org != "org-a" {
		t.Fatalf("template %+v %v", tpl, err)
	}
	if left, _ := d.List(ctx, nil); len(left) != 0 {
		t.Fatalf("the template's source still runs: %v", left)
	}
	withSecrets := spec("claim-2")
	withSecrets.Setup, withSecrets.Secrets = true, true
	keyed := spec("claim-3")
	keyed.Setup, keyed.UserData = true, "ssh-ed25519 AAAA"
	pooled := spec("claim-4")
	pooled.Role = driver.RolePool
	for name, s := range map[string]driver.MachineSpec{"secrets": withSecrets, "credentials": keyed, "pool": pooled} {
		ref, err := d.CreateSandbox(ctx, driver.SandboxRequest{Spec: s})
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range []isolation.Purpose{isolation.PurposeTemplate, isolation.PurposeSession} {
			if _, err := d.Snapshot(ctx, ref, p); !errors.Is(err, vmsnap.ErrRefused) {
				t.Errorf("a machine with %s became a %s: %v", name, p, err)
			}
		}
	}
	other := spec("claim-5")
	other.OrgID = "org-b"
	if _, err := d.CreateSandboxFrom(ctx, other, tpl); !errors.Is(err, driver.ErrNotOwned) {
		t.Fatalf("org b restored org a's template: %v", err)
	}
	forged := tpl
	forged.Org = "org-b"
	if _, err := d.CreateSandboxFrom(ctx, other, forged); err == nil {
		t.Fatal("a ref naming org b restored org a's snapshot")
	}
	clone := spec("claim-5")
	clone.Setup = true
	ref, err := d.CreateSandboxFrom(ctx, clone, tpl)
	if err != nil || ref.PrivateAddress == "" {
		t.Fatalf("restore %+v %v", ref, err)
	}
	if got := b.specs[ref.MachineID]; got.Setup || got.Org != "org-a" || got.Shape != isolation.ShapeSandbox {
		t.Fatalf("a restored machine's spec %+v", got)
	}
	if _, err := d.Snapshot(ctx, ref, isolation.PurposeTemplate); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("a restored machine became a template: %v", err)
	}
	if err := d.Taint(ctx, ref, isolation.TaintSecrets); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Snapshot(ctx, ref, isolation.PurposeSession); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("a machine tainted after it was made became a session: %v", err)
	}
}

// Through the driver's snapshot port: a round brings the claim's machine
// back in its place with the same reference, a reset restores it again, the
// claim's release forgets its rounds; a template of a key is found by key
// for its org only, and a sandbox starts from it.
func TestTheSnapshotPortKeepsRoundsInTheirClaimAndTemplatesInTheirOrg(t *testing.T) {
	d, b, _ := newDriver(t)
	ctx := context.Background()
	n, _ := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: "claim-1"})
	s := spec("claim-1")
	s.Secrets = true
	ref, err := d.CreateSandbox(ctx, driver.SandboxRequest{Spec: s})
	if err != nil {
		t.Fatal(err)
	}
	round, back, err := d.SnapshotMachine(ctx, ref, "round", "")
	if err != nil || back.MachineID != ref.MachineID || back.PrivateAddress != ref.PrivateAddress {
		t.Fatalf("round %+v back %+v (was %+v): %v", round, back, ref, err)
	}
	if again, err := d.ResetToSnapshot(ctx, back, round); err != nil || again.PrivateAddress != ref.PrivateAddress {
		t.Fatalf("reset %+v %v", again, err)
	}
	if _, err := d.ResetToSnapshot(ctx, back, driver.MemorySnapshot{ID: round.ID, OrgID: "org-b", Purpose: "round"}); !errors.Is(err, driver.ErrNotOwned) {
		t.Fatalf("another org's round: %v", err)
	}
	if err := d.ReleaseClaim(ctx, n); err != nil || len(b.forgot) != 1 || b.forgot[0] != "org-a/claim-1" {
		t.Fatalf("release forgot %v: %v", b.forgot, err)
	}
	_, _ = d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: "claim-2"})
	setup := spec("claim-2")
	setup.Setup = true
	src, _ := d.CreateSandbox(ctx, driver.SandboxRequest{Spec: setup})
	tpl, _, err := d.SnapshotMachine(ctx, src, "template", "repo:a")
	if err != nil {
		t.Fatal(err)
	}
	if got, ok, _ := d.LatestTemplate(ctx, "org-a", "repo:a"); !ok || got.ID != tpl.ID {
		t.Fatalf("latest %+v %v", got, ok)
	}
	if _, ok, _ := d.LatestTemplate(ctx, "org-b", "repo:a"); ok {
		t.Fatal("org b found org a's template")
	}
	_, _ = d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: "claim-3"})
	if _, err := d.CreateSandboxFromSnapshot(ctx, driver.SandboxRequest{Spec: spec("claim-3")}, tpl); err != nil {
		t.Fatal(err)
	}
	if _, err := d.CreateSandboxFromSnapshot(ctx, driver.SandboxRequest{Spec: spec("claim-3")}, round); err == nil {
		t.Fatal("a sandbox started from a round")
	}
}

func (b *memBackend) DialVsock(ctx context.Context, n string, _ uint32) (net.Conn, error) {
	rw, err := b.DialGuest(ctx, n)
	if err != nil {
		return nil, err
	}
	return rw.(net.Conn), nil
}
