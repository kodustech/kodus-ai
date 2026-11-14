package agent

import (
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/provenance"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// budgetDriver is the fake driver with a memory budget: every claim boots
// at 12 GB and is ready at 2 GB, the cell-dev-1 numbers.
type budgetDriver struct{ *fake.Driver }

func (budgetDriver) ClaimMemory(size driver.ClaimSize) driver.ClaimMemory {
	boot := 12_288
	if size.MemoryMB > 0 {
		boot = size.MemoryMB
	}
	return driver.ClaimMemory{BootMB: boot, ReadyMB: min(boot, 2_048)}
}

// withMemory gives the harness's agent a memory budget of allocatableMB.
func withMemory(allocatableMB int) func(*Config) {
	return func(c *Config) {
		c.Driver = budgetDriver{c.Driver.(*fake.Driver)}
		c.MemoryAllocatableMB = allocatableMB
	}
}

// Two PR builds that do not fit the cell together: the second is refused
// with no_capacity before anything is made, and fits once the first is
// ready (its builds are over) or released (ADR-070).
func TestASecondBuildThatDoesNotFitIsRefusedUntilTheFirstIsReady(t *testing.T) {
	h := newHarness(t, withMemory(14_745))
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureCellMemory}})
	pr := func(b *protocol.ClaimAcquireBody) { b.Side = protocol.SidePr }

	// Held while it boots: the claim counts its build size until claim.ready, unless it is a
	// base that boots the environment's bake (its pinned image), which builds nothing heavy.
	noBake := h.acquireBody()
	noBake.ImageID = ""
	if got := h.a.claimMemoryNeed(*noBake, false); got != 12_288 {
		t.Fatalf("a claim boots at %d MB", got)
	}
	baked := h.acquireBody()
	baked.ImageID = "img-1"
	// "latest" before any bake here, "setup", or a bake another cell made: the base builds from scratch.
	for _, img := range []string{latestImage, "setup", "img-1"} {
		b := *baked
		b.ImageID = img
		if got := h.a.claimMemoryNeed(b, false); got != 12_288 {
			t.Fatalf("a base on %q with no bake on this cell boots at %d MB", img, got)
		}
	}
	h.a.origin.Add("img-1", provenance.Image{OrgID: baked.OrgID, EnvironmentID: "another-env"}, false)
	if got := h.a.claimMemoryNeed(*baked, false); got != 12_288 {
		t.Fatalf("another environment's bake counts the base at %d MB", got)
	}
	h.a.origin.Add("img-1", provenance.Image{OrgID: baked.OrgID, EnvironmentID: baked.EnvironmentID, SHA: "an-older-default-branch"}, false)
	if got := h.a.claimMemoryNeed(*baked, false); got != 12_288 {
		t.Fatalf("the bake of another commit counts the base at %d MB", got)
	}
	h.a.origin.Add("img-1", provenance.Image{OrgID: baked.OrgID, EnvironmentID: baked.EnvironmentID, SHA: baked.Sha}, false)
	if got := h.a.claimMemoryNeed(*baked, false); got != 2_048 {
		t.Fatalf("a base on the bake boots at %d MB", got)
	}
	prOnBake := h.acquireBody()
	prOnBake.Side, prOnBake.ImageID = protocol.SidePr, "img-1"
	if got := h.a.claimMemoryNeed(*prOnBake, false); got != 12_288 {
		t.Fatalf("a PR always builds: %d MB", got)
	}
	b1 := h.acquireBody()
	pr(b1)
	if ok, _, _ := h.a.mem.Admit("claim-held", 12_288, true); !ok {
		t.Fatal("the first build did not fit an empty cell")
	}
	b2 := h.acquireBody()
	pr(b2)
	err := h.handle("claim-2", protocol.MessageTypeClaimAcquire, b2)
	if code := nackCode(err); code != "no_capacity" {
		t.Fatalf("the second build = %v (code %q), want no_capacity", err, code)
	}
	if !strings.Contains(err.Error(), "needs 12288 MB") || !strings.Contains(err.Error(), "2457 of the cell's 14745 MB are free") {
		t.Fatalf("the refusal does not say why: %v", err)
	}
	if _, held := h.a.claims.Get("claim-2"); held || h.a.mem.Count("claim-2") != 0 || len(h.drv.Machines()) != 0 {
		t.Fatal("a refused claim took a slot, memory or a machine")
	}
	if hb := h.a.Heartbeat(); hb.Memory == nil || hb.Memory.CommittedMb != 12_288 || hb.Memory.AllocatableMb != 14_745 || hb.Memory.BootMb != 12_288 || hb.Memory.ReadyMb != 2_048 {
		t.Fatalf("heartbeat memory = %+v", hb.Memory)
	}

	// The first build is done: counted at its ready size, the second fits.
	h.a.mem.Set("claim-held", 2_048)
	h.ready("claim-2", pr)
	if got := h.a.mem.Count("claim-2"); got != 2_048 {
		t.Fatalf("a ready claim is counted at %d MB, want its ready size", got)
	}
	if hb := h.a.Heartbeat(); hb.Memory.CommittedMb != 4_096 {
		t.Fatalf("committed after ready = %d", hb.Memory.CommittedMb)
	}

	// Released, it gives its memory back.
	if err := h.handle("claim-2", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return h.a.mem.Count("claim-2") == 0 })
	if got := h.a.mem.Committed(); got != 2_048 {
		t.Fatalf("committed after release = %d", got)
	}
}

// The base side of a Run that takes a warm pool machine builds nothing (its
// images are the bake's): it is counted at its ready size from the start,
// so it fits next to its PR's build. The PR side is counted at its build.
func TestAWarmBaseClaimIsCountedAtItsReadySize(t *testing.T) {
	h, img := poolHarness(t, withMemory(14_745))
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: img, Size: 1}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(h.poolMachines(img)) == 1 })
	base := h.acquireBody()
	base.ImageID = "latest"
	if got := h.a.claimMemoryNeed(*base, h.a.hasPoolMachine(*base, h.clk.Now().Add(50*60e9))); got != 2_048 {
		t.Fatalf("a warm base is counted at %d MB", got)
	}
	pr := *base
	pr.Side = protocol.SidePr
	if got := h.a.claimMemoryNeed(pr, true); got != 12_288 {
		t.Fatalf("a PR on a pool machine is counted at %d MB", got)
	}
	if len(h.poolMachines(img)) != 1 {
		t.Fatal("looking for a pool machine took it")
	}
}

// Without the hub's accept, or without a budget, heartbeat carries no
// memory, and a cell without a budget admits by slots alone. An older hub
// would read no_capacity as the claim's failure: the cell counts the claim
// but never refuses it there.
func TestHeartbeatMemoryOnlyToAHubThatAcceptsIt(t *testing.T) {
	h := newHarness(t, withMemory(14_745))
	if hb := h.a.Heartbeat(); hb.Memory != nil {
		t.Fatal("heartbeat memory went to a hub that does not accept it")
	}
	h.a.mem.Admit("claim-held", 12_288, true)
	h.ready("claim-old-hub", func(b *protocol.ClaimAcquireBody) { b.Side = protocol.SidePr })
	plain := newHarness(t)
	plain.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureCellMemory}})
	if hb := plain.a.Heartbeat(); hb.Memory != nil || plain.a.mem != nil {
		t.Fatal("a cell without a memory budget reported memory")
	}
	plain.ready("claim-1")
}
