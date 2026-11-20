package main

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// The package mirror reads for a claim of the cell until it is sealed.
func TestTheMirrorServesNoSealedClaim(t *testing.T) {
	store := policy.NewStore(nil)
	put := func(sealed bool) {
		t.Helper()
		if err := store.Put(policy.ClaimPolicy{ClaimID: "c", OrgID: "o", Sources: []string{"10.0.0.2"}, Phase: policy.PhaseTest, Sealed: sealed, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest("GET", "/npm/left-pad", nil)
	req.RemoteAddr = "10.0.0.2:5555"
	put(false)
	if !servesClaim(store, req) {
		t.Fatal("a claim of the cell is refused")
	}
	put(true)
	if servesClaim(store, req) {
		t.Fatal("a sealed claim reads from the mirror")
	}
	req.RemoteAddr = "10.0.0.9:5555"
	if servesClaim(store, req) {
		t.Fatal("an unknown source reads from the mirror")
	}
}
