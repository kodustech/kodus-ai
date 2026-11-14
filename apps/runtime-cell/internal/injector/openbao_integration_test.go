package injector

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// Opt-in only. The operator supplies an already verified OpenBao binary. This
// starts only owned processes on loopback, uses fresh synthetic bootstrap/read
// tokens, and stores all material in t.TempDir. It never contacts an existing
// vault or reads credentials from the developer's environment.
func TestOpenBaoRealKVVersionRevocationAndRestart(t *testing.T) {
	binary := os.Getenv("KODY_OPENBAO_TEST_BINARY")
	if binary == "" {
		t.Skip("set KODY_OPENBAO_TEST_BINARY to a publisher-verified test binary")
	}
	if !filepath.IsAbs(binary) {
		t.Fatal("test binary must be an absolute operator-supplied path")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	ca, err := testpki.NewCA("openbao-reader-integration-only")
	if err != nil {
		t.Fatal(err)
	}
	cert, err := ca.Issue("loopback-test", time.Hour, "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if err = ca.WriteFiles(dir, "server-", cert); err != nil {
		t.Fatal(err)
	}
	apiAddress, clusterAddress := baoLoopbackAddress(t), baoLoopbackAddress(t)
	address := "https://" + apiAddress
	config := map[string]any{
		"disable_mlock": true, // Disposable test only; not a production hardening decision.
		"api_addr":      address, "cluster_addr": "https://" + clusterAddress,
		"storage":  map[string]any{"raft": map[string]any{"path": filepath.Join(dir, "raft"), "node_id": "reader-poc"}},
		"listener": []any{map[string]any{"tcp": map[string]any{"address": apiAddress, "cluster_address": clusterAddress, "tls_cert_file": filepath.Join(dir, "server-cert.pem"), "tls_key_file": filepath.Join(dir, "server-key.pem")}}},
	}
	raw, _ := json.Marshal(config)
	configPath := filepath.Join(dir, "server.json")
	if err = os.WriteFile(configPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: ca.Pool()}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	stop := baoStartOwnedProcess(t, ctx, binary, configPath, dir)
	baoWaitReady(t, ctx, client, address, "/v1/sys/init")

	// Raft's one-time initialization includes bootstrap/election work. The
	// diagnostic run exhausted this test client's 2s deadline before any read.
	// Bound only initialization separately; the reader keeps its own 3s cap.
	bootstrapClient := *client
	bootstrapClient.Timeout = 15 * time.Second
	initStarted := time.Now()
	_, initialized := baoTestRequest(t, ctx, &bootstrapClient, address, "", "PUT", "/v1/sys/init", map[string]any{"secret_shares": 1, "secret_threshold": 1}, 200)
	t.Logf("owned Raft initialization completed in %d ms", time.Since(initStarted).Milliseconds())
	root, _ := initialized["root_token"].(string)
	keys, _ := initialized["keys_base64"].([]any)
	if len(root) == 0 || len(keys) != 1 {
		t.Fatal("test initialization did not produce bootstrap material")
	}
	unseal, _ := keys[0].(string)
	_, unsealed := baoTestRequest(t, ctx, client, address, "", "PUT", "/v1/sys/unseal", map[string]any{"key": unseal}, 200)
	if unsealed["sealed"] != false {
		t.Fatal("owned test server did not unseal")
	}
	baoWaitReady(t, ctx, client, address, "/v1/sys/health")
	baoTestRequest(t, ctx, client, address, root, "POST", "/v1/sys/mounts/runtime-kv", map[string]any{"type": "kv", "options": map[string]any{"version": "2"}}, 204)
	// A healthy core can still have a newly mounted KV initializing. Probe
	// its read-only config before fixture writes; do not replay CAS writes.
	if err = baoWaitKVReady(ctx, client, address, root, clock.Real{}); err != nil {
		t.Fatalf("owned KV fixture did not become ready: %v", err)
	}
	payload := baoResponse()["data"].(map[string]any)["data"].(map[string]any)
	// Version 3 deliberately is not latest. A reader that drops its pin would
	// receive version 4, including after restart or deletion of version 3.
	for version := 1; version <= 4; version++ {
		t.Logf("owned KV fixture creating version %d", version)
		payload["value"] = fmt.Sprintf("Bearer synthetic-version-%d", version)
		baoTestRequest(t, ctx, client, address, root, "POST", "/v1/runtime-kv/data/runtime/org-a/env-a/payments", map[string]any{"data": payload, "options": map[string]any{"cas": version - 1}}, 200)
	}
	baoTestRequest(t, ctx, client, address, root, "PUT", "/v1/sys/policies/acl/runtime-read", map[string]any{"policy": `path "runtime-kv/data/runtime/org-a/env-a/payments" { capabilities = ["read"] }`}, 204)
	newReadToken := func() string {
		_, response := baoTestRequest(t, ctx, client, address, root, "POST", "/v1/auth/token/create", map[string]any{"policies": []string{"runtime-read"}, "ttl": "5m", "renewable": false, "no_default_policy": true}, 200)
		auth, _ := response["auth"].(map[string]any)
		token, _ := auth["client_token"].(string)
		if token == "" || token == root {
			t.Fatal("restricted read identity was not issued")
		}
		return token
	}
	token := newReadToken()
	reader := newBaoReader(t, OpenBaoReaderConfig{Address: address, Mount: "runtime-kv", Scope: baoRef().Scope, Roots: ca.Pool(), Token: func(context.Context) (string, error) { return token, nil }, Now: func() time.Time { return baoNow }})
	got, err := reader.ReadVersion(ctx, baoRef())
	if err != nil || got.Value != "Bearer synthetic-version-3" || got.Version != 3 {
		t.Fatalf("real pinned read failed: %v", err)
	}
	// The real value reader now sits behind the same durable claim ledger
	// consumed by Injector.Vault. The ledger stores only version metadata.
	ledgerCfg, _, binding := vaultFixture(t)
	ledgerCfg.ExternalValues, ledgerCfg.ExternalSourceID = reader, "bao-reader-poc-v1"
	binding.Version = 3
	pub, signingKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	policies := policy.NewStore(ledgerCfg.Now)
	ledgerCfg.Claims = PolicyClaimAuthorizer{Policies: policies, Now: ledgerCfg.Now}
	// This handler is in-process; existing tests separately cover the mTLS
	// listener. Here the policy signature/live authorizer is the real code.
	originalPolicy := signedPolicyForBinding(binding, ledgerCfg.Now())
	installSignedPolicy(t, (&control.Server{Policies: policies, AgentKey: pub, Now: ledgerCfg.Now}).Handler(), signingKey, originalPolicy)
	ledger, err := OpenConfiguredVault(ledgerCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ledger.Close() }()
	if err = ledger.RegisterExternalVersion(ctx, ExternalSecretVersion{Scope: baoRef().Scope, ID: "payments", Version: 3, ExpiresAt: baoNow.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err = ledger.Bind(ctx, binding); err != nil {
		t.Fatal(err)
	}
	credential, err := ledger.Credential(ctx, "org-a", "claim-a", binding.Host)
	if err != nil || credential.Value != "Bearer synthetic-version-3" {
		t.Fatalf("real reader behind grant ledger failed: %v", err)
	}
	// The reader's actual identity has neither write nor cross-scope access.
	baoTestRequest(t, ctx, client, address, token, "POST", "/v1/runtime-kv/data/runtime/org-a/env-a/payments", map[string]any{"data": payload}, 403)
	baoTestRequest(t, ctx, client, address, token, "GET", "/v1/runtime-kv/data/runtime/org-b/env-a/payments?version=3", nil, 403)
	baoTestRequest(t, ctx, client, address, root, "POST", "/v1/auth/token/revoke", map[string]any{"token": token}, 204)
	if got, err = reader.ReadVersion(ctx, baoRef()); !errors.Is(err, ErrVaultDenied) || got.Value != "" {
		t.Fatal("real token revocation was bypassed")
	}
	if credential, err = ledger.Credential(ctx, "org-a", "claim-a", binding.Host); !errors.Is(err, ErrVaultDenied) || credential.Value != "" {
		t.Fatal("grant ledger cached a remotely revoked value")
	}
	token = newReadToken()
	stop()
	stop = baoStartOwnedProcess(t, ctx, binary, configPath, dir)
	baoWaitReady(t, ctx, client, address, "/v1/sys/init")
	_, sealStatus := baoTestRequest(t, ctx, client, address, "", "GET", "/v1/sys/seal-status", nil, 200)
	if sealStatus["sealed"] != true {
		t.Fatal("restarted test server is not sealed")
	}
	if got, err = reader.ReadVersion(ctx, baoRef()); !errors.Is(err, ErrVaultUnavailable) || got.Value != "" {
		t.Fatal("sealed restarted server released a value")
	}
	baoTestRequest(t, ctx, client, address, "", "PUT", "/v1/sys/unseal", map[string]any{"key": unseal}, 200)
	baoWaitReady(t, ctx, client, address, "/v1/sys/health")
	if got, err = reader.ReadVersion(ctx, baoRef()); err != nil || got.Value != "Bearer synthetic-version-3" {
		t.Fatalf("Raft restart lost the pinned version: %v", err)
	}
	if err = ledger.Close(); err != nil {
		t.Fatal(err)
	}
	ledger, err = OpenConfiguredVault(ledgerCfg)
	if err != nil {
		t.Fatal(err)
	}
	if credential, err = ledger.Credential(ctx, "org-a", "claim-a", binding.Host); err != nil || credential.Value != "Bearer synthetic-version-3" {
		t.Fatalf("metadata-only ledger restart failed: %v", err)
	}
	removal := httptest.NewRequest(http.MethodDelete, "/v1/policy/"+binding.Scope.ClaimID, nil)
	sig, signedAt := control.SignRemoval(signingKey, binding.Scope.ClaimID, ledgerCfg.Now())
	removal.Header.Set(control.SignatureHeader, sig)
	removal.Header.Set(control.SignedAtHeader, signedAt)
	removed := httptest.NewRecorder()
	(&control.Server{Policies: policies, AgentKey: pub, Now: ledgerCfg.Now, DurableDelete: ledger.RevokeKnownClaim}).Handler().ServeHTTP(removed, removal)
	if removed.Code != http.StatusNoContent {
		t.Fatal("signed grant removal did not persist")
	}
	if err = ledger.Close(); err != nil {
		t.Fatal(err)
	}
	// Replay of a previously valid signed policy in a fresh in-memory policy
	// store cannot resurrect the durably revoked external grant.
	policies = policy.NewStore(ledgerCfg.Now)
	ledgerCfg.Claims = PolicyClaimAuthorizer{Policies: policies, Now: ledgerCfg.Now}
	ledger, err = OpenConfiguredVault(ledgerCfg)
	if err != nil {
		t.Fatal(err)
	}
	installSignedPolicy(t, (&control.Server{Policies: policies, AgentKey: pub, Now: ledgerCfg.Now}).Handler(), signingKey, originalPolicy)
	if credential, err = ledger.Credential(ctx, "org-a", "claim-a", binding.Host); !errors.Is(err, ErrVaultDenied) || credential.Value != "" {
		t.Fatal("durably revoked claim reached real backend")
	}
	if got, err = reader.ReadVersion(ctx, baoRef()); err != nil || got.Value != "Bearer synthetic-version-3" {
		t.Fatal("revoked-grant denial was not measured against a healthy backend")
	}
	baoTestRequest(t, ctx, client, address, root, "POST", "/v1/runtime-kv/delete/runtime/org-a/env-a/payments", map[string]any{"versions": []int{3}}, 204)
	if got, err = reader.ReadVersion(ctx, baoRef()); !errors.Is(err, ErrVaultDenied) || got.Value != "" {
		t.Fatal("real deleted version released a value")
	}
	stop()
}

func baoLoopbackAddress(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := l.Addr().String()
	if err = l.Close(); err != nil {
		t.Fatal(err)
	}
	return address
}

func baoStartOwnedProcess(t *testing.T, ctx context.Context, binary, config, dir string) func() {
	t.Helper()
	cmd := exec.CommandContext(ctx, binary, "server", "-config="+config)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + dir, "TMPDIR=" + dir, "GOMAXPROCS=2"}
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatal("unable to start verified owned test process")
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	stop := func() {
		select {
		case <-done:
			return
		default:
		}
		_ = cmd.Process.Signal(os.Interrupt)
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			_ = cmd.Process.Kill()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Error("owned test process did not exit")
			}
		}
	}
	t.Cleanup(stop)
	return stop
}

func baoWaitReady(t *testing.T, ctx context.Context, client *http.Client, address, path string) {
	t.Helper()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		req, _ := http.NewRequestWithContext(ctx, "GET", address+path, nil)
		response, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			_ = response.Body.Close()
			if response.StatusCode == 200 {
				return
			}
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("owned TLS server did not become ready")
		}
	}
}

func baoTestRequest(t *testing.T, ctx context.Context, client *http.Client, address, token, method, path string, input any, expected int) (int, map[string]any) {
	t.Helper()
	var body io.Reader
	if input != nil {
		raw, err := json.Marshal(input)
		if err != nil {
			t.Fatal("unable to encode synthetic test request")
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, address+path, body)
	if err != nil {
		t.Fatal("invalid test request")
	}
	if token != "" {
		req.Header.Set("X-Vault-Token", token)
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := client.Do(req)
	if err != nil {
		var netErr net.Error
		timedOut := errors.As(err, &netErr) && netErr.Timeout()
		t.Fatalf("owned test API %s %s transport failed (type=%T timeout=%t context_done=%t; details withheld)", method, path, err, timedOut, ctx.Err() != nil)
	}
	defer response.Body.Close()
	if response.StatusCode != expected {
		// Only classify known bootstrap/fixture errors. Never print response
		// text, request bodies or the synthetic root/read tokens.
		var failure struct {
			Errors []string `json:"errors"`
		}
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		_ = json.Unmarshal(raw, &failure)
		code := "unclassified"
		// Safe vocabulary only: sufficient to diagnose infrastructure/fixture
		// failures without printing arbitrary backend strings or token bytes.
		vocabulary := map[string]bool{}
		for _, word := range strings.Fields("invalid input parameter cas version data field required type allowed mount token lease expired json parse metadata must quota rate limit storage permission unsupported transaction audit disk space size deadline request capability namespace error create update patch check") {
			vocabulary[word] = true
		}
		keywords := map[string]bool{}
		for _, message := range failure.Errors {
			for _, word := range strings.FieldsFunc(strings.ToLower(message), func(r rune) bool { return r < 'a' || r > 'z' }) {
				if vocabulary[word] {
					keywords[word] = true
				}
			}
			switch {
			case message == baoKVUpgradingMessage:
				code = "kv_upgrading"
			case strings.Contains(message, "check-and-set parameter did not match"):
				code = "cas_mismatch"
			case strings.Contains(message, "permission denied"):
				code = "permission_denied"
			case strings.Contains(message, "no data provided"):
				code = "missing_data"
			case strings.Contains(message, "unsupported path"):
				code = "unsupported_path"
			case strings.Contains(message, "read-only"):
				code = "read_only"
			}
		}
		t.Fatalf("owned test API %s %s status %d, want %d code=%s error_terms=%v body_bytes=%d (body withheld)", method, path, response.StatusCode, expected, code, keywords, len(raw))
	}
	var result map[string]any
	if expected != 204 {
		raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		if err != nil || json.Unmarshal(raw, &result) != nil {
			t.Fatal("invalid owned test API response (body withheld)")
		}
	}
	return response.StatusCode, result
}
