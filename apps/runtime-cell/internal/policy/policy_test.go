package policy

import (
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"strings"
	"testing"
	"time"
)

func TestSignVerify(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now()
	p := ClaimPolicy{ClaimID: "c", OrgID: "o", Sources: []string{"10.0.0.1"}, Phase: PhaseTest, Allow: []string{"a.example"}, ExpiresAt: now.Add(time.Minute)}
	s, err := Sign(priv, p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(pub, s, now); err != nil {
		t.Fatal(err)
	}
	tampered := s
	tampered.Policy = []byte(string(s.Policy[:len(s.Policy)-1]) + ` `)
	if _, err := Verify(pub, tampered, now); err != ErrBadSignature {
		t.Fatal("tampered policy verified")
	}
	if _, err := Verify(pub, s, now.Add(2*time.Minute)); err == nil {
		t.Fatal("expired policy verified")
	}
	for _, bad := range []ClaimPolicy{
		{ClaimID: "c", OrgID: "o", Sources: []string{"::1"}, Phase: PhaseTest, ExpiresAt: now.Add(time.Minute)},
		{ClaimID: "c", OrgID: "o", Sources: []string{"10.0.0.1"}, Phase: PhaseTest, Allow: []string{"A.example"}, ExpiresAt: now.Add(time.Minute)},
		{ClaimID: "c", OrgID: "o", Sources: []string{"10.0.0.1"}, Phase: "deploy", ExpiresAt: now.Add(time.Minute)},
		// Non-canonical spellings would be stored and never found again.
		{ClaimID: "c", OrgID: "o", Sources: []string{"::ffff:10.0.0.1"}, Phase: PhaseTest, ExpiresAt: now.Add(time.Minute)},
		{ClaimID: "c", OrgID: "o", Sources: []string{"10.0.0.1"}, Phase: PhaseTest, AppAddress: "app", ExpiresAt: now.Add(time.Minute)},
	} {
		if _, err := Sign(priv, bad); err == nil {
			t.Fatalf("signed %+v", bad)
		}
	}
}

func TestStoreSourcesBelongToOneClaim(t *testing.T) {
	s := NewStore(nil)
	exp := time.Now().Add(time.Minute)
	if err := s.Put(ClaimPolicy{ClaimID: "a", Sources: []string{"10.0.0.1"}, ExpiresAt: exp}); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(ClaimPolicy{ClaimID: "b", Sources: []string{"10.0.0.1"}, ExpiresAt: exp}); err == nil {
		t.Fatal("two claims share a source")
	}
	if p, ok := s.ForSource(net.ParseIP("10.0.0.1")); !ok || p.ClaimID != "a" {
		t.Fatal("lookup")
	}
}

func TestStoreRepushReplacesAndRefusesStale(t *testing.T) {
	s := NewStore(nil)
	now := time.Now()
	exp := now.Add(time.Minute)
	first := ClaimPolicy{ClaimID: "a", Sources: []string{"10.0.0.1"}, Allow: []string{"x.example"}, ExpiresAt: exp, IssuedAt: now}
	if err := s.Put(first); err != nil {
		t.Fatal(err)
	}
	second := first
	second.Allow, second.IssuedAt = []string{"x.example", "y.example"}, now.Add(time.Second)
	if err := s.Put(second); err != nil {
		t.Fatalf("re-push refused: %v", err)
	}
	if p, _ := s.ForSource(net.ParseIP("10.0.0.1")); !p.Allows("y.example") {
		t.Fatal("re-push did not replace the allowlist")
	}
	if err := s.Put(first); err != ErrStale {
		t.Fatalf("stale policy: %v", err)
	}
	if p, _ := s.ForSource(net.ParseIP("10.0.0.1")); !p.Allows("y.example") {
		t.Fatal("stale policy replaced the newer one")
	}
}

func TestMergeAllow(t *testing.T) {
	got, err := MergeAllow([]string{"registry.npmjs.org", "Mirror.Example."}, []string{"api.stripe.com", "registry.npmjs.org"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"api.stripe.com", "mirror.example", "registry.npmjs.org"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v", got)
		}
	}
	if _, err := MergeAllow(nil, []string{"*.example.com"}); err == nil {
		t.Fatal("wildcard merged")
	}
	if got, _ := MergeAllow(nil, nil); got == nil || len(got) != 0 {
		t.Fatalf("empty merge %v", got)
	}
}

// A machine address is reused as soon as its claim ends. When the old
// claim's delete was lost, its expired policy must not hold the address and
// refuse the new claim's policy forever.
func TestStoreEvictsExpiredOwnerOfASource(t *testing.T) {
	now := time.Now()
	s := NewStore(func() time.Time { return now })
	if err := s.Put(ClaimPolicy{ClaimID: "old", Sources: []string{"10.0.0.1"}, ExpiresAt: now.Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Minute)
	if err := s.Put(ClaimPolicy{ClaimID: "new", Sources: []string{"10.0.0.1"}, ExpiresAt: now.Add(time.Minute)}); err != nil {
		t.Fatalf("expired owner still holds the source: %v", err)
	}
	if p, ok := s.ForSource(net.ParseIP("10.0.0.1")); !ok || p.ClaimID != "new" {
		t.Fatalf("lookup %+v %v", p, ok)
	}
	if got := s.Claims(); len(got) != 1 || got[0] != "new" {
		t.Fatalf("the expired policy was not evicted: %v", got)
	}
}

func TestStoreSweepAndTombstone(t *testing.T) {
	now := time.Now()
	s := NewStore(func() time.Time { return now })
	signed := ClaimPolicy{ClaimID: "a", Sources: []string{"10.0.0.1"}, ExpiresAt: now.Add(time.Hour), IssuedAt: now}
	_ = s.Put(signed)
	_ = s.Put(ClaimPolicy{ClaimID: "b", Sources: []string{"10.0.0.2"}, ExpiresAt: now.Add(time.Minute)})
	now = now.Add(2 * time.Minute)
	if gone := s.Sweep(); len(gone) != 1 || gone[0] != "b" {
		t.Fatalf("sweep %v", gone)
	}
	s.Delete("a")
	// Replaying the policy signed before the delete does not revive it.
	if err := s.Put(signed); err != ErrStale {
		t.Fatalf("replayed policy after delete: %v", err)
	}
	newer := signed
	newer.IssuedAt = now.Add(time.Second)
	if err := s.Put(newer); err != nil {
		t.Fatalf("a policy issued after the delete was refused: %v", err)
	}
}

// A host the platform denies is dropped from the signed allowlist and
// reported, instead of being signed and refused later by the proxy.
func TestBuildLeavesDeniedHostsOut(t *testing.T) {
	spec := Spec{
		ClaimID: "claim-1", OrgID: "org-a", Phase: PhaseTest, Sources: []string{"10.0.0.5"},
		Base: []string{"registry.npmjs.org"}, Extra: []string{"Pastebin.com.", "api.example"},
		ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now(),
	}
	denied := func(h string) bool { return h == "pastebin.com" }
	p, refused, err := Build(spec, denied)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(p.Allow, ",") != "api.example,registry.npmjs.org" {
		t.Errorf("allow = %v", p.Allow)
	}
	if strings.Join(refused, ",") != "pastebin.com" {
		t.Errorf("refused = %v, want the normalized denied host", refused)
	}
	if _, _, err := Build(Spec{ClaimID: "claim-1", OrgID: "org-a", Phase: PhaseTest}, denied); err == nil {
		t.Error("Build accepted a policy with no sources")
	}
}

func TestEnvironmentIdentityIsSignedAndLegacyOptional(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now()
	p := ClaimPolicy{ClaimID: "claim-a", OrgID: "org-a", EnvironmentID: "env-a", Sources: []string{"10.0.0.1"}, Allow: []string{"example.test"}, Phase: PhaseTest, ExpiresAt: now.Add(time.Hour)}
	signed, err := Sign(key, p)
	if err != nil {
		t.Fatal(err)
	}
	verified, err := Verify(pub, signed, now)
	if err != nil || verified.EnvironmentID != "env-a" {
		t.Fatalf("signed environment lost: %v", err)
	}
	changed := signed
	changed.Policy = []byte(strings.Replace(string(signed.Policy), "env-a", "env-b", 1))
	if _, err = Verify(pub, changed, now); err != ErrBadSignature {
		t.Fatal("unsigned environment substitution accepted")
	}
	p.EnvironmentID = ""
	signed, err = Sign(key, p)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(signed.Policy), "environmentId") {
		t.Fatal("legacy representation changed")
	}
	if _, err = Verify(pub, signed, now); err != nil {
		t.Fatal("legacy egress policy refused")
	}
	for _, invalid := range []string{"../env", " env-a", strings.Repeat("x", 97)} {
		p.EnvironmentID = invalid
		if _, err = Sign(key, p); err == nil {
			t.Fatal("invalid environment identity signed")
		}
	}
	out, _, err := Build(Spec{ClaimID: "claim-a", OrgID: "org-a", EnvironmentID: "env-a", Sources: p.Sources, Base: p.Allow, Phase: PhaseTest, ExpiresAt: p.ExpiresAt}, nil)
	if err != nil || out.EnvironmentID != "env-a" {
		t.Fatalf("builder lost environment: %v", err)
	}
}
