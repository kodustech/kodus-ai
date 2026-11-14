package injector

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

func auditUpstreamClient(t *testing.T, handler http.HandlerFunc) *http.Client {
	t.Helper()
	ca, err := testpki.NewCA("synthetic-upstream-audit")
	if err != nil {
		t.Fatal(err)
	}
	cert, err := ca.Issue(host, time.Hour, host)
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewUnstartedServer(handler)
	upstream.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	upstream.StartTLS()
	t.Cleanup(upstream.Close)
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: ca.Pool(), MinVersion: tls.VersionTLS12}, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", upstream.Listener.Addr().String())
	}}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: time.Second}
}

// Go's upstream response parser can include response bytes in its error.
// Reflected credential bytes must not cross into observability through err.
func TestUpstreamParserErrorDoesNotExposeCredentialInLogs(t *testing.T) {
	seen := make(chan bool, 1)
	upstream := auditUpstreamClient(t, func(w http.ResponseWriter, r *http.Request) {
		value := r.Header.Get("Authorization")
		seen <- value == secret
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error("synthetic upstream could not write test response")
			return
		}
		defer conn.Close()
		_, _ = buf.WriteString("HTTP/1.1 200 OK\r\nContent-Length: " + value + "\r\n\r\n")
		_ = buf.Flush()
	})
	vault := &MemoryVault{}
	vault.Put("org-a", "claim-a", host, Credential{Header: "Authorization", Value: secret, ExpiresAt: time.Now().Add(time.Hour)})
	var logs bytes.Buffer
	in := &Injector{Vault: vault, Log: slog.New(slog.NewJSONHandler(&logs, nil))}
	in.defaults()
	ctx := context.WithValue(context.Background(), ctxKey{}, connInfo{pol: policy.ClaimPolicy{OrgID: "org-a", ClaimID: "claim-a"}, host: host, upstream: upstream})
	req := httptest.NewRequest(http.MethodGet, "https://"+host+"/", nil).WithContext(ctx)
	response := httptest.NewRecorder()
	in.proxyWithCredential(response, req)
	select {
	case injected := <-seen:
		if !injected {
			t.Fatal("fixture did not reach the credentialed upstream")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("fixture did not reach the credentialed upstream before deadline")
	}
	if response.Code != http.StatusBadGateway {
		t.Fatal("invalid upstream response was not refused")
	}
	body, _ := io.ReadAll(response.Result().Body)
	for _, value := range []string{secret, strings.TrimPrefix(secret, "Bearer ")} {
		if strings.Contains(logs.String(), value) {
			t.Fatal("upstream parser error exposed credential in logs")
		}
		if bytes.Contains(body, []byte(value)) {
			t.Fatal("upstream parser error exposed credential to workload")
		}
	}
}

type auditVault func(context.Context, string, string, string) (Credential, error)

func (v auditVault) Credential(ctx context.Context, org, claim, host string) (Credential, error) {
	return v(ctx, org, claim, host)
}

// Header names are case-insensitive and are canonicalized by net/http. An
// upstream reflection in a name must not bypass value-only response masking.
func TestReflectedCredentialHeaderNameIsRefused(t *testing.T) {
	vault := &MemoryVault{}
	vault.Put("org-a", "claim-a", host, Credential{Header: "Authorization", Value: secret, ExpiresAt: time.Now().Add(time.Hour)})
	var logs bytes.Buffer
	in := &Injector{Vault: vault, Log: slog.New(slog.NewJSONHandler(&logs, nil))}
	in.defaults()
	upstream := auditUpstreamClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != secret {
			t.Error("upstream did not receive injected credential")
		}
		name := http.CanonicalHeaderKey(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		w.Header().Set(name, "present")
		_, _ = io.WriteString(w, "ok")
	})
	ctx := context.WithValue(context.Background(), ctxKey{}, connInfo{pol: policy.ClaimPolicy{OrgID: "org-a", ClaimID: "claim-a"}, host: host, upstream: upstream})
	w := httptest.NewRecorder()
	in.proxyWithCredential(w, httptest.NewRequest("GET", "https://"+host+"/", nil).WithContext(ctx))
	for name := range w.Header() {
		if strings.EqualFold(name, strings.TrimPrefix(secret, "Bearer ")) {
			t.Fatal("credential escaped in response header name")
		}
	}
	if w.Code != http.StatusBadGateway {
		t.Fatal("sensitive header response was not refused")
	}
	if strings.Contains(strings.ToLower(logs.String()), strings.ToLower(strings.TrimPrefix(secret, "Bearer "))) {
		t.Fatal("refused header name reached logs")
	}
}

func TestCredentialLookupFailureLogsClosedCodeWithoutProviderDetails(t *testing.T) {
	for _, failure := range []struct {
		err  error
		code string
	}{
		{nil, "expired"}, {ErrVaultDenied, "denied"}, {ErrVaultNotConfigured, "not_configured"}, {context.Canceled, "cancelled"}, {context.DeadlineExceeded, "timeout"}, {errors.New(secret), "unavailable"},
	} {
		var logs bytes.Buffer
		in := &Injector{Log: slog.New(slog.NewJSONHandler(&logs, nil)), Vault: auditVault(func(context.Context, string, string, string) (Credential, error) { return Credential{}, failure.err })}
		in.defaults()
		ctx := context.WithValue(context.Background(), ctxKey{}, connInfo{pol: policy.ClaimPolicy{OrgID: "org-a", ClaimID: "claim-a"}, host: host})
		r := httptest.NewRequest("GET", "https://"+host+"/", nil).WithContext(ctx)
		w := httptest.NewRecorder()
		in.proxyWithCredential(w, r)
		if w.Code != 403 || strings.Contains(logs.String(), secret) || !strings.Contains(logs.String(), `"code":"`+failure.code+`"`) {
			t.Fatal("credential failure lost its safe diagnostic code")
		}
	}
}
