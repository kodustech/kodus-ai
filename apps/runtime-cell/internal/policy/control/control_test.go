package control

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

func TestPushAndRemove(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	store := policy.NewStore(nil)
	var deleted []string
	srv := httptest.NewServer((&Server{Policies: store, AgentKey: pub, OnDelete: func(id string) { deleted = append(deleted, id) }}).Handler())
	defer srv.Close()
	p := Pusher{Endpoints: []Endpoint{{Name: "egress", URL: srv.URL}}, Key: priv}
	pol := policy.ClaimPolicy{ClaimID: "claim-1", OrgID: "o", Sources: []string{"10.0.0.1"}, Phase: policy.PhaseTest, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now()}
	if err := p.Push(context.Background(), pol); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.ForSource(net.ParseIP("10.0.0.1")); !ok {
		t.Fatal("not stored")
	}
	if err := p.Remove(context.Background(), "claim-1"); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.ForSource(net.ParseIP("10.0.0.1")); ok || len(deleted) != 1 {
		t.Fatal("not removed")
	}
}

// A removal the endpoint refused is an error: before, Remove ignored the
// status, so a 403 counted as done and the policy stayed on the proxy.
func TestRemoveReportsARefusedRemoval(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, otherKey, _ := ed25519.GenerateKey(rand.Reader)
	srv := httptest.NewServer((&Server{Policies: policy.NewStore(nil), AgentKey: pub}).Handler())
	defer srv.Close()
	err := Pusher{Endpoints: []Endpoint{{Name: "egress", URL: srv.URL}}, Key: otherKey}.Remove(context.Background(), "claim-1")
	if err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("refused removal reported as %v", err)
	}
}

func TestRemovalSignedLongAgoIsRefused(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	srv := httptest.NewServer((&Server{Policies: policy.NewStore(nil), AgentKey: pub}).Handler())
	defer srv.Close()
	sig, at := SignRemoval(priv, "claim-1", time.Now().Add(-time.Hour))
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/v1/policy/claim-1", nil)
	req.Header.Set(SignatureHeader, sig)
	req.Header.Set(SignedAtHeader, at)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("old removal: %d", resp.StatusCode)
	}
	// The signature is bound to the claim: it does not remove another one.
	sig, at = SignRemoval(priv, "claim-1", time.Now())
	req, _ = http.NewRequest(http.MethodDelete, srv.URL+"/v1/policy/claim-2", nil)
	req.Header.Set(SignatureHeader, sig)
	req.Header.Set(SignedAtHeader, at)
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("removal for another claim: %d", resp.StatusCode)
	}
}

func TestParseEndpointsNamesEveryComponent(t *testing.T) {
	eps, err := ParseEndpoints("egress=https://e:9443, resolver=https://r:9444,injector=https://i:9445/", RequiredEndpoints...)
	if err != nil || len(eps) != 3 || URL(eps, EndpointInjector) != "https://i:9445" {
		t.Fatalf("%+v %v", eps, err)
	}
	for _, bad := range []string{
		"https://e:9443,https://r:9444",                              // no names
		"egress=https://e:9443,resolver=https://r:9444",              // no injector
		"egress=http://e:9443,resolver=https://r,injector=https://i", // plain http
		"egress=https://e,egress=https://e2,resolver=https://r,injector=https://i",
	} {
		if _, err := ParseEndpoints(bad, RequiredEndpoints...); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// A failing component is named in the error.
func TestPushNamesTheEndpointThatFailed(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
	defer down.Close()
	err := Pusher{Endpoints: []Endpoint{{Name: "injector", URL: down.URL}}, Key: priv}.Remove(context.Background(), "claim-1")
	if err == nil || !strings.HasPrefix(err.Error(), "injector: status 503") {
		t.Fatalf("%v", err)
	}
}
