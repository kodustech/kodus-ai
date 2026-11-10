package management

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
)

type claimAuthority struct{ hardExpiry time.Time }

func (a claimAuthority) AuthorizeBinding(_ context.Context, b injector.Binding) (injector.ClaimAuthority, error) {
	if b.Scope.OrganizationID != "org-a" || b.Scope.EnvironmentID != "env-a" || b.Scope.ClaimID != "claim-a" {
		return injector.ClaimAuthority{}, injector.ErrVaultDenied
	}
	return injector.ClaimAuthority{Scope: b.Scope, ExpiresAt: a.hardExpiry, CredentialHosts: []string{"api.example.test"}}, nil
}
func privateDir(t *testing.T) string {
	t.Helper()
	p, e := os.MkdirTemp("/private/tmp", "kv-mgmt-")
	if os.IsNotExist(e) {
		p, e = os.MkdirTemp("/tmp", "kv-mgmt-")
	}
	if e != nil {
		t.Fatal(e)
	}
	p, e = filepath.EvalSymlinks(p)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = os.RemoveAll(p) })
	return p
}
func newVault(t *testing.T, base string) injector.ManagedVault {
	t.Helper()
	dir := filepath.Join(base, "vault")
	if e := os.Mkdir(dir, 0700); e != nil {
		t.Fatal(e)
	}
	key := filepath.Join(base, "owner.key")
	if e := os.WriteFile(key, bytes.Repeat([]byte{7}, 32), 0600); e != nil {
		t.Fatal(e)
	}
	v, e := injector.OpenConfiguredVault(injector.VaultConfig{Directory: dir, KeyFile: key, CellID: "cell-a", Claims: claimAuthority{hardExpiry: time.Now().Add(time.Hour)}})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = v.Close() })
	return v
}
func startServer(t *testing.T, v injector.ManagedVault, base string) (string, context.CancelFunc, <-chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	socket := filepath.Join(base, "admin.sock")
	ready := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- serve(ctx, socket, v, slog.New(slog.NewTextHandler(io.Discard, nil)), ready) }()
	select {
	case <-ready:
	case e := <-done:
		t.Fatalf("serve startup: %v", e)
	case <-time.After(3 * time.Second):
		t.Fatal("serve startup timed out")
	}
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("server did not stop")
		}
	})
	return socket, cancel, done
}
func rawCall(t *testing.T, socket, path, body string) (int, string, http.Header) {
	t.Helper()
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 3 * time.Second}
	r, e := client.Post("http://unix"+path, "application/json", strings.NewReader(body))
	if e != nil {
		t.Fatal(e)
	}
	defer r.Body.Close()
	b, e := io.ReadAll(io.LimitReader(r.Body, MaxResponseBytes+1))
	if e != nil {
		t.Fatal(e)
	}
	return r.StatusCode, string(b), r.Header
}
func TestUnixManagementEncryptedVaultLifecycle(t *testing.T) {
	base := privateDir(t)
	v := newVault(t, base)
	socket, _, _ := startServer(t, v, base)
	ctx := context.Background()
	expires := time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339Nano)
	put := `{"organizationId":"org-a","environmentId":"env-a","id":"payments","version":1,"value":"synthetic-write-only-credential","expiresAt":"` + expires + `"}`
	if b, e := Call(ctx, socket, "put", []byte(put)); e != nil || len(b) != 0 {
		t.Fatalf("put: %s %v", b, e)
	}
	list := []byte(`{"organizationId":"org-a","environmentId":"env-a"}`)
	b, e := Call(ctx, socket, "list", list)
	if e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(b, []byte("synthetic-write-only")) || bytes.Contains(b, []byte(`"value"`)) {
		t.Fatal("secret returned")
	}
	var info struct {
		Versions []VersionInfo `json:"versions"`
	}
	if e = json.Unmarshal(b, &info); e != nil || len(info.Versions) != 1 || info.Versions[0].ID != "payments" {
		t.Fatalf("list metadata: %s %v", b, e)
	}
	bind := `{"organizationId":"org-a","environmentId":"env-a","claimId":"claim-a","secretId":"payments","version":1,"host":"api.example.test","header":"Authorization","expiresAt":"` + expires + `"}`
	if _, e = Call(ctx, socket, "bind", []byte(bind)); e != nil {
		t.Fatal(e)
	}
	cred, e := v.Credential(ctx, "org-a", "claim-a", "api.example.test")
	if e != nil || cred.Value != "synthetic-write-only-credential" {
		t.Fatalf("scoped credential: %v", e)
	}
	if _, e = Call(ctx, socket, "revoke-claim", []byte(`{"organizationId":"org-a","environmentId":"env-a","claimId":"claim-a"}`)); e != nil {
		t.Fatal(e)
	}
	if _, e = v.Credential(ctx, "org-a", "claim-a", "api.example.test"); !errors.Is(e, injector.ErrVaultDenied) {
		t.Fatal("revoked claim remained usable")
	}
	if _, e = Call(ctx, socket, "revoke-version", []byte(`{"organizationId":"org-a","environmentId":"env-a","id":"payments","version":1}`)); e != nil {
		t.Fatal(e)
	}
	if _, e = Call(ctx, socket, "bind", []byte(strings.Replace(bind, `"org-a"`, `"org-b"`, 1))); e == nil {
		t.Fatal("binding across organizations accepted")
	}
	if e = v.Close(); e != nil {
		t.Fatal(e)
	}
	reopened, e := injector.OpenConfiguredVault(injector.VaultConfig{Directory: filepath.Join(base, "vault"), KeyFile: filepath.Join(base, "owner.key"), CellID: "cell-a", Claims: claimAuthority{hardExpiry: time.Now().Add(time.Hour)}})
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.Close()
	versions, e := reopened.ListVersions(ctx, injector.SecretScope{OrganizationID: "org-a", EnvironmentID: "env-a"})
	if e != nil || len(versions) != 1 || !versions[0].Revoked {
		t.Fatal("revocation metadata did not survive reopen")
	}
	data, e := os.ReadFile(filepath.Join(base, "vault", "vault.json"))
	if e != nil || bytes.Contains(data, []byte("synthetic-write-only")) {
		t.Fatal("ciphertext persistence failed")
	}
}
func TestManagementRejectsAmbiguousJSONAndNeverEchoes(t *testing.T) {
	base := privateDir(t)
	socket, _, _ := startServer(t, newVault(t, base), base)
	bodies := []string{`null`, `[]`, `{}`, `{"organizationId":"org-a","environmentId":"env-a"} {}`, `{"organizationId":"org-a","organizationId":"org-b","environmentId":"env-a"}`, `{"OrganizationId":"org-a","environmentId":"env-a"}`, `{"organizationId":"org-a","environmentId":null}`, `{"organizationId":"org-a","environmentId":{"secret":"synthetic-malformed-private"}}`, `{"organizationId":"org-a","environmentId":"env-a","value":"synthetic-malformed-private"}`, `{"organizationId":"org-a","environmentId":"env-a","baits":[]}`}
	for _, body := range bodies {
		status, text, h := rawCall(t, socket, "/v1/vault/list", body)
		if status != 400 || strings.Contains(text, "synthetic") || h.Get("Cache-Control") != "no-store" {
			t.Fatalf("unsafe malformed response: status=%d", status)
		}
	}
	status, text, _ := rawCall(t, socket, "/v1/vault/put", strings.Repeat("x", MaxBodyBytes+1))
	if status != 413 || strings.Contains(text, "xxxx") {
		t.Fatalf("oversize: %d", status)
	}
	status, _, _ = rawCall(t, socket, "/v1/vault/credential", `{}`)
	if status != 404 {
		t.Fatalf("credential endpoint exposed: %d", status)
	}
}
func TestPrivateSocketRefusesExistingAndWrongPermissions(t *testing.T) {
	base := privateDir(t)
	v := newVault(t, base)
	socket := filepath.Join(base, "admin.sock")
	if e := os.WriteFile(socket, []byte("foreign"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := Serve(context.Background(), socket, v, nil); e == nil {
		t.Fatal("existing path accepted")
	}
	b, _ := os.ReadFile(socket)
	if string(b) != "foreign" {
		t.Fatal("existing file modified")
	}
	_ = os.Remove(socket)
	target := filepath.Join(base, "target")
	_ = os.WriteFile(target, []byte("foreign"), 0600)
	if e := os.Symlink(target, socket); e != nil {
		t.Fatal(e)
	}
	if e := Serve(context.Background(), socket, v, nil); e == nil {
		t.Fatal("symlink accepted")
	}
	_ = os.Remove(socket)
	if e := os.Chmod(base, 0755); e != nil {
		t.Fatal(e)
	}
	if e := Serve(context.Background(), socket, v, nil); e == nil {
		t.Fatal("non-private parent accepted")
	}
	_ = os.Chmod(base, 0700)
	socket, _, _ = startServer(t, v, base)
	_ = os.Chmod(socket, 0666)
	if _, e := Call(context.Background(), socket, "list", []byte(`{"organizationId":"org-a","environmentId":"env-a"}`)); e == nil {
		t.Fatal("unsafe socket mode accepted")
	}
}
func TestCallRejectsCancelledContextWithoutSecretEcho(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := Call(ctx, "/private/tmp/not-owned.sock", "put", []byte(`{"value":"synthetic-cancel-secret"}`)); e == nil || strings.Contains(e.Error(), "synthetic") {
		t.Fatal("unsafe cancelled response")
	}
}
