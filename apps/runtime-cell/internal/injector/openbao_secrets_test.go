package injector

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func secretsServer(t *testing.T, h http.HandlerFunc) (string, *x509.CertPool) {
	t.Helper()
	s := httptest.NewUnstartedServer(h)
	s.Config.ErrorLog = log.New(io.Discard, "", 0)
	s.StartTLS()
	t.Cleanup(s.Close)
	roots := x509.NewCertPool()
	roots.AddCert(s.Certificate())
	return s.URL, roots
}

func kvRecord(payload map[string]any) map[string]any {
	return map[string]any{"data": map[string]any{
		"data":     payload,
		"metadata": map[string]any{"version": 2, "destroyed": false, "deletion_time": ""},
	}}
}

func newSecrets(t *testing.T, address string, roots *x509.CertPool) *OpenBaoSecrets {
	t.Helper()
	s, err := NewOpenBaoSecrets(OpenBaoSecretsConfig{Address: address, Mount: "runtime-kv", Roots: roots, Token: func(context.Context) (string, error) { return "synthetic-read-token", nil }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.CloseIdleConnections)
	return s
}

func TestStoreReadsTheOrgSecretAndItsHosts(t *testing.T) {
	address, roots := secretsServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/runtime-kv/data/orgs/org-a/secrets/npm" || r.Header.Get("X-Vault-Token") != "synthetic-read-token" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(kvRecord(map[string]any{"value": npmValue, "hosts": []string{npmHost}, "organizationId": "org-a", "secretId": "npm"}))
	})
	got, err := newSecrets(t, address, roots).Secret(context.Background(), "org-a", "npm")
	if err != nil || got.Value != npmValue || len(got.Hosts) != 1 || got.Hosts[0] != npmHost {
		t.Fatalf("read failed: %v", err)
	}
}

func TestStoreRefusesARecordThatIsNotThisOrgsSecret(t *testing.T) {
	for name, payload := range map[string]map[string]any{
		"another org":     {"value": npmValue, "hosts": []string{npmHost}, "organizationId": "org-b", "secretId": "npm"},
		"another secret":  {"value": npmValue, "hosts": []string{npmHost}, "organizationId": "org-a", "secretId": "other"},
		"no host":         {"value": npmValue, "hosts": []string{}, "organizationId": "org-a", "secretId": "npm"},
		"header breaking": {"value": "a\r\nX-Injected: 1", "hosts": []string{npmHost}, "organizationId": "org-a", "secretId": "npm"},
		"an extra field":  {"value": npmValue, "hosts": []string{npmHost}, "organizationId": "org-a", "secretId": "npm", "header": "Authorization"},
	} {
		address, roots := secretsServer(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(kvRecord(payload))
		})
		if got, err := newSecrets(t, address, roots).Secret(context.Background(), "org-a", "npm"); !errors.Is(err, ErrVaultDenied) || got.Value != "" {
			t.Errorf("%s: released", name)
		}
	}
}

func TestStoreDeniesASecretItDoesNotHave(t *testing.T) {
	address, roots := secretsServer(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) })
	if _, err := newSecrets(t, address, roots).Secret(context.Background(), "org-a", "npm"); !errors.Is(err, ErrVaultDenied) {
		t.Fatalf("missing secret: %v", err)
	}
}

func writeCredential(t *testing.T, dir, name, value string, mode os.FileMode) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(value+"\n"), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestAppRoleLoginIsReusedUntilTwoThirdsOfItsLease(t *testing.T) {
	var logins atomic.Int32
	address, roots := secretsServer(t, func(w http.ResponseWriter, r *http.Request) {
		var in map[string]string
		_ = json.NewDecoder(r.Body).Decode(&in)
		if r.URL.Path != "/v1/auth/approle/login" || in["role_id"] != "role-synthetic" || in["secret_id"] != "secret-synthetic" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		logins.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"auth": map[string]any{"client_token": "synthetic-token", "lease_duration": 300}})
	})
	dir := t.TempDir()
	now := time.Now()
	a := &AppRoleToken{Address: address, Roots: roots, RoleIDFile: writeCredential(t, dir, "role", "role-synthetic", 0o600), SecretIDFile: writeCredential(t, dir, "secret", "secret-synthetic", 0o600), Now: func() time.Time { return now }}
	for range 3 {
		if tok, err := a.Token(context.Background()); err != nil || tok != "synthetic-token" {
			t.Fatalf("login: %v", err)
		}
	}
	now = now.Add(201 * time.Second)
	if _, err := a.Token(context.Background()); err != nil {
		t.Fatal(err)
	}
	if logins.Load() != 2 {
		t.Fatalf("%d logins, want 2", logins.Load())
	}
}

func TestAppRoleRefusesACredentialFileOthersCanRead(t *testing.T) {
	address, roots := secretsServer(t, func(w http.ResponseWriter, _ *http.Request) { t.Error("logged in with a world-readable credential") })
	dir := t.TempDir()
	a := &AppRoleToken{Address: address, Roots: roots, RoleIDFile: writeCredential(t, dir, "role", "role-synthetic", 0o644), SecretIDFile: writeCredential(t, dir, "secret", "secret-synthetic", 0o600)}
	if _, err := a.Token(context.Background()); !errors.Is(err, ErrVaultConfig) {
		t.Fatalf("got %v", err)
	}
}

// cell_openbao_up says whether OpenBao answers unsealed: an active (200) or
// standby (429) node is up; sealed (503), uninitialized (501) or no answer is down.
func TestOpenBaoUpIsWhetherItsHealthAnswersUnsealed(t *testing.T) {
	for status, want := range map[int]bool{200: true, 429: true, 503: false, 501: false, 500: false} {
		address, roots := secretsServer(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v1/sys/health" || r.Header.Get("X-Vault-Token") != "" {
				w.WriteHeader(http.StatusTeapot)
				return
			}
			w.WriteHeader(status)
		})
		if got := newSecrets(t, address, roots).Healthy(context.Background()); got != want {
			t.Errorf("status %d: up %v, want %v", status, got, want)
		}
	}
	s := newSecrets(t, "https://127.0.0.1:1", nil)
	if s.Healthy(context.Background()) {
		t.Error("an unreachable OpenBao is up")
	}
}
