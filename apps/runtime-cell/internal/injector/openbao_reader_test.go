package injector

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// This suite uses only synthetic values and actual TLS connections. It tests
// the read boundary, not claim authorization or a running OpenBao installation.
func baoRef() SecretVersionRef {
	return SecretVersionRef{Scope: SecretScope{OrganizationID: "org-a", EnvironmentID: "env-a"}, ID: "payments", Version: 3}
}

var baoNow = time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)

func baoResponse() map[string]any {
	return map[string]any{"request_id": "synthetic-request", "data": map[string]any{
		"data":     map[string]any{"organizationId": "org-a", "environmentId": "env-a", "secretId": "payments", "value": "Bearer synthetic-value", "expiresAt": baoNow.Add(time.Hour).Format(time.RFC3339Nano)},
		"metadata": map[string]any{"version": 3, "destroyed": false, "deletion_time": "", "created_time": "2029-12-31T00:00:00Z", "custom_metadata": nil},
	}}
}

func baoServer(t *testing.T, h http.HandlerFunc) (*httptest.Server, OpenBaoReaderConfig) {
	t.Helper()
	s := httptest.NewUnstartedServer(h)
	s.Config.ErrorLog = log.New(io.Discard, "", 0)
	s.StartTLS()
	t.Cleanup(s.Close)
	roots := x509.NewCertPool()
	roots.AddCert(s.Certificate())
	return s, OpenBaoReaderConfig{Address: s.URL, Mount: "runtime-kv", Scope: baoRef().Scope, Roots: roots, Token: func(context.Context) (string, error) { return "synthetic-access-token", nil }, Now: func() time.Time { return baoNow }}
}

func newBaoReader(t *testing.T, cfg OpenBaoReaderConfig) *OpenBaoReader {
	t.Helper()
	r, err := NewOpenBaoReader(cfg)
	if err != nil {
		t.Fatalf("reader configuration: %v", err)
	}
	t.Cleanup(r.CloseIdleConnections)
	return r
}

func TestOpenBaoReadsExactVersionOverTLS(t *testing.T) {
	_, cfg := baoServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.RequestURI() != "/v1/runtime-kv/data/runtime/org-a/env-a/payments?version=3" || r.Header.Get("X-Vault-Token") != "synthetic-access-token" || r.Header.Get("X-Vault-Request") != "true" {
			t.Error("incorrect pinned read or authentication")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(baoResponse())
	})
	var reader SecretVersionReader = newBaoReader(t, cfg)
	got, err := reader.ReadVersion(context.Background(), baoRef())
	if err != nil || got.Scope != baoRef().Scope || got.ID != "payments" || got.Version != 3 || got.Value != "Bearer synthetic-value" || !got.ExpiresAt.Equal(baoNow.Add(time.Hour)) {
		t.Fatalf("exact version not returned: %v", err)
	}
	if strings.Contains(fmt.Sprintf("%v %#v %+v", got, got, got), "synthetic-value") {
		t.Fatal("value escaped formatting redaction")
	}
}

func TestOpenBaoRejectsUnsafeConfig(t *testing.T) {
	_, base := baoServer(t, func(http.ResponseWriter, *http.Request) { t.Error("invalid config sent a request") })
	for _, address := range []string{"", "http://localhost:8200", "https://user:password@bao.test", "https://bao.test/path", "https://bao.test?x=1", "https://bao.test#x", "https://bao.test/../", "https://bao.test:invalid", "https://bao.test/%2f"} {
		t.Run(address, func(t *testing.T) {
			cfg := base
			cfg.Address = address
			if _, err := NewOpenBaoReader(cfg); !errors.Is(err, ErrVaultConfig) {
				t.Fatal("unsafe endpoint accepted")
			}
		})
	}
	for _, mutate := range []func(*OpenBaoReaderConfig){
		func(c *OpenBaoReaderConfig) { c.Token = nil },
		func(c *OpenBaoReaderConfig) { c.Mount = "../other" },
		func(c *OpenBaoReaderConfig) { c.Mount = "kv/data" },
		func(c *OpenBaoReaderConfig) { c.Scope.EnvironmentID = "" },
		func(c *OpenBaoReaderConfig) { c.Timeout = -time.Second },
		func(c *OpenBaoReaderConfig) { c.Timeout = time.Minute },
	} {
		cfg := base
		mutate(&cfg)
		if _, err := NewOpenBaoReader(cfg); !errors.Is(err, ErrVaultConfig) {
			t.Fatal("unsafe reader configuration accepted")
		}
	}
}

func TestOpenBaoDeniesUnscopedAndUnpinnedReadsBeforeIO(t *testing.T) {
	_, cfg := baoServer(t, func(http.ResponseWriter, *http.Request) { t.Error("invalid reference reached backend") })
	cfg.Token = func(context.Context) (string, error) {
		t.Error("invalid reference reached identity source")
		return "", nil
	}
	r := newBaoReader(t, cfg)
	for _, mutate := range []func(*SecretVersionRef){
		func(r *SecretVersionRef) { r.Scope.OrganizationID = "org-b" },
		func(r *SecretVersionRef) { r.Scope.EnvironmentID = "env-b" },
		func(r *SecretVersionRef) { r.ID = "../other" },
		func(r *SecretVersionRef) { r.ID = "secret?version=4" },
		func(r *SecretVersionRef) { r.Version = 0 },
		func(r *SecretVersionRef) { r.Version = 1<<53 + 1 },
	} {
		ref := baoRef()
		mutate(&ref)
		if _, err := r.ReadVersion(context.Background(), ref); !errors.Is(err, ErrVaultDenied) {
			t.Fatal("unsafe reference accepted")
		}
	}
}

func TestOpenBaoDoesNotForwardTokenAcrossRedirect(t *testing.T) {
	target, cfg := baoServer(t, func(http.ResponseWriter, *http.Request) { t.Error("redirect destination reached") })
	source, sourceCfg := baoServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	})
	cfg.Address, cfg.Roots = source.URL, sourceCfg.Roots
	if _, err := newBaoReader(t, cfg).ReadVersion(context.Background(), baoRef()); !errors.Is(err, ErrVaultUnavailable) {
		t.Fatal("redirect accepted")
	}
}

func TestOpenBaoVerifiesServerCertificate(t *testing.T) {
	_, cfg := baoServer(t, func(http.ResponseWriter, *http.Request) { t.Error("untrusted server received authenticated request") })
	cfg.Roots = x509.NewCertPool()
	if _, err := newBaoReader(t, cfg).ReadVersion(context.Background(), baoRef()); !errors.Is(err, ErrVaultUnavailable) {
		t.Fatal("untrusted server accepted")
	}
}

func TestOpenBaoDoesNotUseEnvironmentProxy(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("environment proxy received vault traffic") }))
	defer proxy.Close()
	t.Setenv("HTTPS_PROXY", proxy.URL)
	_, cfg := baoServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(baoResponse())
	})
	r := newBaoReader(t, cfg)
	// A loopback request alone cannot detect ProxyFromEnvironment, whose
	// built-in loopback exemption would make this assertion vacuous.
	if r.transport.Proxy != nil {
		t.Fatal("ambient proxy resolution is enabled")
	}
	if _, err := r.ReadVersion(context.Background(), baoRef()); err != nil {
		t.Fatalf("direct read failed: %v", err)
	}
}

func TestOpenBaoSanitizesBackendErrors(t *testing.T) {
	for _, status := range []int{401, 403, 404, 429, 500, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			_, cfg := baoServer(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(status)
				_, _ = io.WriteString(w, "synthetic-access-token Bearer synthetic-value")
			})
			_, err := newBaoReader(t, cfg).ReadVersion(context.Background(), baoRef())
			want := ErrVaultUnavailable
			if status == 401 || status == 403 || status == 404 {
				want = ErrVaultDenied
			}
			if !errors.Is(err, want) || strings.Contains(fmt.Sprint(err), "synthetic") {
				t.Fatal("backend error was exposed or misclassified")
			}
		})
	}
}

func TestOpenBaoRejectsInvalidVersionPayloads(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"wrong-org":        func(p map[string]any) { p["organizationId"] = "org-b" },
		"wrong-env":        func(p map[string]any) { p["environmentId"] = "env-b" },
		"wrong-id":         func(p map[string]any) { p["secretId"] = "other" },
		"expired":          func(p map[string]any) { p["expiresAt"] = baoNow.Format(time.RFC3339Nano) },
		"bad-time":         func(p map[string]any) { p["expiresAt"] = "never" },
		"missing-expiry":   func(p map[string]any) { delete(p, "expiresAt") },
		"empty-value":      func(p map[string]any) { p["value"] = "" },
		"large-value":      func(p map[string]any) { p["value"] = strings.Repeat("x", 8193) },
		"header-injection": func(p map[string]any) { p["value"] = "token\r\nx-injected: yes" },
		"unknown-field":    func(p map[string]any) { p["header"] = "X-Arbitrary" },
	} {
		t.Run(name, func(t *testing.T) {
			response := baoResponse()
			mutate(response["data"].(map[string]any)["data"].(map[string]any))
			_, cfg := baoServer(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(response)
			})
			got, err := newBaoReader(t, cfg).ReadVersion(context.Background(), baoRef())
			if err == nil || got.Value != "" || strings.Contains(fmt.Sprint(err), "synthetic-value") {
				t.Fatal("unsafe payload released a value")
			}
		})
	}
}

func TestOpenBaoDeniesDeletedDestroyedOrDifferentVersion(t *testing.T) {
	for _, mutation := range []map[string]any{{"destroyed": true}, {"deletion_time": "2030-01-01T00:00:00Z"}, {"version": 4}, {"version": 0}, {"version": "3"}, {"version": 3.5}, {"destroyed": nil}} {
		response := baoResponse()
		metadata := response["data"].(map[string]any)["metadata"].(map[string]any)
		for key, value := range mutation {
			metadata[key] = value
		}
		_, cfg := baoServer(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(response)
		})
		if got, err := newBaoReader(t, cfg).ReadVersion(context.Background(), baoRef()); err == nil || got.Value != "" {
			t.Fatal("unavailable version released a value")
		}
	}
}

func TestOpenBaoBoundsAndStrictlyDecodesResponses(t *testing.T) {
	valid, _ := json.Marshal(baoResponse())
	for _, raw := range []string{
		string(valid) + "{}", "null", `{}`, `{"data":null}`,
		strings.Replace(string(valid), `"version":3`, `"version":3,"version":4`, 1),
		strings.Replace(string(valid), `"version":3`, `"version":3,"Version":4`, 1),
		strings.Replace(string(valid), `"value":"Bearer synthetic-value"`, `"value":"Bearer synthetic-value","value":"second"`, 1),
		`{"unused":` + strings.Repeat(`{"x":`, 40) + `0` + strings.Repeat(`}`, 40) + `}`,
		strings.Repeat(" ", 262145) + string(valid),
	} {
		_, cfg := baoServer(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, raw)
		})
		if got, err := newBaoReader(t, cfg).ReadVersion(context.Background(), baoRef()); err == nil || got.Value != "" {
			t.Fatal("ambiguous or unbounded JSON accepted")
		}
	}
}

func TestOpenBaoObtainsFreshIdentityAndDoesNotCacheValues(t *testing.T) {
	var reads atomic.Int32
	_, cfg := baoServer(t, func(w http.ResponseWriter, r *http.Request) {
		n := reads.Add(1)
		if r.Header.Get("X-Vault-Token") != fmt.Sprintf("synthetic-token-%d", n) {
			t.Error("stale identity reused")
		}
		if n == 2 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(baoResponse())
	})
	var identities atomic.Int32
	cfg.Token = func(context.Context) (string, error) {
		return fmt.Sprintf("synthetic-token-%d", identities.Add(1)), nil
	}
	r := newBaoReader(t, cfg)
	if _, err := r.ReadVersion(context.Background(), baoRef()); err != nil {
		t.Fatal(err)
	}
	if got, err := r.ReadVersion(context.Background(), baoRef()); !errors.Is(err, ErrVaultDenied) || got.Value != "" {
		t.Fatal("cached value bypassed revocation")
	}
	if reads.Load() != 2 || identities.Load() != 2 {
		t.Fatal("identity or value was cached")
	}
}

func TestOpenBaoRejectsIdentityErrorsAndUnsafeTokens(t *testing.T) {
	for _, token := range []string{"", "token\r\ninjected: true", "token with spaces", strings.Repeat("a", 4097)} {
		_, cfg := baoServer(t, func(http.ResponseWriter, *http.Request) { t.Error("unsafe identity reached backend") })
		cfg.Token = func(context.Context) (string, error) { return token, nil }
		if _, err := newBaoReader(t, cfg).ReadVersion(context.Background(), baoRef()); !errors.Is(err, ErrVaultDenied) {
			t.Fatal("unsafe token accepted")
		}
	}
	_, cfg := baoServer(t, func(http.ResponseWriter, *http.Request) { t.Error("failed identity reached backend") })
	cfg.Token = func(context.Context) (string, error) { return "", errors.New("synthetic-sensitive-error") }
	if _, err := newBaoReader(t, cfg).ReadVersion(context.Background(), baoRef()); err != ErrVaultUnavailable {
		t.Fatal("identity error escaped")
	}
}

func TestOpenBaoHonorsCancellationAndRequestDeadline(t *testing.T) {
	_, cfg := baoServer(t, func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
	cfg.Timeout = 100 * time.Millisecond
	r := newBaoReader(t, cfg)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.ReadVersion(ctx, baoRef()); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled caller accepted")
	}
	if _, err := r.ReadVersion(context.Background(), baoRef()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("request deadline not enforced")
	}
}

func TestOpenBaoRechecksExpiryAfterBackendIO(t *testing.T) {
	now := baoNow
	_, cfg := baoServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(baoResponse())
	})
	// Called after the backend response: the value expired while in flight.
	cfg.Now = func() time.Time { return now.Add(2 * time.Hour) }
	if got, err := newBaoReader(t, cfg).ReadVersion(context.Background(), baoRef()); !errors.Is(err, ErrVaultDenied) || got.Value != "" {
		t.Fatal("expired response released")
	}
}

func TestOpenBaoZeroReaderRefusesWithoutPanic(t *testing.T) {
	for _, reader := range []*OpenBaoReader{nil, {}} {
		if _, err := reader.ReadVersion(context.Background(), baoRef()); !errors.Is(err, ErrVaultNotConfigured) {
			t.Fatal("unconfigured reader must refuse")
		}
		reader.CloseIdleConnections()
	}
}

func TestOpenBaoLimitsConcurrentIdentityAndBackendWork(t *testing.T) {
	_, cfg := baoServer(t, func(http.ResponseWriter, *http.Request) { t.Error("cancelled identity reached backend") })
	entered := make(chan struct{}, 8)
	cfg.Token = func(ctx context.Context) (string, error) { entered <- struct{}{}; <-ctx.Done(); return "", ctx.Err() }
	reader := newBaoReader(t, cfg)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	results := make(chan error, 8)
	for range 8 {
		go func() { _, err := reader.ReadVersion(ctx, baoRef()); results <- err }()
	}
	for range 8 {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("concurrent reads did not enter identity source")
		}
	}
	queued, cancelQueued := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancelQueued()
	if _, err := reader.ReadVersion(queued, baoRef()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("queued request ignored deadline")
	}
	cancel()
	for range 8 {
		if err := <-results; !errors.Is(err, context.Canceled) {
			t.Fatal("active read ignored cancellation")
		}
	}
	if len(entered) != 0 {
		t.Fatal("more than eight identity lookups admitted")
	}
}

func TestOpenBaoRejectsWrongMediaEncodingAndSlowBody(t *testing.T) {
	for _, headers := range []map[string]string{{"Content-Type": "text/html"}, {"Content-Type": "application/json", "Content-Encoding": "gzip"}} {
		_, cfg := baoServer(t, func(w http.ResponseWriter, _ *http.Request) {
			for key, value := range headers {
				w.Header().Set(key, value)
			}
			_ = json.NewEncoder(w).Encode(baoResponse())
		})
		if got, err := newBaoReader(t, cfg).ReadVersion(context.Background(), baoRef()); !errors.Is(err, ErrVaultUnavailable) || got.Value != "" {
			t.Fatal("unexpected response format accepted")
		}
	}
	_, cfg := baoServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":`)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	cfg.Timeout = 100 * time.Millisecond
	if _, err := newBaoReader(t, cfg).ReadVersion(context.Background(), baoRef()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("body read ignored deadline")
	}
}
