package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/mirror"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
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

// The artifact list serves a read-only prefix of hosts that stay on the deny
// list: the deny list does not learn an exception, and a host of the list is
// still refused to every claim, over the proxy and the resolver, for any path
// the mirror does not serve.
func TestTheArtifactHostsStayOnTheDenyListForEverythingElse(t *testing.T) {
	deny, err := netguard.NewDenyList(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !deny.Denies("storage.googleapis.com") || !netguard.OnKodusDenyList("storage.googleapis.com", nil) {
		t.Fatal("the object storage host left the deny list")
	}
	if !deny.Denies("other-bucket.storage.googleapis.com") {
		t.Fatal("a bucket host of the same service left the deny list")
	}
	for _, e := range mirror.DefaultArtifacts() {
		if e.Upstream.Scheme != "https" {
			t.Errorf("%s: %s", e.ID, e.Upstream)
		}
	}
}
