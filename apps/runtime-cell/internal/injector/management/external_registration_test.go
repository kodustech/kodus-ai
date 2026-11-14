package management

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
)

const externalMetadata = `{"organizationId":"org-a","environmentId":"env-a","id":"payments","version":3,"expiresAt":"2030-01-01T01:00:00Z"}`

type externalReader func(context.Context, injector.SecretVersionRef) (injector.SecretVersion, error)

func (f externalReader) ReadVersion(ctx context.Context, ref injector.SecretVersionRef) (injector.SecretVersion, error) {
	return f(ctx, ref)
}

func externalVault(t *testing.T, read injector.SecretVersionReader) (injector.ManagedVault, injector.VaultConfig) {
	t.Helper()
	base := privateDir(t)
	dir := filepath.Join(base, "vault")
	key := filepath.Join(base, "owner.key")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(key, bytes.Repeat([]byte{9}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	cfg := injector.VaultConfig{Directory: dir, KeyFile: key, CellID: "cell-a", Now: func() time.Time { return now }, Claims: claimAuthority{hardExpiry: now.Add(2 * time.Hour)}, ExternalValues: read, ExternalSourceID: "owner-profile-a"}
	v, err := injector.OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal("external ledger did not open")
	}
	t.Cleanup(func() { _ = v.Close() })
	return v, cfg
}

func managementRequest(ctx context.Context, v VaultAdmin, operation, body string) *httptest.ResponseRecorder {
	h := &handler{vault: v, slots: make(chan struct{}, 4)}
	r := httptest.NewRequest(http.MethodPost, "/v1/vault/"+operation, strings.NewReader(body)).WithContext(ctx)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// External ledger registration existed only as a Go method; the owner-local
// management transport could not register a pinned metadata-only version.
func TestExternalRegistrationLifecycleWithoutValueReadOrImplicitGrant(t *testing.T) {
	ctx := context.Background()
	reads := 0
	scope := injector.SecretScope{OrganizationID: "org-a", EnvironmentID: "env-a"}
	reader := externalReader(func(_ context.Context, ref injector.SecretVersionRef) (injector.SecretVersion, error) {
		reads++
		if ref.Scope != scope || ref.ID != "payments" || ref.Version != 3 {
			t.Error("external read was not pinned to registered metadata")
		}
		return injector.SecretVersion{Scope: scope, ID: "payments", Version: 3, Value: "synthetic-external-admin-value", ExpiresAt: time.Date(2030, 1, 1, 2, 0, 0, 0, time.UTC)}, nil
	})
	v, cfg := externalVault(t, reader)
	register := func(v injector.ManagedVault, body string, want int) {
		t.Helper()
		w := managementRequest(ctx, v, "register-external", body)
		if w.Code != want || strings.Contains(w.Body.String(), "synthetic") {
			t.Fatalf("external registration status=%d want=%d", w.Code, want)
		}
		if want == http.StatusNoContent && w.Body.Len() != 0 {
			t.Fatal("registration returned a body")
		}
	}
	register(v, externalMetadata, http.StatusNoContent)
	register(v, externalMetadata, http.StatusNoContent)
	register(v, strings.Replace(externalMetadata, "01:00:00Z", "01:30:00Z", 1), http.StatusConflict)
	if reads != 0 {
		t.Fatal("registration read the value backend")
	}
	if _, err := v.Credential(ctx, "org-a", "claim-a", "api.example.test"); !errors.Is(err, injector.ErrVaultDenied) || reads != 0 {
		t.Fatal("registration implicitly authorized a claim or read a value")
	}
	w := managementRequest(ctx, v, "list", `{"organizationId":"org-a","environmentId":"env-a"}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"version":3`) || strings.Contains(w.Body.String(), `"value"`) || strings.Contains(w.Body.String(), "owner-profile") {
		t.Fatal("list did not preserve bounded metadata-only response")
	}
	bind := `{"organizationId":"org-a","environmentId":"env-a","claimId":"claim-a","secretId":"payments","version":3,"host":"api.example.test","header":"Authorization","expiresAt":"2030-01-01T00:30:00Z"}`
	if w = managementRequest(ctx, v, "bind", bind); w.Code != http.StatusNoContent || reads != 0 {
		t.Fatal("explicit binding failed or read an external value")
	}
	cred, err := v.Credential(ctx, "org-a", "claim-a", "api.example.test")
	if err != nil || cred.Value != "synthetic-external-admin-value" || reads != 1 {
		t.Fatal("explicitly authorized lookup failed")
	}
	if err = v.Close(); err != nil {
		t.Fatal("ledger close failed")
	}
	v, err = injector.OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal("metadata ledger did not recover")
	}
	defer v.Close()
	cred, err = v.Credential(ctx, "org-a", "claim-a", "api.example.test")
	if err != nil || cred.Value != "synthetic-external-admin-value" || reads != 2 {
		t.Fatal("recovered binding did not read its pinned external version")
	}
	w = managementRequest(ctx, v, "revoke-version", `{"organizationId":"org-a","environmentId":"env-a","id":"payments","version":3}`)
	if w.Code != http.StatusNoContent {
		t.Fatal("external version revocation failed")
	}
	register(v, externalMetadata, http.StatusConflict)
	if _, err = v.Credential(ctx, "org-a", "claim-a", "api.example.test"); !errors.Is(err, injector.ErrVaultDenied) || reads != 2 {
		t.Fatal("revoked external version read the value backend")
	}
	if err = v.Close(); err != nil {
		t.Fatal("ledger close failed")
	}
	cfg.ExternalSourceID = "owner-profile-b"
	if switched, err := injector.OpenConfiguredVault(cfg); err == nil {
		_ = switched.Close()
		t.Fatal("owner source identity changed on recovery")
	}
}

func TestExternalRegistrationRejectsUntrustedConfigurationAndAmbiguousInput(t *testing.T) {
	v, _ := externalVault(t, externalReader(func(context.Context, injector.SecretVersionRef) (injector.SecretVersion, error) {
		t.Fatal("metadata administration read the value backend")
		return injector.SecretVersion{}, nil
	}))
	for name, body := range map[string]string{
		"value":       strings.Replace(externalMetadata, `"version":3`, `"version":3,"value":"synthetic-private-input"`, 1),
		"endpoint":    strings.Replace(externalMetadata, `"version":3`, `"version":3,"endpoint":"https://synthetic-private-input"`, 1),
		"source":      strings.Replace(externalMetadata, `"version":3`, `"version":3,"sourceId":"synthetic-private-input"`, 1),
		"token":       strings.Replace(externalMetadata, `"version":3`, `"version":3,"token":"synthetic-private-input"`, 1),
		"mode":        strings.Replace(externalMetadata, `"version":3`, `"version":3,"mode":"local"`, 1),
		"missing":     strings.Replace(externalMetadata, `"version":3,`, "", 1),
		"duplicate":   strings.Replace(externalMetadata, `"version":3`, `"version":3,"version":4`, 1),
		"case":        strings.Replace(externalMetadata, `"version":3`, `"Version":3`, 1),
		"nested":      strings.Replace(externalMetadata, `"version":3`, `"version":{"value":"synthetic-private-input"}`, 1),
		"fractional":  strings.Replace(externalMetadata, `"version":3`, `"version":3.0`, 1),
		"exponent":    strings.Replace(externalMetadata, `"version":3`, `"version":3e0`, 1),
		"zero":        strings.Replace(externalMetadata, `"version":3`, `"version":0`, 1),
		"unsafe int":  strings.Replace(externalMetadata, `"version":3`, `"version":9007199254740993`, 1),
		"bad expiry":  strings.Replace(externalMetadata, "2030-01-01T01:00:00Z", "synthetic-private-input", 1),
		"trailing":    externalMetadata + "{}",
		"null":        "null",
		"empty input": "",
	} {
		t.Run(name, func(t *testing.T) {
			w := managementRequest(context.Background(), v, "register-external", body)
			if w.Code != http.StatusBadRequest || strings.Contains(w.Body.String(), "synthetic") {
				t.Fatalf("unsafe registration input accepted or echoed: status=%d", w.Code)
			}
		})
	}
	w := managementRequest(context.Background(), v, "register-external", strings.Repeat("x", MaxBodyBytes+1))
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize registration status=%d", w.Code)
	}
	for _, body := range []string{
		strings.Replace(externalMetadata, `"id":"payments"`, `"id":"../synthetic-private-input"`, 1),
		strings.Replace(externalMetadata, "2030-01-01T01:00:00Z", "2029-01-01T00:00:00Z", 1),
	} {
		w = managementRequest(context.Background(), v, "register-external", body)
		if w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), "synthetic") {
			t.Fatal("invalid metadata was registered")
		}
	}
}

func TestExternalRegistrationModeRefusal(t *testing.T) {
	ctx := context.Background()
	local := newVault(t, privateDir(t))
	if w := managementRequest(ctx, local, "register-external", externalMetadata); w.Code != http.StatusForbidden {
		t.Fatal("local value mode accepted external metadata")
	}
	if w := managementRequest(ctx, injector.RefusingVault{}, "register-external", externalMetadata); w.Code != http.StatusServiceUnavailable {
		t.Fatal("unconfigured vault accepted external metadata")
	}
	v, _ := externalVault(t, externalReader(func(context.Context, injector.SecretVersionRef) (injector.SecretVersion, error) {
		t.Fatal("metadata administration read a value")
		return injector.SecretVersion{}, nil
	}))
	put := strings.Replace(externalMetadata, `"version":3`, `"version":3,"value":"synthetic-local-value"`, 1)
	if w := managementRequest(ctx, v, "put", put); w.Code != http.StatusForbidden {
		t.Fatal("external mode accepted a local value")
	}
}

func TestExternalRegistrationUnixClientAndPeerRefusal(t *testing.T) {
	ctx := context.Background()
	v, _ := externalVault(t, externalReader(func(context.Context, injector.SecretVersionRef) (injector.SecretVersion, error) {
		t.Fatal("metadata administration read a value")
		return injector.SecretVersion{}, nil
	}))
	base := privateDir(t)
	socket, _, _ := startServer(t, v, base)
	_, err := call(ctx, socket, "register-external", []byte(externalMetadata), func(c *net.UnixConn) error { return samePeer(c, uint32(os.Geteuid()+1)) })
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != "denied" {
		t.Fatal("external registration bypassed peer identity refusal")
	}
	rows, err := v.ListVersions(ctx, injector.SecretScope{OrganizationID: "org-a", EnvironmentID: "env-a"})
	if err != nil || len(rows) != 0 {
		t.Fatal("refused external registration changed the ledger")
	}
	if output, err := Call(ctx, socket, "register-external", []byte(externalMetadata)); err != nil || len(output) != 0 {
		t.Fatal("owner Unix client could not register external metadata")
	}
	rows, err = v.ListVersions(ctx, injector.SecretScope{OrganizationID: "org-a", EnvironmentID: "env-a"})
	if err != nil || len(rows) != 1 || rows[0].ID != "payments" || rows[0].Version != 3 {
		t.Fatal("owner Unix registration did not persist exact metadata")
	}
}

type cancellingRegistrationVault struct {
	injector.RefusingVault
	started chan struct{}
}

func (v cancellingRegistrationVault) RegisterExternalVersion(ctx context.Context, _ injector.ExternalSecretVersion) error {
	close(v.started)
	<-ctx.Done()
	return ctx.Err()
}

func TestExternalRegistrationActiveCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	v := cancellingRegistrationVault{started: make(chan struct{})}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- managementRequest(ctx, v, "register-external", externalMetadata) }()
	select {
	case <-v.started:
	case w := <-done:
		t.Fatalf("external registration never reached cancellable operation: %d", w.Code)
	case <-time.After(time.Second):
		t.Fatal("registration did not start")
	}
	cancel()
	select {
	case w := <-done:
		if w.Code != http.StatusRequestTimeout || w.Body.String() != "{\"code\":\"cancelled\"}\n" {
			t.Fatal("cancelled external registration did not refuse with a fixed response")
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled registration did not stop")
	}
}
