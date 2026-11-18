//go:build dockersmoke

package injector

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testopenbao"
)

type baoContainer struct{ *testopenbao.Bao }

func startOpenBao(t *testing.T) *baoContainer { return &baoContainer{testopenbao.Start(t)} }

func (b *baoContainer) login(t *testing.T, role string) string { return b.Login(t, role) }

func (b *baoContainer) call(t *testing.T, token, method, path string, body any) (int, map[string]any) {
	return b.Call(t, token, method, path, body)
}

func (b *baoContainer) writeSecret(t *testing.T, token, org, id, value string, hosts []string) int {
	return b.WriteSecret(t, token, org, id, value, hosts)
}

func (b *baoContainer) injectorStore(t *testing.T) *OpenBaoSecrets {
	t.Helper()
	roleID, secretID := b.RoleFiles("injector")
	login := &AppRoleToken{Address: b.Address, Roots: b.Roots, RoleIDFile: roleID, SecretIDFile: secretID}
	store, err := NewOpenBaoSecrets(OpenBaoSecretsConfig{Address: b.Address, Mount: testopenbao.Mount, Roots: b.Roots, Token: login.Token})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.CloseIdleConnections)
	return store
}

func TestOpenBaoAsShippedHoldsOrgSecretsForTheInjector(t *testing.T) {
	b := startOpenBao(t)
	api, injectorToken := b.login(t, "api"), b.login(t, "injector")
	if status := b.writeSecret(t, api, "org-a", "npm", npmValue, []string{npmHost}); status != http.StatusOK {
		t.Fatalf("api write: %d", status)
	}
	if status := b.writeSecret(t, api, "org-a", "payments", apiValue, []string{apiHost}); status != http.StatusOK {
		t.Fatalf("api write: %d", status)
	}

	t.Run("the API's policy cannot read a value back", func(t *testing.T) {
		for _, path := range []string{"/v1/runtime-kv/data/orgs/org-a/secrets/npm", "/v1/runtime-kv/metadata/orgs/org-a/secrets/npm", "/v1/runtime-kv/data/orgs/org-a/secrets/npm?version=1"} {
			if status, out := b.call(t, api, http.MethodGet, path, nil); status != http.StatusForbidden || strings.Contains(stringify(out), npmValue) {
				t.Errorf("GET %s: %d", path, status)
			}
		}
		if status, _ := b.call(t, api, "LIST", "/v1/runtime-kv/metadata/orgs/org-a/secrets", nil); status != http.StatusForbidden {
			t.Errorf("LIST: %d", status)
		}
	})

	t.Run("the injector's policy cannot write", func(t *testing.T) {
		if status := b.writeSecret(t, injectorToken, "org-a", "npm", "overwritten", []string{"attacker.test"}); status != http.StatusForbidden {
			t.Errorf("write: %d", status)
		}
		if status, _ := b.call(t, injectorToken, http.MethodDelete, "/v1/runtime-kv/metadata/orgs/org-a/secrets/npm", nil); status != http.StatusForbidden {
			t.Errorf("delete: %d", status)
		}
		if got, err := b.injectorStore(t).Secret(context.Background(), "org-a", "npm"); err != nil || got.Value != npmValue {
			t.Errorf("the value changed or vanished: %v", err)
		}
	})

	t.Run("a placeholder reaches an allowed host as the real value", func(t *testing.T) {
		r := newSecretRig(t, b.injectorStore(t))
		if status, body := r.do(t, http.MethodGet, "https://"+npmHost+"/pkg", http.Header{"Authorization": {"Bearer " + r.npm.Placeholder}}); status != http.StatusOK || strings.Contains(body, npmValue) {
			t.Fatalf("status %d", status)
		}
		if got := r.upstreamSaw(t).Header.Get("Authorization"); got != "Bearer "+npmValue {
			t.Fatal("the upstream did not receive the stored value")
		}
	})

	t.Run("a placeholder to another host is not swapped and alerts", func(t *testing.T) {
		r := newSecretRig(t, b.injectorStore(t))
		if status, _ := r.do(t, http.MethodGet, "https://"+apiHost+"/charge", http.Header{"Authorization": {"Bearer " + r.npm.Placeholder}}); status != http.StatusForbidden {
			t.Fatalf("status %d", status)
		}
		select {
		case a := <-r.alerts:
			if a.Kind != AlertCredentialExfiltration || a.Host != apiHost {
				t.Fatalf("alert %+v", a)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no alert")
		}
		r.upstreamSawNothing(t)
	})

	t.Run("a deleted secret stops being injected", func(t *testing.T) {
		r := newSecretRig(t, b.injectorStore(t))
		header := http.Header{"Authorization": {"Bearer " + r.npm.Placeholder}}
		if status, _ := r.do(t, http.MethodGet, "https://"+npmHost+"/pkg", header); status != http.StatusOK {
			t.Fatalf("before the delete: %d", status)
		}
		r.upstreamSaw(t)
		if status, _ := b.call(t, api, http.MethodDelete, "/v1/runtime-kv/metadata/orgs/org-a/secrets/npm", nil); status != http.StatusNoContent {
			t.Fatalf("api delete: %d", status)
		}
		if status, _ := r.do(t, http.MethodGet, "https://"+npmHost+"/pkg", header); status != http.StatusForbidden {
			t.Fatalf("after the delete: %d", status)
		}
		r.upstreamSawNothing(t)
	})

	t.Run("a restart unseals itself from Postgres and keeps the secrets", func(t *testing.T) {
		b.Restart(t)
		if got, err := b.injectorStore(t).Secret(context.Background(), "org-a", "payments"); err != nil || got.Value != apiValue {
			t.Fatalf("after restart: %v", err)
		}
	})
}

func stringify(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}
