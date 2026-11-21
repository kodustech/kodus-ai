package agent

import (
	"slices"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// D4: a PR or base claim installs with the recommended list and runs
// without it; its last push says so. A setup keeps it (its bake installs).
func TestD4APRClaimDropsTheRecommendedListOnceItsInstallIsDone(t *testing.T) {
	for _, side := range []protocol.Side{protocol.SideBase, protocol.SidePr, protocol.SideSetup} {
		t.Run(string(side), func(t *testing.T) {
			h := newHarness(t)
			b := h.acquireBody()
			b.Side = side
			if side == protocol.SideSetup {
				b.Consumer, b.HardExpiresAt = protocol.ConsumerSetup, protocol.FormatTime(h.clk.Now().Add(40*time.Minute))
			}
			if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
				t.Fatal(err)
			}
			h.conn.next(t, isReady)
			last := h.egress.last("claim-1")
			if got, want := RecommendedOn(last), side == protocol.SideSetup; got != want {
				t.Fatalf("recommended on after the install: %v, want %v", got, want)
			}
			if side != protocol.SideSetup && !last.Running {
				t.Fatal("the last push is not the run's policy")
			}
		})
	}
}

func TestRecommendedOnFollowsTheOrgsSwitch(t *testing.T) {
	off := false
	c := ClaimInfo{Acquire: protocol.ClaimAcquireBody{Side: protocol.SideSetup, Consumer: protocol.ConsumerSetup, EgressRecommended: &off}}
	if RecommendedOn(c) {
		t.Fatal("the org turned the list off (D2)")
	}
	c.Acquire.EgressRecommended = nil
	if !RecommendedOn(c) {
		t.Fatal("absent means on")
	}
	sbx := ClaimInfo{Running: true, Acquire: protocol.ClaimAcquireBody{Side: protocol.SidePr, Consumer: protocol.ConsumerSandbox}}
	if !RecommendedOn(sbx) {
		t.Fatal("a sandbox installs when it likes")
	}
}

// An owner's full-access approval is not narrowed by the recommended rule;
// an inspected approval adds its own rule after the recommended ones.
func TestInspectRulesForKeepsAnExplicitPassthroughApproval(t *testing.T) {
	rec := []policy.InspectRule{{Host: "github.com", Paths: []string{"/*/*/releases/download/"}}, {Host: "registry.npmjs.org", Paths: []string{"/"}}}
	c := ClaimInfo{
		ExtraAllow:   []string{"github.com", "api.vendor.example"},
		ExtraInspect: []policy.InspectRule{{Host: "api.vendor.example", Paths: []string{"/v1/"}}},
	}
	got := InspectRulesFor(c, rec)
	hosts := make([]string, 0, len(got))
	for _, r := range got {
		hosts = append(hosts, r.Host)
	}
	if !slices.Equal(hosts, []string{"registry.npmjs.org", "api.vendor.example"}) {
		t.Fatalf("rules for %v", hosts)
	}
}
