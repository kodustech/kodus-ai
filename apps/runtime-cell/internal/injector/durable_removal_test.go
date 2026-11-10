package injector

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// A live policy delete used to leave the encrypted grant reusable after a
// restart with a fresh policy store and replay of the original signed policy.
func TestSignedRemovalRevokesRecoveredGrantDespitePolicyReplay(t *testing.T) {
	cfg, secret, binding := vaultFixture(t)
	ctx := context.Background()
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	store := policy.NewStore(cfg.Now)
	cfg.Claims = PolicyClaimAuthorizer{Policies: store, Now: cfg.Now}
	vault, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer vault.Close()
	handler := (&control.Server{Policies: store, AgentKey: pub, Now: cfg.Now, DurableDelete: vault.RevokeKnownClaim}).Handler()
	original := signedPolicyForBinding(binding, cfg.Now())
	ca, err := testpki.NewCA("synthetic-durable-removal")
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
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientCAs: ca.Pool(), ClientAuth: tls.RequireAndVerifyClientCert, MinVersion: tls.VersionTLS13}
	server.StartTLS()
	defer server.Close()
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{Certificates: []tls.Certificate{agentCert}, RootCAs: ca.Pool(), MinVersion: tls.VersionTLS13}}, Timeout: time.Second}
	defer client.CloseIdleConnections()
	pusher := control.Pusher{Endpoints: []control.Endpoint{{Name: "injector", URL: server.URL}}, HTTP: client, Key: key, Now: cfg.Now}
	if err = pusher.Push(ctx, original); err != nil {
		t.Fatal(err)
	}
	if err = vault.PutVersion(ctx, secret); err != nil {
		t.Fatal(err)
	}
	if err = vault.Bind(ctx, binding); err != nil {
		t.Fatal(err)
	}
	if _, err = vault.Credential(ctx, secret.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host); err != nil {
		t.Fatal(err)
	}
	_, otherKey, _ := ed25519.GenerateKey(rand.Reader)
	forged := pusher
	forged.Key = otherKey
	if err = forged.Remove(ctx, binding.Scope.ClaimID); err == nil {
		t.Fatal("foreign signing key revoked claim")
	}
	foreignCA, err := testpki.NewCA("synthetic-foreign-remover")
	if err != nil {
		t.Fatal(err)
	}
	foreignCert, err := foreignCA.Issue("cell-a", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	foreignClient := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{Certificates: []tls.Certificate{foreignCert}, RootCAs: ca.Pool(), MinVersion: tls.VersionTLS13}}, Timeout: time.Second}
	defer foreignClient.CloseIdleConnections()
	forged = pusher
	forged.HTTP = foreignClient
	if err = forged.Remove(ctx, binding.Scope.ClaimID); err == nil {
		t.Fatal("foreign TLS peer revoked claim")
	}
	if _, err = vault.Credential(ctx, secret.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host); err != nil {
		t.Fatal("unauthorized removal changed credential grant")
	}
	for i := 0; i < 2; i++ {
		if err = pusher.Remove(ctx, binding.Scope.ClaimID); err != nil {
			t.Fatal(err)
		}
	}
	if err = vault.Close(); err != nil {
		t.Fatal(err)
	}
	recoveredStore := policy.NewStore(cfg.Now)
	cfg.Claims = PolicyClaimAuthorizer{Policies: recoveredStore, Now: cfg.Now}
	recovered, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	installSignedPolicy(t, (&control.Server{Policies: recoveredStore, AgentKey: pub, Now: cfg.Now}).Handler(), key, original)
	if _, err = recovered.Credential(ctx, secret.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host); !errors.Is(err, ErrVaultDenied) {
		t.Fatal("replayed policy released the recovered revoked credential")
	}
	if err = recovered.Bind(ctx, binding); !errors.Is(err, ErrVaultDenied) {
		t.Fatal("terminal claim was rebound after restart")
	}
}

func TestBindingFencesReleaseAfterCancellationAndClose(t *testing.T) {
	for _, kind := range []string{"cancel", "close", "authority_error"} {
		t.Run(kind, func(t *testing.T) {
			cfg, _, binding := vaultFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			entered, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			unblock := func() { once.Do(func() { close(release) }) }
			defer unblock()
			cfg.Claims = vaultAuthorityFunc(func(ctx context.Context, b Binding) (ClaimAuthority, error) {
				close(entered)
				select {
				case <-release:
				case <-ctx.Done():
					return ClaimAuthority{}, ctx.Err()
				}
				if kind == "authority_error" {
					return ClaimAuthority{}, ErrVaultDenied
				}
				return (allowVaultClaim{}).AuthorizeBinding(ctx, b)
			})
			managed, err := OpenConfiguredVault(cfg)
			if err != nil {
				t.Fatal(err)
			}
			v := managed.(*EncryptedVault)
			defer v.Close()
			done := make(chan error, 1)
			go func() { done <- v.Bind(ctx, binding) }()
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal("authority did not start")
			}
			if kind == "close" {
				if err = v.Close(); err != nil {
					t.Fatal(err)
				}
			} else if kind == "cancel" {
				cancel()
			}
			unblock()
			select {
			case err = <-done:
				if err == nil {
					t.Fatal("cancelled/closed/refused binding succeeded")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("binding did not finish")
			}
			if v.activeBinds != 0 || len(v.binds) != 0 {
				t.Fatal("binding registration survived completion")
			}
		})
	}
}

func TestBindingAuthorityConcurrencyIsBoundedAndRegistrationsAreReclaimed(t *testing.T) {
	cfg, _, binding := vaultFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan struct{}, maxVaultClaims)
	cfg.Claims = vaultAuthorityFunc(func(ctx context.Context, _ Binding) (ClaimAuthority, error) {
		entered <- struct{}{}
		<-ctx.Done()
		return ClaimAuthority{}, ctx.Err()
	})
	managed, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	v := managed.(*EncryptedVault)
	defer v.Close()
	done := make(chan error, maxVaultClaims)
	for i := 0; i < maxVaultClaims; i++ {
		b := binding
		b.Scope.ClaimID = fmt.Sprintf("claim-%d", i)
		go func() { done <- v.Bind(ctx, b) }()
	}
	for i := 0; i < maxVaultClaims; i++ {
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			t.Fatal("bounded authority calls did not start")
		}
	}
	if err = v.Bind(ctx, binding); !errors.Is(err, ErrVaultCapacity) {
		t.Fatal("unbounded authority registration accepted")
	}
	if err = v.RevokeKnownClaim(ctx, "unknown-claim"); err != nil {
		t.Fatal(err)
	}
	cancel()
	for i := 0; i < maxVaultClaims; i++ {
		select {
		case err = <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatal("cancelled binding had unexpected result")
			}
		case <-time.After(3 * time.Second):
			t.Fatal("binding registration cleanup stalled")
		}
	}
	if v.activeBinds != 0 || len(v.binds) != 0 {
		t.Fatal("completed authority calls retained registrations")
	}
}

func TestKnownClaimUncertainRevocationRemainsDeniedAfterRestartAndRetry(t *testing.T) {
	cfg, secret, binding := vaultFixture(t)
	managed, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	v := managed.(*EncryptedVault)
	defer v.Close()
	ctx := context.Background()
	if err = v.PutVersion(ctx, secret); err != nil {
		t.Fatal(err)
	}
	if err = v.Bind(ctx, binding); err != nil {
		t.Fatal(err)
	}
	v.syncDir = func() error { return errors.New("synthetic private sync failure") }
	if err = v.RevokeKnownClaim(ctx, binding.Scope.ClaimID); !errors.Is(err, ErrVaultUnavailable) {
		t.Fatal("uncertain removal reported success")
	}
	if _, err = v.Credential(ctx, secret.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host); !errors.Is(err, ErrVaultUnavailable) {
		t.Fatal("uncertain vault continued serving credentials")
	}
	if err = v.Close(); err != nil {
		t.Fatal(err)
	}
	recovered, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	if err = recovered.RevokeKnownClaim(ctx, binding.Scope.ClaimID); err != nil {
		t.Fatal("retry of committed removal failed")
	}
	if _, err = recovered.Credential(ctx, secret.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host); !errors.Is(err, ErrVaultDenied) {
		t.Fatal("committed removal was lost after restart")
	}
}

func TestKnownClaimRemovalValidatesIdentityAndContextWithoutCreatingGrant(t *testing.T) {
	cfg, secret, binding := vaultFixture(t)
	vault, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer vault.Close()
	ctx := context.Background()
	for _, id := range []string{"", "../claim-a", "claim/a", "claim\nprivate"} {
		if err = vault.RevokeKnownClaim(ctx, id); !errors.Is(err, ErrVaultDenied) {
			t.Fatal("invalid identity accepted")
		}
	}
	if err = vault.RevokeKnownClaim(ctx, "unknown-claim"); err != nil {
		t.Fatal(err)
	}
	if err = vault.PutVersion(ctx, secret); err != nil {
		t.Fatal(err)
	}
	if err = vault.Bind(ctx, binding); err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err = vault.RevokeKnownClaim(cancelled, binding.Scope.ClaimID); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled removal succeeded")
	}
	if _, err = vault.Credential(ctx, secret.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host); err != nil {
		t.Fatal("cancelled removal mutated grant")
	}
}

// A delete of an unknown claim could race an already authorized Bind, which
// then persisted its first grant after a successful removal acknowledgment.
func TestSignedRemovalFencesInFlightUnknownBindingWithoutAffectingAnotherClaim(t *testing.T) {
	cfg, secret, binding := vaultFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	store := policy.NewStore(cfg.Now)
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	entered, otherEntered, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	authorizer := PolicyClaimAuthorizer{Policies: store, Now: cfg.Now}
	cfg.Claims = vaultAuthorityFunc(func(ctx context.Context, b Binding) (ClaimAuthority, error) {
		a, err := authorizer.AuthorizeBinding(ctx, b)
		if err == nil {
			if b.Scope.ClaimID == binding.Scope.ClaimID {
				close(entered)
			} else {
				close(otherEntered)
			}
			select {
			case <-release:
			case <-ctx.Done():
				return ClaimAuthority{}, ctx.Err()
			}
		}
		return a, err
	})
	vault, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer vault.Close()
	handler := (&control.Server{Policies: store, AgentKey: pub, Now: cfg.Now, DurableDelete: vault.RevokeKnownClaim}).Handler()
	policyA := signedPolicyForBinding(binding, cfg.Now())
	installSignedPolicy(t, handler, key, policyA)
	if err = vault.PutVersion(ctx, secret); err != nil {
		t.Fatal(err)
	}
	other := binding
	other.Scope = ClaimScope{SecretScope: SecretScope{OrganizationID: "org-b", EnvironmentID: "env-b"}, ClaimID: "claim-b"}
	otherSecret := secret
	otherSecret.Scope = other.Scope.SecretScope
	if err = vault.PutVersion(ctx, otherSecret); err != nil {
		t.Fatal(err)
	}
	policyB := signedPolicyForBinding(other, cfg.Now())
	policyB.Sources = []string{"127.0.0.2"}
	installSignedPolicy(t, handler, key, policyB)
	finished := make(chan error, 1)
	otherFinished := make(chan error, 1)
	go func() { finished <- vault.Bind(ctx, binding) }()
	go func() { otherFinished <- vault.Bind(ctx, other) }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("binding did not reach authority")
	}
	select {
	case <-otherEntered:
	case <-ctx.Done():
		t.Fatal("unrelated binding did not reach authority")
	}
	sig, at := control.SignRemoval(key, binding.Scope.ClaimID, cfg.Now())
	req := httptest.NewRequest(http.MethodDelete, "/v1/policy/"+binding.Scope.ClaimID, nil)
	req.Header.Set(control.SignatureHeader, sig)
	req.Header.Set(control.SignedAtHeader, at)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("unknown claim delete: %d", rr.Code)
	}
	unblock()
	select {
	case err = <-finished:
		if !errors.Is(err, ErrVaultDenied) {
			t.Fatal("removed unknown claim persisted its in-flight binding")
		}
	case <-ctx.Done():
		t.Fatal("binding did not finish")
	}
	select {
	case err = <-otherFinished:
		if err != nil {
			t.Fatal("unrelated in-flight binding was invalidated")
		}
	case <-ctx.Done():
		t.Fatal("unrelated binding did not finish")
	}
	if v := vault.(*EncryptedVault); v.activeBinds != 0 || len(v.binds) != 0 {
		t.Fatal("in-flight registrations leaked")
	}
	if err = vault.Close(); err != nil {
		t.Fatal(err)
	}
	fresh := policy.NewStore(cfg.Now)
	cfg.Claims = PolicyClaimAuthorizer{Policies: fresh, Now: cfg.Now}
	recovered, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	installSignedPolicy(t, (&control.Server{Policies: fresh, AgentKey: pub, Now: cfg.Now}).Handler(), key, policyA)
	installSignedPolicy(t, (&control.Server{Policies: fresh, AgentKey: pub, Now: cfg.Now}).Handler(), key, policyB)
	if _, err = recovered.Credential(ctx, secret.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host); !errors.Is(err, ErrVaultDenied) {
		t.Fatal("post-delete binding recovered after policy replay")
	}
	if _, err = recovered.Credential(ctx, other.Scope.OrganizationID, other.Scope.ClaimID, other.Host); err != nil {
		t.Fatal("unrelated claim lost recovered grant")
	}
}
