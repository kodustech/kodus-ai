package agent

import (
	"slices"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

func recommendedClaim(side protocol.Side) ClaimInfo {
	return ClaimInfo{
		ClaimID: "claim-1", CellTrusted: true,
		Acquire: protocol.ClaimAcquireBody{
			OrgID: "org-a", EnvironmentID: "env-1", Side: side, Consumer: protocol.ConsumerRuntime,
			HardExpiresAt: protocol.FormatTime(time.Now().Add(time.Hour)),
		},
		Workload: driver.MachineRef{PrivateAddress: "10.213.0.2"},
		Network:  driver.ClaimNetwork{Sources: []string{"10.213.0.250"}},
	}
}

// The recommended list's hosts join the claim on the inspected tier: D1
// (cdn.sheetjs.com under /xlsx-) and the registries, read only; the image
// builder is no inspect source.
func TestTheRecommendedListJoinsTheClaimInspected(t *testing.T) {
	p := EgressRules{Base: []string{"registry.npmjs.org"}, Inspect: netguard.RecommendedInspectRules()}
	pol, _, err := p.ClaimPolicy(recommendedClaim(protocol.SidePr), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range []string{"cdn.sheetjs.com", "registry.npmjs.org", "pypi.org", "objects.githubusercontent.com"} {
		if !pol.Allows(h) || !pol.InspectsFrom(h, "10.213.0.2") {
			t.Errorf("%s: allowed %v, inspected %v", h, pol.Allows(h), pol.InspectsFrom(h, "10.213.0.2"))
		}
	}
	if r, _ := pol.Inspects("cdn.sheetjs.com"); !slices.Equal(r.Paths, []string{"/xlsx-"}) {
		t.Fatalf("D1 paths %v", r.Paths)
	}
	if pol.InspectsFrom("registry.npmjs.org", "10.213.0.250") {
		t.Fatal("the builder is an inspect source")
	}
}

// D2: an org that turned the list off gets only the cell's base and its
// approvals; D4: a PR claim whose install is done drops the list.
func TestTheRecommendedListLeavesWithTheOrgsSwitchAndTheInstall(t *testing.T) {
	p := EgressRules{Inspect: netguard.RecommendedInspectRules()}
	off := false
	c := recommendedClaim(protocol.SidePr)
	c.Acquire.EgressRecommended = &off
	c.ExtraAllow = []string{"api.vendor.example"}
	pol, _, err := p.ClaimPolicy(c, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(pol.Allow, []string{"api.vendor.example"}) {
		t.Fatalf("org switched off: allow %v", pol.Allow)
	}
	c = recommendedClaim(protocol.SidePr)
	c.Running = true
	pol, _, err = p.ClaimPolicy(c, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if pol.Allows("cdn.sheetjs.com") || pol.Allows("registry.npmjs.org") {
		t.Fatalf("a running PR claim still reaches the install hosts: %v", pol.Allow)
	}
}

// github.com and registry.yarnpkg.com take writes: from the builder they are
// refused, unless the operator's own base list names them.
func TestAWriteCapableRecommendedHostIsRefusedFromTheBuilderUnlessTheOperatorAllowsIt(t *testing.T) {
	p := EgressRules{Inspect: netguard.RecommendedInspectRules()}
	pol, _, err := p.ClaimPolicy(recommendedClaim(protocol.SidePr), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if r, _ := pol.Inspects("github.com"); !r.RefuseUntrusted {
		t.Fatal("github.com goes out as passthrough from the builder")
	}
	if r, _ := pol.Inspects("cdn.sheetjs.com"); r.RefuseUntrusted {
		t.Fatal("a download CDN is refused to the builder (D1 builds install from it)")
	}
	p.Base = []string{"github.com"}
	pol, _, err = p.ClaimPolicy(recommendedClaim(protocol.SidePr), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if r, _ := pol.Inspects("github.com"); r.RefuseUntrusted {
		t.Fatal("the operator's base list no longer reaches the builder")
	}
}

// G1 from a build: the builder's address is a build source; the registries
// (they take publishes) are not its passthrough, the read-only CDNs are, and
// so are an owner's full-access approvals and the operator's own hosts.
func TestTheBuilderReachesOnlyReadOnlyCDNsAndFullAccessApprovals(t *testing.T) {
	p := EgressRules{Base: []string{"registry.npmjs.org"}, Inspect: netguard.RecommendedInspectRules(), Build: BuildPassthroughHosts(true, "files.corp.example")}
	c := recommendedClaim(protocol.SidePr)
	c.ExtraAllow = []string{"api.vendor.example", "files.corp.example"}
	pol, _, err := p.ClaimPolicy(c, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !pol.FromBuild("10.213.0.250") {
		t.Fatal("the builder is no build source")
	}
	for _, h := range []string{"registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "github.com", "registry-1.docker.io"} {
		if pol.BuildRefuses("10.213.0.250", h, true) == "" {
			t.Errorf("%s: a build reaches it uninspected", h)
		}
	}
	for _, h := range []string{"cdn.sheetjs.com", "dl-cdn.alpinelinux.org", "files.pythonhosted.org", "api.vendor.example", "files.corp.example"} {
		if why := pol.BuildRefuses("10.213.0.250", h, true); why != "" {
			t.Errorf("%s: refused to the build (%s)", h, why)
		}
	}
}

// A recipe's hosts pass on the operator's base list or an approval, never on
// the recipe alone, the deny list wins over both, and the check leaves the
// base list as it was.
func TestRecipeEgressUsesOperatorDefaultsAndApprovalsWithoutExpandingThem(t *testing.T) {
	p := EgressRules{Base: []string{"registry.npmjs.org"}}
	for _, tc := range []struct {
		name, host string
		approved   []string
		allowed    bool
	}{
		{name: "operator default", host: "registry.npmjs.org", allowed: true},
		{name: "admin approval", host: "api.example.com", approved: []string{"api.example.com"}, allowed: true},
		{name: "recipe alone is not approval", host: "api.example.com", allowed: false},
		{name: "deny list wins", host: "api.openai.com", approved: []string{"api.openai.com"}, allowed: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec, err := recipe.Parse([]byte("version: 1\negress: { allow: [" + tc.host + "] }\n"))
			if err != nil {
				t.Fatal(err)
			}
			err = p.CheckRecipeEgress(rec, tc.approved)
			if (err == nil) != tc.allowed {
				t.Fatalf("authorization outcome allowed=%t error=%v", tc.allowed, err)
			}
		})
	}
	if len(p.Base) != 1 || p.Base[0] != "registry.npmjs.org" {
		t.Fatal("recipe changed operator policy")
	}
}

// A host the platform denies is left out of the claim's policy and returned
// as refused, so the cell can count it.
func TestADeniedHostIsLeftOutOfTheClaimPolicyAndReported(t *testing.T) {
	c := recommendedClaim(protocol.SidePr)
	c.ExtraAllow = []string{"api.openai.com", "api.vendor.example"}
	pol, refused, err := EgressRules{}.ClaimPolicy(c, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if pol.Allows("api.openai.com") || !pol.Allows("api.vendor.example") {
		t.Fatalf("allow %v", pol.Allow)
	}
	if !slices.Equal(refused, []string{"api.openai.com"}) {
		t.Fatalf("refused %v", refused)
	}
}
