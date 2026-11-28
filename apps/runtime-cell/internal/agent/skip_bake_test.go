package agent

import (
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// A base claim that skips the bake builds from the recipe: the environment's
// bake and a ready pool machine are both there, and it takes neither.
func TestASkipBakeClaimTakesNeitherTheBakeNorAPoolMachine(t *testing.T) {
	h, img := poolHarness(t)
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: "latest", Size: 1}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(h.poolMachines(img)) == 1 })
	yes := true
	b := h.acquireBody()
	b.ImageID, b.SkipBake = "latest", &yes
	if err := h.handle("claim-cold", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	if got := h.drv.AdoptionsSnapshot(); len(got) != 0 {
		t.Fatalf("a skipBake claim adopted %v", got)
	}
	c, _ := h.a.claims.Get("claim-cold")
	if got := c.Machines().Workload.ImageID; got != latestImage {
		t.Fatalf("the claim runs on %q, not the unresolved %q: it took the bake %q", got, latestImage, img)
	}
}

// Only a base claim that is not a setup may skip the bake.
func TestSkipBakeIsRefusedOnAPRClaimAndOnASetup(t *testing.T) {
	h := newHarness(t)
	yes := true
	b := h.acquireBody()
	b.SkipBake, b.Side = &yes, protocol.SidePr
	if code := nackCode(h.handle("claim-pr", protocol.MessageTypeClaimAcquire, b)); code != "skip_bake_refused" {
		t.Fatalf("skipBake on a PR claim: %q", code)
	}
	b.Side, b.Consumer = protocol.SideBase, protocol.ConsumerSetup
	b.HardExpiresAt = protocol.FormatTime(h.clk.Now().Add(40 * time.Minute))
	if code := nackCode(h.handle("claim-setup", protocol.MessageTypeClaimAcquire, b)); code != "skip_bake_refused" {
		t.Fatalf("skipBake on a setup claim: %q", code)
	}
}
