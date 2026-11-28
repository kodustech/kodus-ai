//go:build unix

package agent

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// A sealed claim's policy allows nothing, with the cell's base list, the
// recommended list, an approval and the build's passthrough all present.
func TestASealedClaimsPolicyHasNoHostAndNoPassthrough(t *testing.T) {
	rules := EgressRules{
		Base: []string{"registry.npmjs.org", "ghcr.io"}, Inspect: netguard.RecommendedInspectRules(),
		Build: []string{"cdn.playwright.dev"},
	}
	c := ClaimInfo{
		ClaimID: "sbx-1", CellTrusted: true, ExtraAllow: []string{"github.com", "api.vendor.example"},
		Acquire: protocol.ClaimAcquireBody{
			OrgID: "org-a", EnvironmentID: "sandbox", Side: protocol.SidePr, Consumer: protocol.ConsumerSandbox,
			HardExpiresAt: protocol.FormatTime(time.Now().Add(time.Hour)),
		},
		Workload: driver.MachineRef{PrivateAddress: "10.213.0.2"},
		Network:  driver.ClaimNetwork{EgressAddress: "10.213.0.250", Sources: []string{"10.213.0.251"}},
	}
	open, _, err := rules.ClaimPolicy(c, time.Now())
	if err != nil || len(open.Allow) == 0 {
		t.Fatalf("the unsealed claim has no hosts to seal away: %v %v", open.Allow, err)
	}
	c.Sealed = true
	pol, _, err := rules.ClaimPolicy(c, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !pol.Sealed || len(pol.Allow) != 0 || len(pol.Inspected) != 0 || len(pol.InspectSources) != 0 || len(pol.BuildPassthrough) != 0 || len(pol.CredentialHosts) != 0 {
		t.Fatalf("a sealed policy reaches something: %+v", pol)
	}
	for _, h := range slices.Concat(rules.Base, rules.RecommendedHosts(), rules.Build, c.ExtraAllow) {
		if pol.Allows(h) {
			t.Errorf("%s is allowed", h)
		}
	}
	if !slices.Equal(pol.Sources, []string{"10.213.0.2", "10.213.0.251"}) || pol.SteerTo != "10.213.0.250" {
		t.Fatalf("the policy lost who the claim is: %+v", pol)
	}
}

// seal is the frame as the read loop answers it: a seal answers later.
func (h *harness) seal(claimID string) error {
	return h.a.Handle(h.t.Context(), msg(claimID, protocol.MessageTypeEgressPolicy, &protocol.EgressPolicyBody{Allow: []string{}, IssuedAt: protocol.FormatTime(h.clk.Now()), Sealed: boolp(true)}))
}

// sealed runs the seal's answer: the frame is acked only once the push is done.
func (h *harness) sealed(claimID string) error {
	h.t.Helper()
	err := h.seal(claimID)
	if run, ok := hubclient.IsLater(err); ok {
		return run(h.t.Context())
	}
	return err
}

func (h *harness) lastApplied() ClaimInfo {
	h.egress.mu.Lock()
	defer h.egress.mu.Unlock()
	return h.egress.applied[len(h.egress.applied)-1]
}

func TestSealingASandboxPushesAPolicyThatAllowsNothingAndAcksAfterIt(t *testing.T) {
	h, _ := newSandboxHarness(t, 0)
	h.sandboxReady("sbx-1", "org-a")
	before := len(h.egress.applied)
	err := h.seal("sbx-1")
	run, later := hubclient.IsLater(err)
	if !later {
		t.Fatalf("the seal answered before its push: %v", err)
	}
	if len(h.egress.applied) != before {
		t.Fatal("the seal pushed before it was asked to answer")
	}
	if err := run(t.Context()); err != nil {
		t.Fatalf("seal: %v", err)
	}
	if got := h.lastApplied(); !got.Sealed || got.ClaimID != "sbx-1" {
		t.Fatalf("the last push is not the sealed policy: %+v", got)
	}
	if !strings.Contains(h.logs.String(), "egress.sealed") {
		t.Fatal("the seal left no log line")
	}
}

// A seal changes the named claim of the named org and no other.
func TestSealingOneSandboxLeavesTheOthersOpen(t *testing.T) {
	h, _ := newSandboxHarness(t, 0)
	h.sandboxReady("sbx-a", "org-a")
	h.sandboxReady("sbx-b", "org-b")
	if err := h.sealed("sbx-a"); err != nil {
		t.Fatal(err)
	}
	// Any later push for the other claim is not sealed.
	if err := h.handle("sbx-b", protocol.MessageTypeEgressPolicy, &protocol.EgressPolicyBody{Allow: []string{"github.com"}, IssuedAt: protocol.FormatTime(h.clk.Now().Add(time.Second))}); err != nil {
		t.Fatal(err)
	}
	h.a.Wait()
	h.egress.mu.Lock()
	defer h.egress.mu.Unlock()
	var sealedA, sealedB bool
	for _, ci := range h.egress.applied {
		switch ci.ClaimID {
		case "sbx-a":
			sealedA = sealedA || ci.Sealed
		case "sbx-b":
			sealedB = sealedB || ci.Sealed
		}
	}
	if !sealedA || sealedB {
		t.Fatalf("sealed a=%v b=%v", sealedA, sealedB)
	}
}

// Approvals change (a new egress.policy on a live claim): a sealed claim stays sealed.
func TestASealedSandboxStaysSealedWhenApprovalsChange(t *testing.T) {
	h, _ := newSandboxHarness(t, 0)
	h.sandboxReady("sbx-1", "org-a")
	if err := h.sealed("sbx-1"); err != nil {
		t.Fatal(err)
	}
	later := protocol.FormatTime(h.clk.Now().Add(time.Minute))
	if err := h.handle("sbx-1", protocol.MessageTypeEgressPolicy, &protocol.EgressPolicyBody{Allow: []string{"github.com", "registry.npmjs.org"}, IssuedAt: later}); err != nil {
		t.Fatal(err)
	}
	h.a.Wait()
	c, _ := h.a.claims.Get("sbx-1")
	if !c.Sealed() {
		t.Fatal("the claim opened again")
	}
	if got := h.lastApplied(); !got.Sealed || len(got.ExtraAllow) != 0 || len(got.ExtraInspect) != 0 {
		t.Fatalf("a push after an approval carries hosts for a sealed claim: %+v", got)
	}
	// And a seal sent twice answers the same way.
	if err := h.sealed("sbx-1"); err != nil {
		t.Fatal(err)
	}
}

func TestSealRefusals(t *testing.T) {
	h, _ := newSandboxHarness(t, 0)
	h.sandboxReady("sbx-1", "org-a")
	h.ready("run-1")
	if code := nackCode(h.seal("claim-x")); code != "unknown_claim" {
		t.Fatalf("unknown claim: %q", code)
	}
	if code := nackCode(h.seal("run-1")); code != "not_supported" {
		t.Fatalf("a Run claim: %q", code)
	}
	if c, _ := h.a.claims.Get("run-1"); c.Sealed() {
		t.Fatal("a Run claim was sealed")
	}
	// A push that fails is a nack, never an ack: the product then drops the sandbox.
	h.egress.fail = errors.New("control port down")
	if code := nackCode(h.sealed("sbx-1")); code != "seal_failed" {
		t.Fatalf("failed push: %q", code)
	}
	// The claim stays sealed: the next push, whenever it lands, closes it.
	if c, _ := h.a.claims.Get("sbx-1"); !c.Sealed() {
		t.Fatal("a failed seal left the claim open")
	}
}

func TestACellWithNoEgressControlRefusesTheSeal(t *testing.T) {
	h, _ := newSandboxHarness(t, 0)
	h.sandboxReady("sbx-1", "org-a")
	h.a.cfg.Egress = nil
	if code := nackCode(h.seal("sbx-1")); code != "egress_unavailable" {
		t.Fatalf("no egress control: %q", code)
	}
}
