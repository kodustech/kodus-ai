package agent

import (
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// claim.ready says how the claim's workload came to be, for the usage
// report: pool for a ready pool machine it adopted, bake for a base that
// boots a bake this cell made, cold for one it built. A hub that does not
// accept the field hears nothing: its strict decoder would refuse it.
func TestClaimReadySaysHowTheWorkloadCameToBe(t *testing.T) {
	startOf := func(t *testing.T, accept bool, edit func(h *harness, img string, b *protocol.ClaimAcquireBody)) *protocol.ClaimReadyBodyStart {
		t.Helper()
		h, img := poolHarness(t)
		if accept {
			h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureReadyStart}})
		}
		b := h.acquireBody()
		edit(h, img, b)
		if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
			t.Fatal(err)
		}
		return h.conn.next(t, isReady).(*protocol.ClaimReadyBody).Start
	}
	fromPool := func(h *harness, img string, b *protocol.ClaimAcquireBody) {
		if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: img, Size: 1}); err != nil {
			t.Fatal(err)
		}
		waitFor(t, func() bool { return len(h.poolMachines(img)) == 1 })
		b.ImageID, b.Side = "latest", protocol.SidePr
	}
	fromBake := func(_ *harness, img string, b *protocol.ClaimAcquireBody) { b.ImageID = img }
	built := func(*harness, string, *protocol.ClaimAcquireBody) {}

	for _, tc := range []struct {
		name string
		edit func(*harness, string, *protocol.ClaimAcquireBody)
		want protocol.ClaimReadyBodyStart
	}{
		{"an adopted pool machine", fromPool, protocol.ClaimReadyBodyStartPool},
		{"a base on this cell's bake", fromBake, protocol.ClaimReadyBodyStartBake},
		{"a machine it built", built, protocol.ClaimReadyBodyStartCold},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := startOf(t, true, tc.edit); got == nil || *got != tc.want {
				t.Fatalf("start %v, want %s", got, tc.want)
			}
		})
	}
	if got := startOf(t, false, fromPool); got != nil {
		t.Fatalf("an older hub got start %s", *got)
	}
}
