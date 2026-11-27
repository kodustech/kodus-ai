package dockergvisor

import (
	"context"
	"errors"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// resizingClaimLimits is fakeClaimLimits with claimlimits.Resizer: Lower
// changes the stored ceiling, so a later Ensure must name the lowered one.
type resizingClaimLimits struct {
	fakeClaimLimits
	usage    claimlimits.Usage
	lowerErr error
	lowered  []int64
}

func (f *resizingClaimLimits) Lower(key string, memoryBytes int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.lowerErr != nil {
		return f.lowerErr
	}
	l, ok := f.groups[key]
	if !ok || memoryBytes > l.MemoryBytes {
		return claimlimits.ErrUnavailable
	}
	l.MemoryBytes = memoryBytes
	f.groups[key] = l
	f.lowered = append(f.lowered, memoryBytes)
	return nil
}

func (f *resizingClaimLimits) Usage(string) (claimlimits.Usage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.usage, nil
}

func resizingDriver(t *testing.T) (*Driver, *memDocker, *resizingClaimLimits) {
	t.Helper()
	docker := newMemDocker()
	limits := &resizingClaimLimits{}
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "holder", WorkDir: t.TempDir(), ClaimLimits: limits, ClaimBudgets: limits})
	if err != nil {
		t.Fatal(err)
	}
	return d, docker, limits
}

func readyWorkload(t *testing.T, d *Driver) (driver.MachineSpec, driver.MachineRef) {
	t.Helper()
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
	return s, w
}

func TestAReadyClaimRunsUnderTheCeilingAdmissionCountsIt(t *testing.T) {
	d, _, limits := resizingDriver(t)
	s, w := readyWorkload(t, d)
	// 1 GiB held, plus file cache the kernel can drop.
	limits.usage = claimlimits.Usage{CurrentBytes: 3 << 30, FileBytes: 2 << 30, ShmemBytes: 0}
	mb, err := d.SettleReady(context.Background(), w)
	if err != nil {
		t.Fatal(err)
	}
	// 1024 held + 512 to grow + 1024 for a browser probe; above the 2048 floor.
	if mb != 2560 {
		t.Fatalf("settled at %d MB", mb)
	}
	if len(limits.lowered) != 1 || limits.lowered[0] != int64(mb)<<20 {
		t.Fatalf("enforced %v, counted %d MB", limits.lowered, mb)
	}
	// What launches into the claim after ready runs under the lowered ceiling
	// (the observer here; a reset's services and a browser probe the same way).
	s.Role = driver.RoleObserver
	if _, err = d.Create(context.Background(), s); err != nil {
		t.Fatalf("a launch after the claim settled: %v", err)
	}
	if _, err = d.parentFor(context.Background(), w); err != nil {
		t.Fatalf("the holder's group after the claim settled: %v", err)
	}
}

func TestASettledCeilingKeepsRoomToGrowAndNeverPassesTheClaimsSize(t *testing.T) {
	for _, c := range []struct {
		name        string
		working     int64
		floor, size int
		want        int
	}{
		{"small claim at the floor", 100 << 20, 2048, 4096, 2048},
		{"half again to grow", 4 << 30, 2048, 12288, 4096 + 2048 + 1024},
		{"never above its size", 10 << 30, 2048, 12288, 12288},
		{"a partial MB counts whole", 1<<30 + 1, 0, 12288, 1025 + 512 + 1024},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := settledMB(c.working, c.floor, c.size); got != c.want {
				t.Fatalf("settledMB=%d want %d", got, c.want)
			}
		})
	}
}

func TestAClaimThatUsesItsWholeSizeIsNotLowered(t *testing.T) {
	d, _, limits := resizingDriver(t)
	_, w := readyWorkload(t, d)
	limits.usage = claimlimits.Usage{CurrentBytes: 4 << 30}
	mb, err := d.SettleReady(context.Background(), w)
	if err != nil || mb != 4096 || len(limits.lowered) != 0 {
		t.Fatalf("mb=%d err=%v lowered=%v", mb, err, limits.lowered)
	}
}

func TestACeilingTheKernelDidNotTakeIsNotCounted(t *testing.T) {
	d, _, limits := resizingDriver(t)
	_, w := readyWorkload(t, d)
	limits.usage = claimlimits.Usage{CurrentBytes: 1 << 30}
	limits.lowerErr = errors.New("write refused")
	if mb, err := d.SettleReady(context.Background(), w); err == nil || mb != 0 {
		t.Fatalf("mb=%d err=%v", mb, err)
	}
}

func TestWithoutAResizerNothingSettles(t *testing.T) {
	d, _, _ := limitedDriver(t)
	_, w := readyWorkload(t, d)
	if mb, err := d.SettleReady(context.Background(), w); err != nil || mb != 0 {
		t.Fatalf("mb=%d err=%v", mb, err)
	}
	if p := d.Parts(); p.Health != nil || p.ReadyMemory != nil {
		t.Fatal("machine health or a ready ceiling without a budget to read and lower")
	}
}

func TestMachineHealthCountsTheClaimsOOMKillsAndAStoppedHolder(t *testing.T) {
	d, docker, limits := resizingDriver(t)
	_, w := readyWorkload(t, d)
	if p := d.Parts(); p.Health == nil || p.ReadyMemory == nil {
		t.Fatal("no machine health or ready ceiling under a resizable budget")
	}
	limits.usage = claimlimits.Usage{CurrentBytes: 1 << 30, OOMKills: 3}
	h, err := d.MachineHealth(context.Background(), w)
	if err != nil || !h.Running || h.OOMKills != 3 {
		t.Fatalf("health=%+v err=%v", h, err)
	}
	c := docker.containers[w.MachineID]
	c.PID = 0
	docker.containers[w.MachineID] = c
	if h, err = d.MachineHealth(context.Background(), w); err != nil || h.Running {
		t.Fatalf("a stopped holder read as running: %+v err=%v", h, err)
	}
}

// A ready claim is never settled under what its services declared together:
// a service that declared mem_limit may grow to it, whatever the claim held
// when it settled (a worker pool that had not started yet).
func TestSettleNeverLowersTheCeilingUnderWhatServicesDeclared(t *testing.T) {
	for _, c := range []struct {
		name       string
		working    int64
		declaredMB int
		wantMB     int
		lowered    bool
	}{
		{"nothing declared settles to the 2 GiB floor", 100 << 20, 0, 2048, true},
		{"declared above the floor keeps the declared ceiling", 100 << 20, 3072, 3072, true},
		{"declared the whole claim is not lowered at all", 100 << 20, 4096, 4096, false},
		{"what the claim holds still wins over a smaller declaration", 3 << 30, 1024, 5632, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			d, _, limits := resizingDriver(t)
			_, w := readyWorkload(t, d)
			d.mu.Lock()
			d.machineLocked(w.MachineID).memFloorMB = c.declaredMB
			d.mu.Unlock()
			limits.usage = claimlimits.Usage{CurrentBytes: c.working}
			mb, err := d.SettleReady(context.Background(), w)
			if err != nil {
				t.Fatal(err)
			}
			if mb != min(c.wantMB, 4096) {
				t.Fatalf("settled to %d MB, want %d", mb, min(c.wantMB, 4096))
			}
			if c.declaredMB > 0 && mb < c.declaredMB {
				t.Fatalf("settled to %d MB, under the %d declared", mb, c.declaredMB)
			}
			if got := len(limits.lowered) > 0; got != c.lowered {
				t.Fatalf("lowered=%v, want %v", limits.lowered, c.lowered)
			}
		})
	}
}
