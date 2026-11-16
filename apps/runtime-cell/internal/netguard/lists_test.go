package netguard

import (
	"bytes"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// The same file runs in libs/runtime/protocol/egress-catalog.spec.ts: one deny
// list for the API and the cell (G2, S-59).

func TestEgressListsAreTheAPIsCopy(t *testing.T) {
	ts, err := os.ReadFile("../../../../libs/runtime/protocol/egress-lists.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ts, listsJSON) {
		t.Fatal("internal/netguard/egress-lists.json differs from libs/runtime/protocol/egress-lists.json: copy it over")
	}
}

func TestDenyListGivesTheSharedCases(t *testing.T) {
	for _, h := range lists.Deny.Cases.Denied {
		if !OnKodusDenyList(h, nil) {
			t.Errorf("%s not denied", h)
		}
	}
	for _, h := range lists.Deny.Cases.Allowed {
		if OnKodusDenyList(h, nil) {
			t.Errorf("%s over-denied", h)
		}
	}
}

// Before G2 the cell's list missed what only the API refused: an
// -egress-allow or a secret host of raw.githubusercontent.com, gist.github.com,
// discord.com or openrouter.ai reached the claim.
func TestTheAPIsDenialsNowHoldInTheCell(t *testing.T) {
	var zero DenyList
	for _, h := range []string{"raw.githubusercontent.com", "gist.github.com", "gist.githubusercontent.com", "discord.com", "evil.workers.dev", "openrouter.ai", "api.groq.com", "bedrock-runtime.eu-west-1.amazonaws.com", "x.localtunnel.me"} {
		if !zero.Denies(h) {
			t.Errorf("%s: the API refuses it, the cell let it through", h)
		}
	}
}

func TestTheCellsOwnNamesAreNotDenied(t *testing.T) {
	var zero DenyList
	for _, h := range []string{policy.AppHost, policy.MirrorHost} {
		if zero.Denies(h) {
			t.Errorf("%s denied: the resolver and the mirror answer it", h)
		}
	}
	if !zero.Denies("other.cell.internal") {
		t.Error("another .internal name is not denied")
	}
}

func TestMatchesPatternIsTheAPIsGlob(t *testing.T) {
	cases := []struct {
		host, pattern string
		want          bool
	}{
		{"a.ngrok.io", "*.ngrok.io", true},
		{"ngrok.io", "*.ngrok.io", false},
		{"a.b.ngrok.io", "*.ngrok.io", true},
		{"s3-us-west-2.amazonaws.com", "s3-*.amazonaws.com", true},
		{"xs3-us-west-2.amazonaws.com", "s3-*.amazonaws.com", false},
		{"api.openai.com", "api.openai.com", true},
		{"api.openai.com.evil.example", "api.openai.com", false},
	}
	for _, c := range cases {
		if got := MatchesPattern(c.host, c.pattern); got != c.want {
			t.Errorf("%s ~ %s: %v, want %v", c.host, c.pattern, got, c.want)
		}
	}
}

func TestRecommendedListIsExactAndNotDenied(t *testing.T) {
	if RecommendedVersion() < 1 {
		t.Fatal("no recommended version")
	}
	seen := map[string]bool{}
	for _, e := range Recommended() {
		n, err := policy.NormalizeHost(e.Host)
		if err != nil || n != e.Host || strings.Contains(e.Host, "*") {
			t.Errorf("%q is not an exact normalized host", e.Host)
		}
		if OnKodusDenyList(e.Host, nil) {
			t.Errorf("%s is recommended and denied", e.Host)
		}
		if seen[e.Host] {
			t.Errorf("%s twice", e.Host)
		}
		seen[e.Host] = true
		if e.Tier != TierMirror && e.Tier != TierInspected {
			t.Errorf("%s: tier %q", e.Host, e.Tier)
		}
		if len(e.Paths) == 0 {
			t.Errorf("%s: no paths", e.Host)
		}
	}
}

// S-59 One deny list: every host the API refuses is refused by the cell
// from every source a claim's allowlist is built from (the cell's base list,
// an approval, a secret's host).
func TestS59EveryAPIDenialLeavesEverySource(t *testing.T) {
	var deny DenyList
	ph, err := policy.NewPlaceholder()
	if err != nil {
		t.Fatal(err)
	}
	var hosts []string
	for _, h := range lists.Deny.Cases.Denied {
		if n, err := policy.NormalizeHost(h); err == nil && n == h {
			hosts = append(hosts, h)
		}
	}
	now := time.Unix(1_700_000_000, 0).UTC()
	pol, refused, err := policy.Build(policy.Spec{
		ClaimID: "c1", OrgID: "o1", Phase: policy.PhaseBuild, Sources: []string{"10.0.0.2"},
		Base: hosts, Extra: hosts,
		Secrets:   []policy.Secret{{ID: "s1", Placeholder: ph, Hosts: hosts}},
		ExpiresAt: now.Add(time.Hour), IssuedAt: now,
	}, deny.Denies)
	if err != nil {
		t.Fatal(err)
	}
	if len(pol.Allow) != 0 || len(pol.CredentialHosts) != 0 || len(pol.Secrets) != 0 {
		t.Fatalf("a denied host reached the signed policy: allow %v, credential %v", pol.Allow, pol.CredentialHosts)
	}
	if len(refused) < len(hosts) {
		t.Fatalf("refused %d of %d", len(refused), len(hosts))
	}
}
