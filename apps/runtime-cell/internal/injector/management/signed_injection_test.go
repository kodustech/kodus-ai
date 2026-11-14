package management

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/egress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// The owner-local API and signed-policy authorizer had only separate proofs.
// This chain provisions through the real Unix client, then observes an actual
// TLS-injected/redacted response and revocation on the same client connection.
// All certificates, keys, destinations and credentials are synthetic fixtures.
func TestOwnerProvisioningSignedPolicyInjectionAndRevocation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	base := privateDir(t)
	store := policy.NewStore(nil)
	pub, signingKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := testpki.NewCA("synthetic-owner-cell")
	if err != nil {
		t.Fatal(err)
	}
	serverCert, err := ca.Issue("injector-control", time.Hour, "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	agentCert, err := ca.Issue("cell-a", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	controller := httptest.NewUnstartedServer((&control.Server{Policies: store, AgentKey: pub}).Handler())
	controller.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientCAs: ca.Pool(), ClientAuth: tls.RequireAndVerifyClientCert, MinVersion: tls.VersionTLS13}
	controller.StartTLS()
	defer controller.Close()
	controlClient := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{Certificates: []tls.Certificate{agentCert}, RootCAs: ca.Pool(), MinVersion: tls.VersionTLS13}}}
	defer controlClient.CloseIdleConnections()
	pusher := control.Pusher{Endpoints: []control.Endpoint{{Name: "injector", URL: controller.URL}}, HTTP: controlClient, Key: signingKey}
	const host = "api.example.test"
	hardExpiry := time.Now().UTC().Add(time.Hour)
	if err = pusher.Push(ctx, policy.ClaimPolicy{ClaimID: "claim-a", OrgID: "org-a", EnvironmentID: "env-a", Sources: []string{"127.0.0.1"}, Allow: []string{host}, CredentialHosts: []string{host}, Phase: policy.PhaseTest, IssuedAt: time.Now().UTC().Add(-time.Second), ExpiresAt: hardExpiry}); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(base, "vault")
	if err = os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	key := filepath.Join(base, "owner.key")
	if err = os.WriteFile(key, bytes.Repeat([]byte{19}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	vault, err := injector.OpenConfiguredVault(injector.VaultConfig{Directory: dir, KeyFile: key, CellID: "cell-a", Claims: injector.PolicyClaimAuthorizer{Policies: store}})
	if err != nil {
		t.Fatal(err)
	}
	defer vault.Close()
	socket, _, _ := startServer(t, vault, base)
	const value = "Bearer synthetic-owner-socket-token-119af0"
	expires := time.Now().UTC().Add(20 * time.Minute).Format(time.RFC3339Nano)
	for _, command := range []struct{ operation, body string }{
		{"put", `{"organizationId":"org-a","environmentId":"env-a","id":"payments","version":1,"value":"` + value + `","expiresAt":"` + expires + `"}`},
		{"bind", `{"organizationId":"org-a","environmentId":"env-a","claimId":"claim-a","secretId":"payments","version":1,"host":"` + host + `","header":"Authorization","expiresAt":"` + expires + `"}`},
	} {
		if response, err := Call(ctx, socket, command.operation, []byte(command.body)); err != nil || len(response) != 0 {
			t.Fatalf("owner operation %s failed without a response body: %v", command.operation, err)
		}
	}
	var upstreamRequests atomic.Int32
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamRequests.Add(1)
		if r.Header.Get("Authorization") != value {
			t.Error("upstream did not receive the owner's selected credential")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("X-Echo-Authorization", value)
		_, _ = io.WriteString(w, value)
	}))
	upCert, err := ca.Issue(host, time.Hour, host)
	if err != nil {
		t.Fatal(err)
	}
	upstream.TLS = &tls.Config{Certificates: []tls.Certificate{upCert}, MinVersion: tls.VersionTLS13}
	upstream.StartTLS()
	defer upstream.Close()
	loopback, err := netguard.ParseCIDRs("127.0.0.0/8")
	if err != nil {
		t.Fatal(err)
	}
	silent := slog.New(slog.NewTextHandler(io.Discard, nil))
	in := &injector.Injector{Policies: store, Vault: vault, CA: ca.Cert, CAKey: ca.Key, TrustedProxies: []string{"127.0.0.1"}, UpstreamRoots: ca.Pool(), InternalCIDRs: loopback, Log: silent,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, network, strings.TrimPrefix(upstream.URL, "https://"))
		}}
	il, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer il.Close()
	go func() { _ = in.Serve(ctx, il) }()
	proxy := &egress.Proxy{Policies: store, Events: egress.NewEvents(10), InjectorAddr: il.Addr().String(), InternalCIDRs: loopback, Log: silent,
		Resolve: func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("127.0.0.1")}, nil }}
	pl, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Close()
	go func() { _ = proxy.Serve(ctx, pl, 443, true) }()
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: ca.Pool(), MinVersion: tls.VersionTLS13}, DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, network, pl.Addr().String())
	}}}
	defer client.CloseIdleConnections()
	response, err := client.Get("https://" + host + "/echo")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	header, _ := json.Marshal(response.Header)
	if err != nil || response.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(injector.Masked)) || bytes.Contains(body, []byte(value)) || bytes.Contains(header, []byte(value)) || upstreamRequests.Load() != 1 {
		t.Fatal("injection or reflected-response redaction failed")
	}
	if err = pusher.Remove(ctx, "claim-a"); err != nil {
		t.Fatal(err)
	}
	reused := false
	request, _ := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) { reused = info.Reused }}), http.MethodGet, "https://"+host+"/echo", nil)
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if !reused || response.StatusCode != http.StatusForbidden || upstreamRequests.Load() != 1 {
		t.Fatal("revoked policy reached upstream or did not exercise the existing connection")
	}
	ciphertext, err := os.ReadFile(filepath.Join(dir, "vault.json"))
	if err != nil || bytes.Contains(ciphertext, []byte(value)) {
		t.Fatal("owner operation persisted plaintext")
	}
}
