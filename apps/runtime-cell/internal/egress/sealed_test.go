package egress

import (
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// A sealed claim reaches nothing, even a host an older policy left on its
// allowlist (the sealed marker decides before the list does), and a push of
// the sealed policy cuts what it had open.
func TestASealedClaimIsRefusedEveryConnection(t *testing.T) {
	r := newRig(t, nil)
	if body, err := r.tlsGet("registry.example"); err != nil || body != "upstream registry.example" {
		t.Fatalf("before the seal: %q %v", body, err)
	}
	if err := r.store.Put(policy.ClaimPolicy{
		ClaimID: "claim-1", OrgID: "org-a", Sources: []string{"127.0.0.1"}, Phase: policy.PhaseTest,
		Allow: []string{"registry.example"}, Sealed: true, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.tlsGet("registry.example"); err == nil {
		t.Fatal("a sealed claim got through")
	}
	if got := r.lastReason(t); got != "sealed" {
		t.Fatalf("reason %s, want sealed", got)
	}
}
