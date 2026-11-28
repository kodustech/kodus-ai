package policy

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
	"time"
)

// A sealed claim's policy keeps who the claim is (its sources, its steering
// address) and nothing it may reach, whatever the spec also carries.
func TestSealedPolicyAllowsNothing(t *testing.T) {
	now := time.Now()
	spec := Spec{
		ClaimID: "c", OrgID: "o", Phase: PhaseTest, Sources: []string{"10.0.0.2"}, SteerTo: "10.0.0.250", AppAddress: "10.0.0.2",
		Base: []string{"registry.npmjs.org"}, Extra: []string{"github.com"},
		GoPins: []string{"example.com/m@v1.0.0"}, ImagePins: []string{"alpine:3"},
		Inspect:        []InspectRule{{Host: "registry.npmjs.org", Paths: []string{"/"}}},
		InspectSources: []string{"10.0.0.2"},
		BuildSources:   []string{"10.0.0.3"}, BuildPassthrough: []string{"github.com"},
		Secrets: []Secret{{ID: "s", Placeholder: "kph_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Hosts: []string{"api.vendor.example"}}},
		Sealed:  true, ExpiresAt: now.Add(time.Hour), IssuedAt: now,
	}
	p, _, err := Build(spec, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Sealed {
		t.Fatal("the policy is not marked sealed")
	}
	if len(p.Allow) != 0 || len(p.CredentialHosts) != 0 || len(p.Inspected) != 0 || len(p.InspectSources) != 0 ||
		len(p.BuildPassthrough) != 0 || len(p.BuildSources) != 0 || len(p.GoPins) != 0 || len(p.ImagePins) != 0 || len(p.Secrets) != 0 || p.AppAddress != "" {
		t.Fatalf("a sealed policy carries something to reach: %+v", p)
	}
	for _, h := range []string{"github.com", "registry.npmjs.org", "api.vendor.example"} {
		if p.Allows(h) || p.Injects(h) {
			t.Errorf("%s is reachable", h)
		}
	}
	if len(p.Sources) != 1 || p.SteerTo != "10.0.0.250" {
		t.Fatalf("a sealed policy must still name the claim's machine: %+v", p)
	}
}

// A signed policy that says sealed and still lists a host is not one the
// enforcers take.
func TestSealedPolicyWithAHostIsRefused(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now()
	p := ClaimPolicy{ClaimID: "c", OrgID: "o", Sources: []string{"10.0.0.2"}, Phase: PhaseTest, Sealed: true, Allow: []string{"github.com"}, ExpiresAt: now.Add(time.Minute)}
	if _, err := Sign(priv, p); err == nil {
		t.Fatal("a sealed policy with an allowed host was signed")
	}
	p = ClaimPolicy{ClaimID: "c", OrgID: "o", Sources: []string{"10.0.0.2"}, Phase: PhaseTest, Sealed: true, ExpiresAt: now.Add(time.Minute)}
	if _, err := Sign(priv, p); err != nil {
		t.Fatal(err)
	}
}
