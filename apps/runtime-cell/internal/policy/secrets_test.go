package policy

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"slices"
	"testing"
	"time"
)

func secretSpec(t *testing.T, secrets ...Secret) Spec {
	t.Helper()
	return Spec{
		ClaimID: "claim-1", OrgID: "org-a", Phase: PhaseBuild, Sources: []string{"10.0.0.2"},
		Base: []string{"registry.npmjs.org"}, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now(), Secrets: secrets,
	}
}

func placeholder(t *testing.T) string {
	t.Helper()
	p, err := NewPlaceholder()
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSecretHostsBecomeReachableThroughTheInjectorOnly(t *testing.T) {
	p, _, err := Build(secretSpec(t, Secret{ID: "npm", Placeholder: placeholder(t), Hosts: []string{"NPM.Corp.Example."}}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Allows("npm.corp.example") || !p.Injects("npm.corp.example") || p.Injects("registry.npmjs.org") {
		t.Fatalf("allow %v credential %v", p.Allow, p.CredentialHosts)
	}
	if got := p.SecretsFor("npm.corp.example"); len(got) != 1 || got[0].ID != "npm" {
		t.Fatalf("secrets for the host: %v", got)
	}
}

func TestDeniedSecretHostNeverCarriesTheSecret(t *testing.T) {
	denied := func(h string) bool { return h == "pastebin.com" }
	p, refused, err := Build(secretSpec(t,
		Secret{ID: "leaky", Placeholder: placeholder(t), Hosts: []string{"pastebin.com"}},
		Secret{ID: "npm", Placeholder: placeholder(t), Hosts: []string{"pastebin.com", "npm.corp.example"}},
	), denied)
	if err != nil {
		t.Fatal(err)
	}
	if p.Allows("pastebin.com") || p.Injects("pastebin.com") || !slices.Contains(refused, "pastebin.com") {
		t.Fatalf("allow %v credential %v refused %v", p.Allow, p.CredentialHosts, refused)
	}
	if len(p.Secrets) != 1 || p.Secrets[0].ID != "npm" || !slices.Equal(p.Secrets[0].Hosts, []string{"npm.corp.example"}) {
		t.Fatalf("secrets %v", p.Secrets)
	}
}

func TestSecretWithAWildcardHostIsRefused(t *testing.T) {
	if _, _, err := Build(secretSpec(t, Secret{ID: "npm", Placeholder: placeholder(t), Hosts: []string{"*.corp.example"}}), nil); err == nil {
		t.Fatal("a wildcard secret host was accepted")
	}
}

func TestVerifyRefusesASecretTheInjectorWouldNotServe(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	good, _, err := Build(secretSpec(t, Secret{ID: "npm", Placeholder: placeholder(t), Hosts: []string{"npm.corp.example"}}), nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*ClaimPolicy){
		"host not a credential host": func(p *ClaimPolicy) { p.Secrets[0].Hosts = []string{"registry.npmjs.org"} },
		"guessable placeholder":      func(p *ClaimPolicy) { p.Secrets[0].Placeholder = "npm-token" },
		"repeated placeholder": func(p *ClaimPolicy) {
			p.Secrets = append(p.Secrets, Secret{ID: "other", Placeholder: p.Secrets[0].Placeholder, Hosts: p.Secrets[0].Hosts})
		},
		"id outside the store layout": func(p *ClaimPolicy) { p.Secrets[0].ID = "../npm" },
	} {
		p := good
		p.Secrets = slices.Clone(good.Secrets)
		mutate(&p)
		raw, _ := json.Marshal(p)
		if _, err := Verify(pub, Signed{Policy: raw, Signature: ed25519.Sign(key, raw)}, time.Now()); err == nil {
			t.Errorf("%s: verified", name)
		}
	}
}

func TestPlaceholdersAreRandomAndOfTheirOwnForm(t *testing.T) {
	a, b := placeholder(t), placeholder(t)
	if a == b || !ValidPlaceholder(a) || !ValidPlaceholder(b) {
		t.Fatalf("%q %q", a, b)
	}
}
