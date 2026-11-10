package dockergvisor

import (
	"context"
	"errors"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

type observingClaimLimits struct {
	inner   *fakeClaimLimits
	ensures int
}

func (f *observingClaimLimits) Ensure(key string, l claimlimits.Limits) (string, error) {
	f.ensures++
	return f.inner.Ensure(key, l)
}
func (f *observingClaimLimits) Verify(key string, pid int) error { return f.inner.Verify(key, pid) }
func (f *observingClaimLimits) Remove(key string) error          { return f.inner.Remove(key) }

func customBudgetWorkload(t *testing.T, d *Driver) (driver.MachineSpec, driver.MachineRef) {
	t.Helper()
	ctx := context.Background()
	s := spec()
	s.ClaimSize = driver.ClaimSize{MemoryMB: 1024, CPUs: 1}
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: s.OrgID, ClaimID: s.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	s.ClaimGroupID = n.WorkloadGroupID
	work, err := d.Create(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	return s, work
}

// The agent deliberately leaves observer ClaimSize zero. Previously this
// recomputed the default 4GiB/2CPU parent over an existing 1GiB/1CPU ceiling.
func TestObserverInheritsPinnedBudgetWithRealZeroClaimSize(t *testing.T) {
	d, docker, limits := limitedDriver(t)
	spy := &observingClaimLimits{inner: limits}
	d.cfg.ClaimLimits = spy
	workSpec, work := customBudgetWorkload(t, d)
	obs := spec()
	obs.Role = driver.RoleObserver
	obs.ClaimGroupID = workSpec.ClaimGroupID
	if !obs.ClaimSize.IsZero() {
		t.Fatal("test must model real agent observer spec")
	}
	before := spy.ensures
	ref, err := d.Create(context.Background(), obs)
	if err != nil {
		t.Fatal(err)
	}
	a, b := docker.containers[work.MachineID], docker.containers[ref.MachineID]
	if a.CgroupParent == "" || a.CgroupParent != b.CgroupParent {
		t.Fatalf("parent %q -> %q", a.CgroupParent, b.CgroupParent)
	}
	if spy.ensures != before+1 {
		t.Fatal("observer did not recheck controller budget")
	}
	if len(limits.groups) != 1 {
		t.Fatalf("unexpected groups %v", limits.groups)
	}
	for _, l := range limits.groups {
		if l.MemoryBytes != 1<<30 || l.CPUQuota != 100000 {
			t.Fatalf("observer reselected default ceiling: %+v", l)
		}
	}
}

func TestObserverCannotOriginateOrRecoverUntrustedBudget(t *testing.T) {
	for _, mutation := range []string{"missing", "key", "network", "empty_parent", "invalid_parent", "changed_parent", "cell", "org", "claim", "controller"} {
		t.Run(mutation, func(t *testing.T) {
			d, docker, limits := limitedDriver(t)
			spy := &observingClaimLimits{inner: limits}
			d.cfg.ClaimLimits = spy
			s, _ := customBudgetWorkload(t, d)
			d.mu.Lock()
			g := d.limitGroups[s.ClaimGroupID]
			switch mutation {
			case "missing":
				delete(d.limitGroups, s.ClaimGroupID)
			case "key":
				g.key = "unrelated"
				d.limitGroups[s.ClaimGroupID] = g
			case "network":
				g.network = "other"
				d.limitGroups[s.ClaimGroupID] = g
			case "empty_parent":
				g.parent = ""
				d.limitGroups[s.ClaimGroupID] = g
			case "invalid_parent":
				g.parent = "relative"
				d.limitGroups[s.ClaimGroupID] = g
			case "changed_parent":
				g.parent = "/foreign/parent"
				d.limitGroups[s.ClaimGroupID] = g
			case "cell":
				docker.networks[s.ClaimGroupID]["kodus.cell"] = "other-cell"
			case "org":
				docker.networks[s.ClaimGroupID]["kodus.org"] = "other-org"
			case "claim":
				docker.networks[s.ClaimGroupID]["kodus.claim"] = "other-claim"
			case "controller":
				limits.fail = errors.New("native root lost")
			}
			d.mu.Unlock()
			before := spy.ensures
			count := len(docker.containers)
			s.Role = driver.RoleObserver
			s.ClaimSize = driver.ClaimSize{}
			if _, err := d.Create(context.Background(), s); !errors.Is(err, ErrResourceEnforcement) {
				t.Fatalf("untrusted observer allowed: %v", err)
			}
			if len(docker.containers) != count {
				t.Fatal("observer launched before budget/ownership validation")
			}
			if mutation != "controller" && mutation != "changed_parent" && spy.ensures != before {
				t.Fatal("untrusted cached identity reached resource controller")
			}
		})
	}
	d, docker, limits := limitedDriver(t)
	s := spec()
	s.Role = driver.RoleObserver
	if _, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: s.OrgID, ClaimID: s.ClaimID}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Create(context.Background(), s); !errors.Is(err, ErrResourceEnforcement) {
		t.Fatalf("observer-first originated a budget: %v", err)
	}
	if len(docker.containers) != 0 || len(limits.groups) != 0 {
		t.Fatal("observer-first allocated a parent or holder")
	}
}

func TestObserverAfterRestartRequiresTrustedRehydration(t *testing.T) {
	d, docker, limits := limitedDriver(t)
	s, _ := customBudgetWorkload(t, d)
	restarted, err := New(context.Background(), docker, Config{CellID: s.CellID, HolderImage: "holder", WorkDir: t.TempDir(), ClaimLimits: limits})
	if err != nil {
		t.Fatal(err)
	}
	s.Role = driver.RoleObserver
	s.ClaimSize = driver.ClaimSize{}
	if _, err = restarted.Create(context.Background(), s); !errors.Is(err, ErrResourceEnforcement) {
		t.Fatalf("restart silently inferred observer budget: %v", err)
	}
	if len(docker.containers) != 1 {
		t.Fatal("restart created observer without pinned metadata")
	}
}

func TestAdoptedCustomPoolBudgetRehydratesBeforeZeroSizeObserver(t *testing.T) {
	d, docker, limits := limitedPathsDriver(t)
	ctx := context.Background()
	s := spec()
	p, err := d.PoolCreate(ctx, driver.PoolSpec{CellID: s.CellID, OrgID: s.OrgID, EnvironmentID: bakeEnv, ImageID: s.ImageID, Size: s.Size, ClaimSize: driver.ClaimSize{MemoryMB: 1024, CPUs: 1}, KMSKeyRef: s.KMSKeyRef, ExpiresAt: s.ExpiresAt, HardExpiresAt: s.HardExpiresAt})
	if err != nil {
		t.Fatal(err)
	}
	parent := docker.containers[p.Workload.MachineID].CgroupParent
	restarted, err := New(ctx, docker, Config{CellID: s.CellID, HolderImage: "holder", WorkDir: t.TempDir(), ClaimLimits: limits})
	if err != nil {
		t.Fatal(err)
	}
	if err = restarted.Adopt(ctx, p, "claim-adopted-custom"); err != nil {
		t.Fatal(err)
	}
	obs := spec()
	obs.ClaimID = "claim-adopted-custom"
	obs.Role = driver.RoleObserver
	obs.ClaimGroupID = p.Network.WorkloadGroupID
	if !obs.ClaimSize.IsZero() {
		t.Fatal("observer must retain independent machine sizing")
	}
	ref, err := restarted.Create(ctx, obs)
	if err != nil {
		t.Fatal(err)
	}
	if got := docker.containers[ref.MachineID].CgroupParent; got != parent {
		t.Fatalf("adopted observer changed parent: %q -> %q", parent, got)
	}
	for _, l := range limits.groups {
		if l.MemoryBytes != 1<<30 || l.CPUQuota != 100000 {
			t.Fatalf("pool budget changed: %+v", l)
		}
	}
}

func TestObserverWithoutAggregateLimitsKeepsLegacyIndependentCreation(t *testing.T) {
	docker := newMemDocker()
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "holder", WorkDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	s := spec()
	s.Role = driver.RoleObserver
	n, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: s.OrgID, ClaimID: s.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	s.ClaimGroupID = n.ObserverGroupID
	ref, err := d.Create(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	if docker.containers[ref.MachineID].CgroupParent != "" {
		t.Fatal("legacy observer unexpectedly assigned aggregate parent")
	}
}
