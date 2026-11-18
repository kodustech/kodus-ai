package control

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// A signed delete used to acknowledge only volatile policy removal. An
// injector could recover a stored grant and release it after policy replay.
func TestRemovalDurabilityFailureDropsPolicyWithoutAcknowledging(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	store := policy.NewStore(nil)
	now := time.Now().UTC()
	if err := store.Put(policy.ClaimPolicy{ClaimID: "claim-a", OrgID: "org-a", Sources: []string{"10.0.0.1"}, Phase: policy.PhaseTest, IssuedAt: now, ExpiresAt: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	calls, deleted := 0, 0
	server := &Server{Policies: store, AgentKey: pub, DurableDelete: func(ctx context.Context, claim string) error {
		calls++
		if claim != "claim-a" || ctx.Err() != nil {
			t.Fatal("verified removal lost its request context or identity")
		}
		if _, live := store.ForClaim(claim); live || deleted != calls {
			t.Fatal("durable operation began before policy and connection revocation")
		}
		return errors.New("synthetic-private-vault-error")
	}, OnDelete: func(string) { deleted++ }}
	for i := 0; i < 2; i++ {
		sig, at := SignRemoval(key, "claim-a", now)
		req := httptest.NewRequest(http.MethodDelete, "/v1/policy/claim-a", nil)
		req.Header.Set(SignatureHeader, sig)
		req.Header.Set(SignedAtHeader, at)
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, req)
		if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), "synthetic-private") {
			t.Fatalf("durability failure acknowledged or exposed: status %d", response.Code)
		}
		if _, ok := store.ForClaim("claim-a"); ok || calls != i+1 || deleted != i+1 {
			t.Fatal("failed removal retained policy or retry skipped durable revocation")
		}
	}
}

func TestInvalidRemovalCannotInvokeDurableRevocation(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	_, wrongKey, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now().UTC()
	for _, kind := range []string{"signature", "expired", "future", "other_claim"} {
		t.Run(kind, func(t *testing.T) {
			store := policy.NewStore(nil)
			if err := store.Put(policy.ClaimPolicy{ClaimID: "claim-a", OrgID: "org-a", Sources: []string{"10.0.0.1"}, Phase: policy.PhaseTest, IssuedAt: now, ExpiresAt: now.Add(time.Hour)}); err != nil {
				t.Fatal(err)
			}
			called := false
			s := &Server{Policies: store, AgentKey: pub, DurableDelete: func(context.Context, string) error { called = true; return nil }, OnDelete: func(string) { t.Error("unauthorized connection callback") }}
			at, signer, signedClaim := now, key, "claim-a"
			switch kind {
			case "signature":
				signer = wrongKey
			case "expired":
				at = now.Add(-time.Hour)
			case "future":
				at = now.Add(time.Hour)
			case "other_claim":
				signedClaim = "claim-b"
			}
			sig, timestamp := SignRemoval(signer, signedClaim, at)
			req := httptest.NewRequest(http.MethodDelete, "/v1/policy/claim-a", nil)
			req.Header.Set(SignatureHeader, sig)
			req.Header.Set(SignedAtHeader, timestamp)
			rr := httptest.NewRecorder()
			s.Handler().ServeHTTP(rr, req)
			if rr.Code != http.StatusForbidden || called {
				t.Fatal("unauthorized removal reached durable vault")
			}
			if _, ok := store.ForClaim("claim-a"); !ok {
				t.Fatal("unauthorized removal dropped live policy")
			}
		})
	}
}

func TestCancelledDurableRemovalStillDropsMemoryAndCanRetry(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	store := policy.NewStore(nil)
	now := time.Now().UTC()
	if err := store.Put(policy.ClaimPolicy{ClaimID: "claim-a", OrgID: "org-a", Sources: []string{"10.0.0.1"}, Phase: policy.PhaseTest, IssuedAt: now, ExpiresAt: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	deleted := 0
	s := &Server{Policies: store, AgentKey: pub, DurableDelete: func(ctx context.Context, _ string) error { return ctx.Err() }, OnDelete: func(string) { deleted++ }}
	for i := 0; i < 2; i++ {
		ctx := context.Background()
		if i == 0 {
			var cancel context.CancelFunc
			ctx, cancel = context.WithCancel(ctx)
			cancel()
		}
		sig, timestamp := SignRemoval(key, "claim-a", now)
		req := httptest.NewRequest(http.MethodDelete, "/v1/policy/claim-a", nil).WithContext(ctx)
		req.Header.Set(SignatureHeader, sig)
		req.Header.Set(SignedAtHeader, timestamp)
		rr := httptest.NewRecorder()
		s.Handler().ServeHTTP(rr, req)
		want := http.StatusServiceUnavailable
		if i == 1 {
			want = http.StatusNoContent
		}
		if rr.Code != want || deleted != i+1 {
			t.Fatal("cancelled removal or retry reported incorrect durability")
		}
		if _, ok := store.ForClaim("claim-a"); ok {
			t.Fatal("cancelled durable write kept policy live")
		}
	}
}
