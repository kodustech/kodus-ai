package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// Independent per-container ceilings previously let a claim exceed its budget.
// Persisted fake groups also let a new driver recover the same physical limit.
type fakeClaimLimits struct {
	mu              sync.Mutex
	groups          map[string]claimlimits.Limits
	fail, verifyErr error
	removed         []string
}

func (f *fakeClaimLimits) Ensure(key string, l claimlimits.Limits) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return "", f.fail
	}
	if f.groups == nil {
		f.groups = map[string]claimlimits.Limits{}
	}
	if old, ok := f.groups[key]; ok && old != l {
		return "", fmt.Errorf("changed ceiling")
	}
	f.groups[key] = l
	return "/kodus-test/" + key, nil
}
func (f *fakeClaimLimits) Verify(_ string, pid int) error {
	if pid <= 0 {
		return fmt.Errorf("missing pid")
	}
	return f.verifyErr
}
func (f *fakeClaimLimits) Remove(key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, key)
	delete(f.groups, key)
	return nil
}

func limitedDriver(t *testing.T) (*Driver, *memDocker, *fakeClaimLimits) {
	t.Helper()
	docker := newMemDocker()
	limits := &fakeClaimLimits{}
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "holder", WorkDir: t.TempDir(), ClaimLimits: limits})
	if err != nil {
		t.Fatal(err)
	}
	return d, docker, limits
}
func TestClaimLimitsAllHoldersSharePhysicalParent(t *testing.T) {
	d, docker, limits := limitedDriver(t)
	ctx := context.Background()
	s := spec()
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: s.OrgID, ClaimID: s.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	s.ClaimGroupID = n.WorkloadGroupID
	w, err := d.Create(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	s.Role = driver.RoleObserver
	o, err := d.Create(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	a, b := docker.containers[w.MachineID], docker.containers[o.MachineID]
	if a.CgroupParent == "" || a.CgroupParent != b.CgroupParent || len(limits.groups) != 1 {
		t.Fatalf("unshared groups: %q %q %#v", a.CgroupParent, b.CgroupParent, limits.groups)
	}
	for _, l := range limits.groups {
		if l.MemoryBytes != 4<<30 || l.CPUQuota != 200000 || l.CPUPeriod != 100000 || l.Pids != 2048 {
			t.Fatalf("limits=%+v", l)
		}
	}
}
func TestClaimLimitsFailureStartsNoHolder(t *testing.T) {
	d, docker, limits := limitedDriver(t)
	ctx := context.Background()
	s := spec()
	_, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: s.OrgID, ClaimID: s.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	limits.fail = errors.New("controller unavailable")
	if _, err = d.Create(ctx, s); !errors.Is(err, ErrResourceEnforcement) {
		t.Fatalf("err=%v", err)
	}
	if len(docker.containers) != 0 {
		t.Fatal("container launched without ceiling")
	}
}
func TestClaimLimitsRejectWrongDaemonMembership(t *testing.T) {
	d, docker, limits := limitedDriver(t)
	ctx := context.Background()
	s := spec()
	_, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: s.OrgID, ClaimID: s.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	limits.verifyErr = errors.New("different host cgroup")
	if _, err = d.Create(ctx, s); !errors.Is(err, ErrResourceEnforcement) {
		t.Fatalf("err=%v", err)
	}
	if len(docker.containers) != 0 {
		t.Fatal("unverified holder survived")
	}
}
func TestClaimLimitsKeepReadyAdmissionAtEnforcedCeiling(t *testing.T) {
	d, _, _ := limitedDriver(t)
	for _, size := range []driver.ClaimSize{{}, {MemoryMB: 3072, CPUs: 1}} {
		v := d.ClaimMemory(size)
		if v.ReadyMB != v.BootMB {
			t.Fatalf("counted less than enforced: %+v", v)
		}
	}
}
func TestClaimLimitsRecoverParentAndSizeFromHolder(t *testing.T) {
	d, docker, limits := limitedDriver(t)
	ctx := context.Background()
	s := spec()
	s.ClaimSize = driver.ClaimSize{MemoryMB: 3072, CPUs: 1}
	_, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: s.OrgID, ClaimID: s.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	ref, err := d.Create(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	// A restarted process has none of the old machine's in-memory size.
	d2, err := New(ctx, docker, Config{CellID: "cell-1", HolderImage: "holder", WorkDir: t.TempDir(), ClaimLimits: limits})
	if err != nil {
		t.Fatal(err)
	}
	p, err := d2.parentFor(ctx, ref)
	if err != nil {
		t.Fatal(err)
	}
	if p == "" || len(limits.groups) != 1 {
		t.Fatalf("lost parent: %s", p)
	}
}
func TestClaimLimitsReleaseOnlyAfterNetworkContainersGone(t *testing.T) {
	d, docker, limits := limitedDriver(t)
	ctx := context.Background()
	s := spec()
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: s.OrgID, ClaimID: s.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	ref, err := d.Create(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	if err = d.ReleaseClaim(ctx, n); err == nil {
		t.Fatal("released populated network")
	}
	if len(limits.removed) != 0 {
		t.Fatal("parent removed with container alive")
	}
	if err = d.Destroy(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if len(docker.containers) != 0 {
		t.Fatal("holder survived destroy")
	}
	if err = d.ReleaseClaim(ctx, n); err != nil {
		t.Fatal(err)
	}
	if len(limits.removed) != 1 {
		t.Fatalf("removed=%v", limits.removed)
	}
}

func TestClaimLimitsCannotAdoptLegacyUnboundedPool(t *testing.T) {
	d, docker := withEgress(t)
	ctx := context.Background()
	p, err := d.PoolCreate(ctx, driver.PoolSpec{CellID: "cell-1", OrgID: "org-a", EnvironmentID: "env", ImageID: "img-1", KMSKeyRef: "local", ExpiresAt: spec().ExpiresAt, HardExpiresAt: spec().HardExpiresAt})
	if err != nil {
		t.Fatal(err)
	}
	// Enabling aggregate mode cannot retroactively bound existing containers.
	limits := &fakeClaimLimits{}
	d2, err := New(ctx, docker, Config{CellID: "cell-1", HolderImage: "holder", WorkDir: t.TempDir(), EgressContainer: "kodus-egress", ClaimLimits: limits})
	if err != nil {
		t.Fatal(err)
	}
	if err = d2.Adopt(ctx, p, "claim-new"); err == nil {
		t.Fatal("adopted legacy pool without parent")
	}
	if d2.claimNetwork("claim-new") != networkName("claim-new") {
		t.Fatal("failed adoption changed ownership")
	}
}

func TestClaimLimitsUncertainRestoreIsNeverSuccessful(t *testing.T) {
	for _, pool := range []bool{false, true} {
		t.Run(fmt.Sprint(pool), func(t *testing.T) {
			d, docker, _ := limitedPathsDriver(t)
			ctx := context.Background()
			imageID := installGenerationForTest(t, d, docker.memDocker)
			docker.copyErr = driver.ErrResourceCleanupPending
			var err error
			if pool {
				s := spec()
				s.ImageID = imageID
				_, err = d.PoolCreate(ctx, driver.PoolSpec{CellID: s.CellID, OrgID: s.OrgID, EnvironmentID: bakeEnv, ImageID: s.ImageID, Size: s.Size, KMSKeyRef: s.KMSKeyRef, ExpiresAt: s.ExpiresAt, HardExpiresAt: s.HardExpiresAt})
			} else {
				_, ref := makeLimitedClaim(t, d, "claim-uncertain-copy")
				ref.ImageID = imageID
				_, err = d.restoreData(ctx, ref, []string{"pgdata"})
			}
			if !errors.Is(err, driver.ErrResourceCleanupPending) {
				t.Fatalf("uncertain physical cleanup became success: %v", err)
			}
		})
	}
}
