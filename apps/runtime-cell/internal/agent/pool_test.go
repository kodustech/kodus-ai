package agent

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// poolHarness is an agent whose fake driver keeps a pool, with one image
// baked for env-1.
func poolHarness(t *testing.T, edit ...func(*Config)) (*harness, string) {
	t.Helper()
	h := newHarness(t, append([]func(*Config){func(c *Config) { c.Pooler = c.Driver.(driver.Pooler) }}, edit...)...)
	return h, bakeImage(t, h)
}

func bakeImage(t *testing.T, h *harness) string {
	t.Helper()
	before := len(h.drv.BakesSnapshot())
	if err := h.handle("", protocol.MessageTypeImageBake, &protocol.ImageBakeBody{OrgID: "org-a", EnvironmentID: "env-1", Sha: testSHA, RecipeSha: "r"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(h.drv.BakesSnapshot()) > before && h.lastBaked() != "" })
	return h.lastBaked()
}

func (h *harness) lastBaked() string {
	h.a.mu.Lock()
	defer h.a.mu.Unlock()
	last := ""
	for id := range h.a.baked {
		if id > last {
			last = id
		}
	}
	return last
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (h *harness) poolMachines(image string) []driver.PoolMachine {
	h.a.mu.Lock()
	defer h.a.mu.Unlock()
	p := h.a.pools[poolKey{"org-a", "env-1"}]
	if p == nil {
		return nil
	}
	var out []driver.PoolMachine
	for _, m := range p.ready {
		if image == "" || m.ImageID == image {
			out = append(out, m)
		}
	}
	return out
}

// A cell whose driver keeps no pool says so when pool.target arrives.
func TestPoolTargetOnADriverWithoutAPoolIsRefused(t *testing.T) {
	h := newHarness(t)
	img := bakeImage(t, h)
	err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: img, Size: 2})
	if code := nackCode(err); code != "pool_unsupported" {
		t.Fatalf("pool.target = %v (code %q), want pool_unsupported", err, code)
	}
}

// pool.target fills the environment's pool from its bake, up to the cell's
// maximum.
func TestPoolTargetFillsThePoolFromTheBake(t *testing.T) {
	h, img := poolHarness(t, func(c *Config) { c.PoolMax = 3 })
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: img, Size: 9}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(h.poolMachines(img)) == 3 })
	for _, m := range h.poolMachines(img) {
		if m.Workload.Tags[driver.TagRole] != string(driver.RolePool) || m.Workload.Tags[driver.TagEnv] != "env-1" {
			t.Fatalf("pool machine %+v", m.Workload)
		}
	}
	time.Sleep(20 * time.Millisecond)
	if n := len(h.poolMachines("")); n != 3 {
		t.Fatalf("pool past its maximum: %d", n)
	}
}

// A claim of the environment adopts a ready machine instead of making a
// workload, and the pool makes another; a PR claim's adopted machine is
// tainted like any PR machine, so it is never baked or pooled again.
func TestAClaimAdoptsAPoolMachineAndThePoolRefills(t *testing.T) {
	h, img := poolHarness(t)
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: img, Size: 1}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(h.poolMachines(img)) == 1 })
	pooled := h.poolMachines(img)[0]

	b := h.acquireBody()
	b.ImageID, b.Side = "latest", protocol.SidePr
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	c, _ := h.a.claims.Get("claim-1")
	if c.Machines().Workload.MachineID != pooled.Workload.MachineID || c.Machines().Network.WorkloadGroupID != pooled.Network.WorkloadGroupID {
		t.Fatalf("the claim made its own machine %+v instead of adopting %s", c.Machines().Workload, pooled.Workload.MachineID)
	}
	if got := h.drv.AdoptionsSnapshot(); len(got) != 1 || got[0] != "claim-1="+pooled.Workload.MachineID {
		t.Fatalf("adoptions %v", got)
	}
	if !h.a.isTainted(pooled.Workload.MachineID) {
		t.Fatal("a PR claim's adopted machine is not marked as having run PR code")
	}
	waitFor(t, func() bool {
		ms := h.poolMachines(img)
		return len(ms) == 1 && ms[0].Workload.MachineID != pooled.Workload.MachineID
	})
	// Released, the adopted machine is destroyed, never back in the pool.
	if err := h.handle("claim-1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		for _, id := range h.drv.DestroyedIDs() {
			if id == pooled.Workload.MachineID {
				return true
			}
		}
		return false
	})
	for _, m := range h.poolMachines("") {
		if m.Workload.MachineID == pooled.Workload.MachineID {
			t.Fatal("the released machine went back to the pool")
		}
	}
}

// A claim asking for another image, or with a later ceiling than the pool
// machine's, makes its own machine.
func TestAClaimTakesOnlyAPoolMachineThatFitsIt(t *testing.T) {
	h, img := poolHarness(t, func(c *Config) { c.PoolTTL = 30 * time.Minute })
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: img, Size: 1}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(h.poolMachines(img)) == 1 })
	for name, b := range map[string]*protocol.ClaimAcquireBody{
		"another image":   func() *protocol.ClaimAcquireBody { b := h.acquireBody(); b.ImageID = "img-other"; return b }(),
		"a later ceiling": func() *protocol.ClaimAcquireBody { b := h.acquireBody(); b.ImageID = "latest"; return b }(), // 50 min > 30 min
	} {
		hard, _ := protocol.ParseTime(b.HardExpiresAt)
		if _, ok := h.a.takePoolMachine(*b, hard); ok {
			t.Errorf("%s took the pool machine", name)
		}
	}
}

// A new bake of the environment replaces the pool's machines.
func TestANewBakeReplacesThePool(t *testing.T) {
	h, first := poolHarness(t)
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: first, Size: 2}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(h.poolMachines(first)) == 2 })
	old := h.poolMachines(first)
	second := bakeImage(t, h)
	if second == first {
		t.Fatal("the second bake made the same image")
	}
	waitFor(t, func() bool { return len(h.poolMachines(second)) == 2 && len(h.poolMachines(first)) == 0 })
	waitFor(t, func() bool {
		gone := 0
		for _, id := range h.drv.DestroyedIDs() {
			for _, m := range old {
				if id == m.Workload.MachineID {
					gone++
				}
			}
		}
		return gone == len(old)
	})
}

// A fill that fails leaves the pool short, counts, and is tried again by
// housekeeping rather than in a loop.
func TestAFailedFillIsTriedAgainLater(t *testing.T) {
	h, img := poolHarness(t)
	h.drv.FailPool = errors.New("no capacity")
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: img, Size: 1}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return strings.Contains(h.logs.String(), "pool.fill.failed") })
	if n := len(h.poolMachines("")); n != 0 {
		t.Fatalf("%d machines from a failing fill", n)
	}
	h.drv.FailPool = nil
	h.a.refillPools()
	waitFor(t, func() bool { return len(h.poolMachines(img)) == 1 })
}

// "latest" asked before the bake is done waits for it, then fills from it;
// asked after, it takes the environment's last bake.
func TestPoolTargetLatestFollowsTheEnvironmentsBake(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Pooler = c.Driver.(driver.Pooler) })
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: "latest", Size: 1}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if n := len(h.poolMachines("")); n != 0 {
		t.Fatalf("%d pool machines before any bake", n)
	}
	img := bakeImage(t, h)
	waitFor(t, func() bool { return len(h.poolMachines(img)) == 1 })

	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: "latest", Size: 2}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(h.poolMachines(img)) == 2 })
	// Another environment's "latest" is not this one's bake.
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-2", ImageID: "latest", Size: 1}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	h.a.mu.Lock()
	other := h.a.pools[poolKey{"org-a", "env-2"}]
	h.a.mu.Unlock()
	if other == nil || other.imageID != "" || len(other.ready) != 0 {
		t.Fatalf("env-2 pool %+v took env-1's bake", other)
	}
}

// Only a setup's workload may write what the environment keeps; a setup
// never starts from a pool machine (it holds the last bake's data).
func TestOnlyASetupsWorkloadIsMarkedAndASetupNeverAdopts(t *testing.T) {
	for _, c := range []struct {
		name     string
		consumer protocol.Consumer
		side     protocol.Side
		setup    bool
	}{
		{"setup", protocol.ConsumerSetup, protocol.SideBase, true},
		{"run base", protocol.ConsumerRuntime, protocol.SideBase, false},
		{"run pr", protocol.ConsumerRuntime, protocol.SidePr, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			h, img := poolHarness(t)
			if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: img, Size: 1}); err != nil {
				t.Fatal(err)
			}
			waitFor(t, func() bool { return len(h.poolMachines(img)) == 1 })
			b := h.acquireBody()
			b.Consumer, b.Side, b.ImageID = c.consumer, c.side, "latest"
			if c.consumer == protocol.ConsumerSetup {
				b.HardExpiresAt = protocol.FormatTime(h.clk.Now().Add(40 * time.Minute))
			}
			if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
				t.Fatal(err)
			}
			h.conn.next(t, isReady)
			cl, _ := h.a.claims.Get("claim-1")
			adopted := len(h.drv.AdoptionsSnapshot()) == 1
			if c.setup && adopted {
				t.Fatal("a setup adopted a pool machine")
			}
			if !c.setup && !adopted {
				t.Fatal("a Run claim made its own machine with a pool machine ready")
			}
			if c.setup {
				spec, ok := h.drv.SpecOf(cl.Machines().Workload.MachineID)
				if !ok || !spec.Setup {
					t.Fatalf("the setup's workload is not marked: %+v", spec)
				}
				obs, _ := h.drv.SpecOf(cl.Machines().Observer.MachineID)
				if obs.Setup {
					t.Fatal("the setup's observer is marked")
				}
			}
		})
	}
}

// "latest" is resolved to the environment's last bake when the claim
// arrives: a claim that adopts a pool machine and one that makes its own
// both carry that image, so a Run's steps name one image on both sides.
func TestLatestIsTheBakeForAdoptedAndNewMachinesAlike(t *testing.T) {
	h, img := poolHarness(t)
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: "latest", Size: 1}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(h.poolMachines(img)) == 1 })
	acquire := func(id string) {
		t.Helper()
		b := h.acquireBody()
		b.ImageID = "latest"
		if err := h.handle(id, protocol.MessageTypeClaimAcquire, b); err != nil {
			t.Fatal(err)
		}
		h.conn.next(t, isReady)
	}
	acquire("claim-1")
	// No pool any more: the next claim makes its own machine.
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: "latest", Size: 0}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(h.poolMachines("")) == 0 })
	acquire("claim-2")
	if got := h.drv.AdoptionsSnapshot(); len(got) != 1 || !strings.HasPrefix(got[0], "claim-1=") {
		t.Fatalf("adoptions %v, want claim-1 only", got)
	}
	for _, id := range []string{"claim-1", "claim-2"} {
		c, _ := h.a.claims.Get(id)
		if got := c.Machines().Workload.ImageID; got != img {
			t.Fatalf("%s runs on %q, not the bake %q", id, got, img)
		}
	}
}
