package agent

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// countingDriver counts what the agent asked the driver to make.
type countingDriver struct {
	*fake.Driver
	mu       sync.Mutex
	networks int
	creates  int
}

func (c *countingDriver) PrepareClaim(ctx context.Context, s driver.ClaimNetworkSpec) (driver.ClaimNetwork, error) {
	c.mu.Lock()
	c.networks++
	c.mu.Unlock()
	return c.Driver.PrepareClaim(ctx, s)
}

func (c *countingDriver) Create(ctx context.Context, s driver.MachineSpec) (driver.MachineRef, error) {
	c.mu.Lock()
	c.creates++
	c.mu.Unlock()
	return c.Driver.Create(ctx, s)
}

func (c *countingDriver) made() (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.networks, c.creates
}

func sized(memoryMB, cpus int64) func(*protocol.ClaimAcquireBody) {
	return func(b *protocol.ClaimAcquireBody) {
		b.Size = &protocol.MachineSize{MemoryMb: memoryMB, Cpus: cpus}
	}
}

// A size above the cell's maximum is the blocker resources/size_unavailable,
// naming what was asked and what the cell grants, and the cell makes
// nothing for it: no network, no machine.
func TestASizeAboveTheCellsMaxIsRefusedBeforeAnythingIsMade(t *testing.T) {
	for name, c := range map[string]struct {
		max   driver.ClaimSize
		asked func(*protocol.ClaimAcquireBody)
		want  string
	}{
		"memory":         {driver.ClaimSize{MemoryMB: 8192, CPUs: 4}, sized(16384, 4), "asked 16384 MB / 4 CPUs, this cell grants at most 8192 MB / 4 CPUs"},
		"cpus":           {driver.ClaimSize{MemoryMB: 8192, CPUs: 4}, sized(8192, 8), "asked 8192 MB / 8 CPUs, this cell grants at most 8192 MB / 4 CPUs"},
		"no size at all": {driver.ClaimSize{}, sized(4096, 2), "this cell grants no machine size"},
	} {
		t.Run(name, func(t *testing.T) {
			var drv *countingDriver
			h := newHarness(t, func(cfg *Config) {
				f := cfg.Driver.(*fake.Driver)
				f.MaxClaimSize = c.max
				drv = &countingDriver{Driver: f}
				cfg.Driver = drv
			})
			b := h.acquireBody()
			c.asked(b)
			if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
				t.Fatal(err)
			}
			f := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
			if f.Kind != protocol.BlockerKindResources || f.Signature != "size_unavailable" || !strings.Contains(f.Reason, c.want) {
				t.Fatalf("claim.failed %+v, want resources/size_unavailable naming %q", f, c.want)
			}
			if networks, creates := drv.made(); networks != 0 || creates != 0 {
				t.Fatalf("made %d networks and %d machines for a size the cell does not grant", networks, creates)
			}
			if len(h.drv.Machines()) != 0 {
				t.Fatalf("machines left: %v", h.drv.Machines())
			}
		})
	}
}

// A size within the maximum reaches the workload's spec, and only the
// workload's: the observer keeps the cell's own. A claim that asks none
// gets the zero size, the driver's default.
func TestASizeWithinTheMaxReachesTheWorkload(t *testing.T) {
	h := newHarness(t, func(cfg *Config) { cfg.Driver.(*fake.Driver).MaxClaimSize = driver.ClaimSize{MemoryMB: 16384, CPUs: 8} })
	h.ready("claim-1", sized(16384, 8))
	h.ready("claim-2")
	got := map[string]driver.ClaimSize{}
	for _, m := range h.drv.Machines() {
		got[m.Spec.ClaimID+"/"+string(m.Spec.Role)] = m.Spec.ClaimSize
	}
	want := map[string]driver.ClaimSize{
		"claim-1/workload": {MemoryMB: 16384, CPUs: 8},
		"claim-1/observer": {},
		"claim-2/workload": {},
		"claim-2/observer": {},
	}
	for k, w := range want {
		if g, ok := got[k]; !ok || g != w {
			t.Errorf("%s size %v (made %v), want %v", k, g, ok, w)
		}
	}
}

// A pool machine is made at the cell's default size: a claim that asks a
// size of its own makes its own workload at that size, and the pool machine
// stays for a claim that asks none.
func TestASizedClaimDoesNotAdoptAPoolMachine(t *testing.T) {
	h, img := poolHarness(t, func(c *Config) { c.Driver.(*fake.Driver).MaxClaimSize = driver.ClaimSize{MemoryMB: 16384, CPUs: 8} })
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: img, Size: 1}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(h.poolMachines(img)) == 1 })
	pooled := h.poolMachines(img)[0]
	h.ready("claim-1", func(b *protocol.ClaimAcquireBody) { b.ImageID = "latest" }, sized(8192, 4))
	c, _ := h.a.claims.Get("claim-1")
	if c.Machines().Workload.MachineID == pooled.Workload.MachineID || len(h.drv.AdoptionsSnapshot()) != 0 {
		t.Fatal("a sized claim adopted a pool machine of the default size")
	}
	if spec, ok := h.drv.SpecOf(c.Machines().Workload.MachineID); !ok || spec.ClaimSize != (driver.ClaimSize{MemoryMB: 8192, CPUs: 4}) {
		t.Fatalf("own workload size %v (%v)", spec.ClaimSize, ok)
	}
	if ms := h.poolMachines(img); len(ms) != 1 || ms[0].Workload.MachineID != pooled.Workload.MachineID {
		t.Fatalf("pool %v, want the machine still ready", ms)
	}
}

// A sized environment's pool (pool.target machineSize) is made at that
// size, so a claim of the environment adopts it; a default claim does not.
func TestASizedPoolIsMadeAtTheEnvironmentsSizeAndAdopted(t *testing.T) {
	h, img := poolHarness(t, func(c *Config) { c.Driver.(*fake.Driver).MaxClaimSize = driver.ClaimSize{MemoryMB: 16384, CPUs: 8} })
	size := &protocol.MachineSize{MemoryMb: 8192, Cpus: 4}
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: img, Size: 1, MachineSize: size}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(h.poolMachines(img)) == 1 })
	pooled := h.poolMachines(img)[0]
	if spec, ok := h.drv.SpecOf(pooled.Workload.MachineID); !ok || spec.ClaimSize != (driver.ClaimSize{MemoryMB: 8192, CPUs: 4}) {
		t.Fatalf("pool machine made at %v (%v)", spec.ClaimSize, ok)
	}
	def := h.acquireBody()
	def.ImageID = "latest"
	hard, _ := protocol.ParseTime(def.HardExpiresAt)
	if _, ok := h.a.takePoolMachine(*def, hard); ok {
		t.Fatal("a claim of the default size took a sized pool machine")
	}
	h.ready("claim-1", func(b *protocol.ClaimAcquireBody) { b.ImageID = "latest" }, sized(8192, 4))
	c, _ := h.a.claims.Get("claim-1")
	if c.Machines().Workload.MachineID != pooled.Workload.MachineID {
		t.Fatalf("the sized claim made %s instead of adopting %s", c.Machines().Workload.MachineID, pooled.Workload.MachineID)
	}
}

// A new machine size for the environment drains the machines of the old
// one and makes them at the new size: none is left that no claim adopts.
func TestANewMachineSizeDrainsThePool(t *testing.T) {
	h, img := poolHarness(t, func(c *Config) { c.Driver.(*fake.Driver).MaxClaimSize = driver.ClaimSize{MemoryMB: 16384, CPUs: 8} })
	target := func(s *protocol.MachineSize) {
		t.Helper()
		if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: img, Size: 1, MachineSize: s}); err != nil {
			t.Fatal(err)
		}
	}
	target(nil)
	waitFor(t, func() bool { return len(h.poolMachines(img)) == 1 })
	old := h.poolMachines(img)[0]
	target(&protocol.MachineSize{MemoryMb: 4096, Cpus: 2})
	want := driver.ClaimSize{MemoryMB: 4096, CPUs: 2}
	waitFor(t, func() bool { ms := h.poolMachines(img); return len(ms) == 1 && ms[0].ClaimSize == want })
	waitFor(t, func() bool { return slices.Contains(h.drv.DestroyedIDs(), old.Workload.MachineID) })
}

// A pool size the cell grants no claim is refused: it would fill a pool no
// claim of the environment could adopt.
func TestAPoolSizeTheCellDoesNotGrantIsRefused(t *testing.T) {
	h, img := poolHarness(t, func(c *Config) { c.Driver.(*fake.Driver).MaxClaimSize = driver.ClaimSize{MemoryMB: 4096, CPUs: 2} })
	err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: img, Size: 1, MachineSize: &protocol.MachineSize{MemoryMb: 8192, Cpus: 4}})
	if code := nackCode(err); code != "size_unavailable" {
		t.Fatalf("nack %q (%v)", code, err)
	}
	if ms := h.poolMachines(""); len(ms) != 0 {
		t.Fatalf("pool %v after a refused size", ms)
	}
}

// defaultSizePooler is a driver that makes pool machines at its default
// size whatever the spec asks, as one that predates PoolSpec.ClaimSize.
type defaultSizePooler struct{ *fake.Driver }

func (d defaultSizePooler) PoolCreate(ctx context.Context, spec driver.PoolSpec) (driver.PoolMachine, error) {
	spec.ClaimSize = driver.ClaimSize{}
	return d.Driver.PoolCreate(ctx, spec)
}

// The agent trusts the size the driver says it made: a default machine
// for a sized pool is discarded, never handed to a sized claim.
func TestAPoolMachineOfAnotherSizeThanAskedIsDiscarded(t *testing.T) {
	h, img := poolHarness(t, func(c *Config) {
		c.Driver.(*fake.Driver).MaxClaimSize = driver.ClaimSize{MemoryMB: 16384, CPUs: 8}
		c.Pooler = defaultSizePooler{c.Driver.(*fake.Driver)}
	})
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: img, Size: 1, MachineSize: &protocol.MachineSize{MemoryMb: 8192, Cpus: 4}}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(h.drv.DestroyedIDs()) > 0 })
	if ms := h.poolMachines(""); len(ms) != 0 {
		t.Fatalf("pool %v holds a machine of the default size", ms)
	}
}
