package agent

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// EgressRules are the cell's egress settings every claim's signed policy is
// built from; cmd/cell pushes what ClaimPolicy builds.
type EgressRules struct {
	// Base is the operator's allowlist every claim gets (-egress-allow).
	Base []string
	// Inspect are the inspected tier's rules (the recommended list); only
	// the ones whose host is on a claim's allowlist are signed.
	Inspect []policy.InspectRule
	// Build are the hosts an image build reaches uninspected besides the
	// owners' full-access approvals (BuildPassthroughHosts).
	Build []string
	// Deny is the platform's deny list; the proxy and the resolver add the
	// operator's own entries on their side (netguard.RegisterDenyFlags).
	Deny netguard.DenyList
}

// ClaimPolicy is the claim's signed policy: the cell's base list, the
// recommended list while the claim gets it (RecommendedOn), the hub's
// approvals and the inspected rules, minus what the platform denies, which
// it returns as refused.
func (r EgressRules) ClaimPolicy(c ClaimInfo, now time.Time) (pol policy.ClaimPolicy, refused []string, err error) {
	spec, err := PolicySpec(c, r.Base, now)
	if err != nil {
		return policy.ClaimPolicy{}, nil, err
	}
	if c.Sealed {
		// Not the base list, the recommended one, an approval nor the build's
		// passthrough: a sealed claim's policy is who it is and nothing to reach.
		return policy.Build(spec, r.Deny.Denies)
	}
	spec.Inspect = InspectRulesFor(c, r.Inspect)
	// A host the operator put on the base list keeps reaching the builder as before.
	for i := range spec.Inspect {
		if spec.Inspect[i].RefuseUntrusted && slices.Contains(r.Base, spec.Inspect[i].Host) {
			spec.Inspect[i].RefuseUntrusted = false
		}
	}
	if RecommendedOn(c) {
		spec.Base = append(slices.Clone(spec.Base), r.RecommendedHosts()...)
	}
	if c.Acquire.Consumer == protocol.ConsumerSandbox {
		spec.Base = SandboxBase(spec.Base, spec.Inspect, c.ExtraAllow)
	}
	spec.BuildPassthrough = append(spec.BuildPassthrough, r.Build...)
	return policy.Build(spec, r.Deny.Denies)
}

// goProxyHosts are the Go module proxy and checksum database: an inspected
// GET there makes Google fetch an attacker-chosen module path (H5), so a
// sandbox gets them only when its caller asked (ExtraAllow).
var goProxyHosts = []string{"proxy.golang.org", "sum.golang.org"}

// SandboxBase is the part of the base list an unsealed sandbox claim keeps:
// a host only when an inspect rule covers it (read-only), never uninspected
// (ghcr.io, rubygems.org and crates.io write APIs were reachable that way),
// and never the Go proxy hosts unless the caller asked for them. Run, setup
// and build claims keep the whole base list.
func SandboxBase(base []string, inspect []policy.InspectRule, asked []string) []string {
	inspected := map[string]bool{}
	for _, r := range inspect {
		inspected[r.Host] = true
	}
	var out []string
	for _, h := range base {
		if slices.Contains(goProxyHosts, h) && !slices.Contains(asked, h) {
			continue
		}
		if inspected[h] {
			out = append(out, h)
		}
	}
	return out
}

// RecommendedHosts are the hosts of the recommended list this cell applies
// (none with -egress-recommended=false).
func (r EgressRules) RecommendedHosts() []string {
	out := make([]string, 0, len(r.Inspect))
	for _, rule := range r.Inspect {
		out = append(out, rule.Host)
	}
	return out
}

// CheckRecipeEgress checks a recipe's hosts against the cell's base list,
// the recommended hosts and the approvals (CheckRecipeEgress).
func (r EgressRules) CheckRecipeEgress(rec *recipe.Recipe, approved []string) error {
	return CheckRecipeEgress(rec, append(slices.Clone(r.Base), r.RecommendedHosts()...), approved, r.Deny.Denies)
}

// BuildPassthroughHosts are the hosts every claim's image build may reach
// uninspected: the recommended list's read-only CDNs (with the list on) and
// the operator's own (a comma-separated list).
func BuildPassthroughHosts(recommended bool, operator string) []string {
	var out []string
	if recommended {
		out = append(out, netguard.RecommendedBuildPassthrough()...)
	}
	for _, h := range strings.Split(operator, ",") {
		if h = strings.TrimSpace(strings.ToLower(h)); h != "" {
			out = append(out, h)
		}
	}
	return out
}

// PolicySpec is what the claim's signed egress policy is built from
// (policy.Build): the cell's base allowlist, the hub's hosts for the claim,
// the addresses its traffic comes from, the checkout's pins and the org's
// secrets as placeholders. The cell's EgressControl pushes the built policy
// to the proxy, the resolver and the injector.
func PolicySpec(c ClaimInfo, base []string, issuedAt time.Time) (policy.Spec, error) {
	phase := policy.PhaseTest
	if c.Acquire.Side == protocol.SideSetup {
		phase = policy.PhaseBuild
	}
	hard, err := protocol.ParseTime(c.Acquire.HardExpiresAt)
	if err != nil {
		return policy.Spec{}, fmt.Errorf("egress policy expiry: %w", err)
	}
	return policy.Spec{
		ClaimID: c.ClaimID, OrgID: c.Acquire.OrgID, EnvironmentID: c.Acquire.EnvironmentID, Phase: phase,
		// The machines, the compose containers and what the driver runs
		// for the claim (the image builder). A sandbox has no observer.
		Sources:    nonEmpty([]string{c.Workload.PrivateAddress, c.Observer.PrivateAddress}, c.Sources, c.Network.Sources),
		Base:       base,
		Extra:      c.ExtraAllow, // the hub's egress.policy
		AppAddress: c.Workload.PrivateAddress,
		// On a network with no route out, every allowed name leads to the proxy.
		SteerTo:   c.Network.EgressAddress,
		GoPins:    c.GoPins,
		ImagePins: c.ImagePins,
		// The org's secrets as placeholders: the injector swaps each for its
		// value on the secret's hosts (a denied host is dropped and reported).
		Secrets:        c.OrgSecrets,
		Inspect:        c.ExtraInspect,
		InspectSources: inspectSources(c),
		// The image builder (the driver's own source): over TLS it reaches what
		// BuildPassthrough names, and, when its RUN steps trust the cell CA,
		// what the injector inspects or injects for it (G1, G6).
		BuildSources:     c.Network.Sources,
		BuildPassthrough: passthroughApprovals(c),
		BuildTrusted:     c.Network.SourcesTrustCellCA,
		Sealed:           c.Sealed,
		ExpiresAt:        hard, IssuedAt: issuedAt.UTC(),
	}, nil
}

// inspectSources are the claim's sources whose machines trust the cell CA:
// the workload and the containers its own boot started, never the observer.
// The driver's own (the image builder, Network.Sources) join them in the
// policy only when the driver says they trust it (BuildTrusted). None when
// the claim's boot gave no trust.
func inspectSources(c ClaimInfo) []string {
	if !c.CellTrusted {
		return nil
	}
	return nonEmpty([]string{c.Workload.PrivateAddress}, c.Sources)
}

// RecommendedOn reports whether the claim gets the Kodus recommended list's
// hosts: the org did not turn it off (claim.acquire egressRecommended), and
// the claim still installs. A PR or base claim whose install is done
// (Running) keeps only what its app calls at run time; a setup keeps them
// (its bake installs), and so does a sandbox (an agent session installs
// when it likes).
func RecommendedOn(c ClaimInfo) bool {
	if r := c.Acquire.EgressRecommended; r != nil && !*r {
		return false
	}
	return !c.Running || c.Acquire.Side == protocol.SideSetup || c.Acquire.Consumer == protocol.ConsumerSandbox
}

// InspectRulesFor are the inspected rules of the claim's policy: the
// recommended list's first (for its hosts the Kodus paths hold), then the
// hub's inspected approvals. A host an owner approved without inspection
// (in ExtraAllow, not in ExtraInspect: full access, the passthrough tier,
// and every approval of a hub before egressTiers) keeps that: the
// recommended rule does not narrow an explicit approval.
func InspectRulesFor(c ClaimInfo, recommended []policy.InspectRule) []policy.InspectRule {
	inspected := map[string]bool{}
	for _, r := range c.ExtraInspect {
		inspected[r.Host] = true
	}
	passthrough := map[string]bool{}
	for _, h := range c.ExtraAllow {
		if !inspected[h] {
			passthrough[h] = true
		}
	}
	out := make([]policy.InspectRule, 0, len(recommended)+len(c.ExtraInspect))
	for _, r := range recommended {
		if !passthrough[r.Host] {
			out = append(out, r)
		}
	}
	return append(out, c.ExtraInspect...)
}

// passthroughApprovals are the hub's approvals made with full access (in
// ExtraAllow, not in ExtraInspect): an owner's decision, which the build gets
// too. Every approval of a hub before egressTiers reads as one.
func passthroughApprovals(c ClaimInfo) []string {
	inspected := map[string]bool{}
	for _, r := range c.ExtraInspect {
		inspected[r.Host] = true
	}
	var out []string
	for _, h := range c.ExtraAllow {
		if !inspected[h] {
			out = append(out, h)
		}
	}
	return out
}

// nonEmpty joins the lists without their empty entries.
func nonEmpty(lists ...[]string) []string {
	var out []string
	for _, l := range lists {
		for _, a := range l {
			if a != "" {
				out = append(out, a)
			}
		}
	}
	return out
}
