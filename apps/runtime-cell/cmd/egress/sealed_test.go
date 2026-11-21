package main

import (
	"net/http"
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
	req := httptest.NewRequest(http.MethodGet, "/npm/left-pad", nil)
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

// No mirror route (Go, OCI, npm, PyPI) answers a sealed claim, whatever pins its policy had.
func TestNoMirrorRouteAnswersASealedClaim(t *testing.T) {
	store := policy.NewStore(nil)
	if err := store.Put(policy.ClaimPolicy{ClaimID: "c", OrgID: "o", Sources: []string{"10.0.0.2"}, Phase: policy.PhaseTest, Sealed: true, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	h := refuseSealed(store, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	for _, path := range []string{"/npm/left-pad", "/pypi/simple/requests/", "/go/example.com/m/@v/list", "/v2/library/alpine/manifests/3"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = "10.0.0.2:5555"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 403 {
			t.Errorf("%s: %d", path, rec.Code)
		}
	}
}
