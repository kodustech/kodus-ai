package pool

import (
	"context"
	"log/slog"
	"strconv"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// fakePooler makes machines as asked and remembers what was destroyed.
type fakePooler struct {
	made      int
	destroyed []string
}

func (f *fakePooler) PoolCreate(_ context.Context, spec driver.PoolSpec) (driver.PoolMachine, error) {
	f.made++
	return driver.PoolMachine{
		Workload: driver.MachineRef{MachineID: "m-" + strconv.Itoa(f.made)},
		OrgID:    spec.OrgID, EnvironmentID: spec.EnvironmentID, ImageID: spec.ImageID, ClaimSize: spec.ClaimSize, HardExpiresAt: spec.HardExpiresAt,
	}, nil
}
func (f *fakePooler) Adopt(context.Context, driver.PoolMachine, string) error { return nil }
func (f *fakePooler) Destroy(_ context.Context, ref driver.MachineRef) error {
	f.destroyed = append(f.destroyed, ref.MachineID)
	return nil
}
func (f *fakePooler) ReleaseClaim(context.Context, driver.ClaimNetwork) error { return nil }

func manager(t *testing.T, accepting *bool) (*Manager, *fakePooler, *clock.Fake) {
	t.Helper()
	f := &fakePooler{}
	clk := clock.NewFake(time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC))
	var reg *metrics.Registry
	return New(Config{
		CellID: "cell-1", Pooler: f, Machines: f, OrgKey: func(string) (string, error) { return "key", nil },
		Max: 2, TTL: 4 * time.Hour, Accepting: func() bool { return *accepting },
		Go:    func(run func(context.Context)) { run(context.Background()) },
		Clock: clk, Log: slog.New(slog.DiscardHandler), Outcomes: reg.Counter("pool_test_total", "test", "outcome"),
	}), f, clk
}

func target(image string, size int64) protocol.PoolTargetBody {
	return protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: image, Size: size}
}

// A target is filled up to the cell's bound, a claim takes a machine once,
// and only a claim of that environment, image, size and ceiling.
func TestAClaimTakesAReadyMachineOfItsEnvironmentOnce(t *testing.T) {
	yes := true
	mg, f, clk := manager(t, &yes)
	mg.SetTarget(target("img-1", 5))
	if mg.Ready() != 2 || f.made != 2 {
		t.Fatalf("ready %d made %d, want the cell's bound of 2", mg.Ready(), f.made)
	}
	hard := clk.Now().Add(time.Hour)
	ask := Request{OrgID: "org-a", EnvironmentID: "env-1", HardExpiresAt: hard}
	for name, r := range map[string]Request{
		"a setup":             {OrgID: "org-a", EnvironmentID: "env-1", Setup: true, HardExpiresAt: hard},
		"another org":         {OrgID: "org-b", EnvironmentID: "env-1", HardExpiresAt: hard},
		"another image":       {OrgID: "org-a", EnvironmentID: "env-1", ImageID: "img-0", HardExpiresAt: hard},
		"another size":        {OrgID: "org-a", EnvironmentID: "env-1", Size: driver.ClaimSize{MemoryMB: 8192, CPUs: 4}, HardExpiresAt: hard},
		"a later ceiling":     {OrgID: "org-a", EnvironmentID: "env-1", HardExpiresAt: clk.Now().Add(5 * time.Hour)},
		"another environment": {OrgID: "org-a", EnvironmentID: "env-2", HardExpiresAt: hard},
	} {
		if mg.Has(r) {
			t.Errorf("%s was offered a pool machine", name)
		}
	}
	if !mg.Has(ask) || mg.Ready() != 2 {
		t.Fatal("Has took a machine or found none")
	}
	m, ok := mg.Take(ask)
	if !ok || mg.Ready() != 1 {
		t.Fatalf("take: %v, ready %d", ok, mg.Ready())
	}
	if other, ok := mg.Take(ask); !ok || other.Workload.MachineID == m.Workload.MachineID {
		t.Fatal("the same machine was handed out twice")
	}
	if _, ok := mg.Take(ask); ok {
		t.Fatal("an empty pool handed out a machine")
	}
}

// A new bake replaces the pool's machines; a cell that takes no work makes none.
func TestThePoolFollowsTheBakeAndStopsWhenTheCellDoes(t *testing.T) {
	yes := true
	mg, f, _ := manager(t, &yes)
	mg.SetTarget(target("img-1", 1))
	mg.FollowBake("org-a", "env-1", "img-2")
	got, ok := mg.Target("org-a", "env-1")
	if !ok || got.ImageID != "img-2" || len(got.Ready) != 1 || got.Ready[0].ImageID != "img-2" {
		t.Fatalf("pool after the bake: %+v", got)
	}
	if len(f.destroyed) != 1 {
		t.Fatalf("the old image's machine was not discarded: %v", f.destroyed)
	}
	yes = false
	mg.SetTarget(target("img-2", 2))
	if mg.Ready() != 1 {
		t.Fatal("a cell that accepts no work made a pool machine")
	}
}

// Without a Pooler a target is recorded and nothing is made or handed out.
func TestACellWithoutAPoolerKeepsNoPool(t *testing.T) {
	mg := New(Config{Max: 2, TTL: time.Hour, Accepting: func() bool { return true }, Log: slog.New(slog.DiscardHandler)})
	mg.SetTarget(target("img-1", 1))
	if mg.Ready() != 0 || mg.Has(Request{OrgID: "org-a", EnvironmentID: "env-1"}) {
		t.Fatal("a cell without a pooler has a pool machine")
	}
}
