package injector

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

func signedPolicyForBinding(b Binding, now time.Time) policy.ClaimPolicy {
	return policy.ClaimPolicy{ClaimID: b.Scope.ClaimID, OrgID: b.Scope.OrganizationID, EnvironmentID: b.Scope.EnvironmentID, Sources: []string{"127.0.0.1"}, Allow: []string{b.Host}, CredentialHosts: []string{b.Host}, Phase: policy.PhaseTest, ExpiresAt: now.Add(time.Hour), IssuedAt: now}
}
func installSignedPolicy(t *testing.T, handler http.Handler, key ed25519.PrivateKey, p policy.ClaimPolicy) {
	t.Helper()
	signed, err := policy.Sign(key, p)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(signed)
	if err != nil {
		t.Fatal(err)
	}
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, httptest.NewRequest(http.MethodPut, "/v1/policy", bytes.NewReader(raw)))
	if rr.Code != http.StatusNoContent {
		t.Fatalf("signed policy refused: %d", rr.Code)
	}
}
func TestPolicyClaimAuthorizerRequiresSignedExactLiveScope(t *testing.T) {
	for _, change := range []string{"valid", "legacy", "organization", "environment", "claim", "host", "not_credentialed", "expired", "past_hard_expiry"} {
		t.Run(change, func(t *testing.T) {
			cfg, _, binding := vaultFixture(t)
			now := cfg.Now()
			current := now
			clock := func() time.Time { return current }
			pub, key, _ := ed25519.GenerateKey(rand.Reader)
			store := policy.NewStore(clock)
			handler := (&control.Server{Policies: store, AgentKey: pub, Now: clock}).Handler()
			p := signedPolicyForBinding(binding, now)
			switch change {
			case "legacy":
				p.EnvironmentID = ""
			case "organization":
				p.OrgID = "org-b"
			case "environment":
				p.EnvironmentID = "env-b"
			case "claim":
				binding.Scope.ClaimID = "claim-b"
			case "host":
				binding.Host = "other.example.test"
			case "not_credentialed":
				p.CredentialHosts = nil
			case "past_hard_expiry":
				binding.ExpiresAt = p.ExpiresAt.Add(time.Second)
			}
			installSignedPolicy(t, handler, key, p)
			if change == "expired" {
				current = p.ExpiresAt
			}
			authority, err := (PolicyClaimAuthorizer{Policies: store, Now: clock}).AuthorizeBinding(context.Background(), binding)
			if change == "valid" {
				if err != nil || authority.Scope != binding.Scope || !authority.ExpiresAt.Equal(p.ExpiresAt) {
					t.Fatalf("valid signed authority lost: %v", err)
				}
			} else if !errors.Is(err, ErrVaultDenied) {
				t.Fatalf("scope not refused: %v", err)
			}
		})
	}
}
func TestPolicyClaimAuthorizerRealMTLSAndSigningBoundary(t *testing.T) {
	cfg, _, b := vaultFixture(t)
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	store := policy.NewStore(cfg.Now)
	ca, err := testpki.NewCA("synthetic-cell-ca")
	if err != nil {
		t.Fatal(err)
	}
	serverCert, err := ca.Issue("injector", time.Hour, "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	agentCert, err := ca.Issue("cell-a", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer((&control.Server{Policies: store, AgentKey: pub, Now: cfg.Now}).Handler())
	server.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientCAs: ca.Pool(), ClientAuth: tls.RequireAndVerifyClientCert, MinVersion: tls.VersionTLS13}
	server.StartTLS()
	defer server.Close()
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{Certificates: []tls.Certificate{agentCert}, RootCAs: ca.Pool(), MinVersion: tls.VersionTLS13}}, Timeout: time.Second}
	defer client.CloseIdleConnections()
	pusher := control.Pusher{Endpoints: []control.Endpoint{{Name: "injector", URL: server.URL}}, HTTP: client, Key: key, Now: cfg.Now}
	p := signedPolicyForBinding(b, cfg.Now())
	if err = pusher.Push(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	auth := PolicyClaimAuthorizer{Policies: store, Now: cfg.Now}
	if _, err = auth.AuthorizeBinding(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	_, wrongKey, _ := ed25519.GenerateKey(rand.Reader)
	forged := pusher
	forged.Key = wrongKey
	p.EnvironmentID = "env-b"
	if err = forged.Push(context.Background(), p); err == nil {
		t.Fatal("valid TLS peer replaced authority with wrong signature")
	}
	if a, err := auth.AuthorizeBinding(context.Background(), b); err != nil || a.Scope.EnvironmentID != "env-a" {
		t.Fatal("rejected signature changed authority")
	}
	otherCA, _ := testpki.NewCA("foreign-cell-ca")
	otherCert, _ := otherCA.Issue("cell-a", time.Hour)
	foreign := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{Certificates: []tls.Certificate{otherCert}, RootCAs: ca.Pool(), MinVersion: tls.VersionTLS13}}, Timeout: time.Second}
	defer foreign.CloseIdleConnections()
	wrongPeer := pusher
	wrongPeer.HTTP = foreign
	if err = wrongPeer.Push(context.Background(), p); err == nil {
		t.Fatal("untrusted mTLS peer admitted")
	}
	if err = pusher.Remove(context.Background(), b.Scope.ClaimID); err != nil {
		t.Fatal(err)
	}
	if _, err = auth.AuthorizeBinding(context.Background(), b); !errors.Is(err, ErrVaultDenied) {
		t.Fatal("removed signed policy still authorized")
	}
}
func TestCredentialStopsOnLivePolicyRemovalOverExistingConnection(t *testing.T) {
	cfg, version, b := vaultFixture(t)
	version.Value = secret
	b.Scope.ClaimID = "claim-1"
	b.Host = host
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	store := policy.NewStore(cfg.Now)
	handler := (&control.Server{Policies: store, AgentKey: pub, Now: cfg.Now}).Handler()
	p := signedPolicyForBinding(b, cfg.Now())
	installSignedPolicy(t, handler, key, p)
	cfg.Claims = PolicyClaimAuthorizer{Policies: store, Now: cfg.Now}
	vault, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer vault.Close()
	ctx := context.Background()
	if err = vault.PutVersion(ctx, version); err != nil {
		t.Fatal(err)
	}
	if err = vault.Bind(ctx, b); err != nil {
		t.Fatal(err)
	}
	rig := newRig(t, func(in *Injector) { in.Vault = vault; in.Policies = store })
	resp, err := rig.vm.Get("https://" + host + "/echo")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal("valid credential refused")
	}
	<-rig.seen
	noSecret(t, "signed authority echo", body)
	sig, at := control.SignRemoval(key, b.Scope.ClaimID, cfg.Now())
	req := httptest.NewRequest(http.MethodDelete, "/v1/policy/"+b.Scope.ClaimID, nil)
	req.Header.Set(control.SignatureHeader, sig)
	req.Header.Set(control.SignedAtHeader, at)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != 204 {
		t.Fatal("signed removal refused")
	}
	resp, err = rig.vm.Get("https://" + host + "/echo")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatal("stale TLS connection kept a revoked policy's credential")
	}
	select {
	case <-rig.seen:
		t.Fatal("denied request reached upstream")
	default:
	}
}
func TestCredentialAuthorityCheckDoesNotHoldVaultLockAcrossRevocation(t *testing.T) {
	for _, kind := range []string{"version", "claim"} {
		t.Run(kind, func(t *testing.T) {
			cfg, version, b := vaultFixture(t)
			entered := make(chan struct{})
			release := make(chan struct{})
			var calls atomic.Int64
			cfg.Claims = vaultAuthorityFunc(func(ctx context.Context, b Binding) (ClaimAuthority, error) {
				if calls.Add(1) == 2 {
					close(entered)
					select {
					case <-release:
					case <-ctx.Done():
						return ClaimAuthority{}, ctx.Err()
					}
				}
				return (allowVaultClaim{}).AuthorizeBinding(ctx, b)
			})
			vault, err := OpenConfiguredVault(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer vault.Close()
			var releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			defer unblock()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err = vault.PutVersion(ctx, version); err != nil {
				t.Fatal(err)
			}
			if err = vault.Bind(ctx, b); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { _, err := vault.Credential(ctx, "org-a", b.Scope.ClaimID, b.Host); done <- err }()
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal("authority lookup did not start")
			}
			revoked := make(chan error, 1)
			go func() {
				if kind == "version" {
					revoked <- vault.RevokeVersion(ctx, version.Scope, version.ID, version.Version)
				} else {
					revoked <- vault.RevokeClaim(ctx, b.Scope)
				}
			}()
			select {
			case err := <-revoked:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("authority lookup held vault lock")
			}
			// A valid authority answer still must not release a version/claim
			// revoked while that answer was being obtained.
			unblock()
			select {
			case err := <-done:
				if !errors.Is(err, ErrVaultDenied) {
					t.Fatal("revoked value released after authority wait")
				}
			case <-time.After(time.Second):
				t.Fatal("lookup did not end")
			}
		})
	}
}
