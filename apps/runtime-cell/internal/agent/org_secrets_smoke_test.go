//go:build dockersmoke && unix

package agent

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/egress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testopenbao"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// An org secret end to end on the cell (docs/runtime/sandbox.md "Secrets:
// OpenBao"): the value written to OpenBao by the API's AppRole with the
// API's request; its reference in a sandbox.acquire; the cell agent's
// placeholder in the sandbox's env and in the signed policy (PolicySpec,
// policy.Build); a command in the sandbox calling the secret's host with the
// placeholder through the proxy and the injector, which reads the value
// from OpenBao and sends it upstream. The machine never sees the value. A
// placeholder sent over plain HTTP is refused by the proxy and its alert
// feed compromises the claim.
//
// The proxy and the injector here are built in process. How the binaries
// are wired (cmd/egress -injector-addr, cmd/injector -trusted-proxies, and
// the dev cell's script) is tested in cmd/egress (plane_test.go,
// devcell_test.go): this test alone missed a real cell whose egress had no
// injector address.
//
// Standalone it starts its own OpenBao (docker). Driven by the TypeScript
// integration (libs/runtime/api/__tests__/org-secret-to-cell.integration.spec.ts), it takes
// that OpenBao (testopenbao.Env) and the secret the API wrote there:
// KGR_E2E_ORG, KGR_E2E_SECRET_REFS (the references the hub read from the
// product database), KGR_E2E_SECRET_VALUE.
//
//	go test -tags dockersmoke -run TestAnOrgSecretReachesItsHost -v ./internal/agent/

// storeEgress builds each claim's policy as the cell does (PolicySpec,
// policy.Build) and puts it in the store the proxy and the injector read.
type storeEgress struct{ store *policy.Store }

func (s storeEgress) Apply(_ context.Context, c ClaimInfo) error {
	spec, err := PolicySpec(c, nil, time.Now())
	if err != nil {
		return err
	}
	pol, _, err := policy.Build(spec, nil)
	if err != nil {
		return err
	}
	return s.store.Put(pol)
}

func (s storeEgress) Remove(_ context.Context, id string) error {
	s.store.Delete(id)
	return nil
}

// clientFeed is an alert feed read over HTTP as the cell reads it.
type clientFeed struct{ c *injector.AlertClient }

func (f clientFeed) Alerts(ctx context.Context, after int64) ([]Alert, error) {
	got, err := f.c.After(ctx, after)
	out := make([]Alert, 0, len(got))
	for _, a := range got {
		out = append(out, Alert{Seq: a.Seq, ClaimID: a.ClaimID, Host: a.Host, Kind: a.Kind, At: a.At})
	}
	return out, err
}

func TestAnOrgSecretReachesItsHostAsTheValueWhileTheMachineHoldsThePlaceholder(t *testing.T) {
	if _, err := exec.LookPath("curl"); err != nil {
		t.Skip("curl is required")
	}
	const plainHost, publicHost = "plain.example.test", "public.example.test"
	refs := []protocol.ClaimAcquireBodySecretsItem{{ID: "npm_token", Name: "NPM_TOKEN", Hosts: []string{"npm.registry.test"}}}
	bao, driven := testopenbao.Env(t)
	org, value := "org-e2e-"+testopenbao.RandomHex(t, 4), "npm_synthetic_value_"+testopenbao.RandomHex(t, 8)
	if driven {
		org, value = os.Getenv("KGR_E2E_ORG"), os.Getenv("KGR_E2E_SECRET_VALUE")
		if err := json.Unmarshal([]byte(os.Getenv("KGR_E2E_SECRET_REFS")), &refs); err != nil || len(refs) == 0 || org == "" || value == "" {
			t.Fatalf("KGR_E2E_ORG, KGR_E2E_SECRET_REFS and KGR_E2E_SECRET_VALUE are required with KGR_OPENBAO_ADDR: %v", err)
		}
	} else {
		bao = testopenbao.Start(t)
		if status := bao.WriteSecret(t, bao.Login(t, "api"), org, refs[0].ID, value, refs[0].Hosts); status != http.StatusOK {
			t.Fatalf("api write: %d", status)
		}
	}
	host := refs[0].Hosts[0]

	// The secret's host: it reflects the request's headers, as an upstream
	// that echoes (S-50) would.
	cellCA, _ := testpki.NewCA("cell-ca")
	publicCA, _ := testpki.NewCA("public-ca")
	upCert, _ := publicCA.Issue(host, time.Hour, host)
	seen := make(chan http.Header, 4)
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Clone()
		_ = r.Header.Write(w)
	}))
	up.TLS = &tls.Config{Certificates: []tls.Certificate{upCert}, MinVersion: tls.VersionTLS12}
	up.StartTLS()
	t.Cleanup(up.Close)
	plainUp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { seen <- r.Header.Clone() }))
	t.Cleanup(plainUp.Close)
	// A public host with no secret: the proxy passes its TLS through, so
	// the machine checks the host's own certificate against its roots.
	pubCert, _ := publicCA.Issue(publicHost, time.Hour, publicHost)
	publicUp := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("public ok")) }))
	publicUp.TLS = &tls.Config{Certificates: []tls.Certificate{pubCert}, MinVersion: tls.VersionTLS12}
	publicUp.StartTLS()
	t.Cleanup(publicUp.Close)

	// The cell's egress: one policy store for the proxy and the injector,
	// the injector reading values from OpenBao as its AppRole, each with its
	// alert feed on a control port.
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	loopback, _ := netguard.ParseCIDRs("127.0.0.0/8")
	policies := policy.NewStore(nil)
	roleID, secretID := bao.RoleFiles("injector")
	token := &injector.AppRoleToken{Address: bao.Address, Roots: bao.Roots, RoleIDFile: roleID, SecretIDFile: secretID}
	values, err := injector.NewOpenBaoSecrets(injector.OpenBaoSecretsConfig{Address: bao.Address, Mount: testopenbao.Mount, Roots: bao.Roots, Token: token.Token})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(values.CloseIdleConnections)
	injAlerts := eventlog.New[injector.Alert](10)
	inj := &injector.Injector{
		Policies: policies, Vault: injector.RefusingVault{}, Secrets: values, CA: cellCA.Cert, CAKey: cellCA.Key,
		TrustedProxies: []string{"127.0.0.1"}, UpstreamRoots: publicCA.Pool(), InternalCIDRs: loopback, Alerts: injAlerts,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(up.URL, "https://"))
		},
	}
	il, _ := net.Listen("tcp4", "127.0.0.1:0")
	go func() { _ = inj.Serve(ctx, il) }()
	injCtl := http.NewServeMux()
	injCtl.HandleFunc("GET /v1/alerts", injAlerts.Handler())
	injSrv := httptest.NewServer(injCtl)
	t.Cleanup(injSrv.Close)

	proxyAlerts := egress.NewAlerts(10)
	px := &egress.Proxy{
		Policies: policies, Events: egress.NewEvents(10), InjectorAddr: il.Addr().String(), InternalCIDRs: loopback,
		Resolve:           func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("127.0.0.1")}, nil },
		OnPlaceholderLeak: func(claimID, host string) { proxyAlerts.PlaceholderLeak(claimID, host, time.Now()) },
		Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			switch {
			case addr == il.Addr().String():
			case strings.HasSuffix(addr, ":443"):
				addr = strings.TrimPrefix(publicUp.URL, "https://")
			default:
				addr = strings.TrimPrefix(plainUp.URL, "http://")
			}
			return (&net.Dialer{}).DialContext(ctx, network, addr)
		},
	}
	tl, _ := net.Listen("tcp4", "127.0.0.1:0")
	pl, _ := net.Listen("tcp4", "127.0.0.1:0")
	go func() { _ = px.Serve(ctx, tl, 443, true) }()
	go func() { _ = px.Serve(ctx, pl, 80, false) }()
	proxySrv := httptest.NewServer((&egress.Control{Alerts: proxyAlerts}).Handler())
	t.Cleanup(proxySrv.Close)

	// The cell's trust files, as cmd/cell writes them at start: the public
	// roots (here the CA of every upstream) and the injector's cell CA.
	trust, err := machinetrust.Write(filepath.Join(t.TempDir(), "trust"), publicCA.PEM, cellCA.PEM)
	if err != nil {
		t.Fatal(err)
	}

	// The cell agent: fake sandboxes on the host (127.0.0.1, the proxy's
	// source for the claim) with the real guest agent, both alert feeds.
	// The fake points a trusted sandbox's variables at the files where they
	// are on the host, standing in for docker-gvisor's mounts.
	h := newHarness(t, func(c *Config) {
		c.Parts.Sandboxes = fake.Sandboxes{Driver: c.Driver.(*fake.Driver), Root: t.TempDir(), Trust: trust}
		c.CellTrust = true
		c.Egress = storeEgress{policies}
		c.Alerts = clientFeed{&injector.AlertClient{URL: injSrv.URL, HTTP: injSrv.Client(), Wait: 100 * time.Millisecond}}
		c.EgressAlerts = clientFeed{&injector.AlertClient{URL: proxySrv.URL, HTTP: proxySrv.Client(), Wait: 100 * time.Millisecond}}
	})
	go h.a.watchAlerts(ctx, 0)
	go h.a.watchAlerts(ctx, 1)
	testopenbao.WaitFor(t, 10*time.Second, h.a.acceptingWork)

	sandbox := func(id string) {
		t.Helper()
		b := h.sandboxBody(org)
		b.EgressAllow = append(b.EgressAllow, plainHost, publicHost)
		b.Secrets = refs
		if err := h.handle(id, protocol.MessageTypeSandboxAcquire, b); err != nil {
			t.Fatal(err)
		}
		h.conn.next(t, isReady)
	}
	run := func(id, command string) *protocol.SandboxExecResult {
		t.Helper()
		r := h.op(id, protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: str(command), TimeoutMs: i64(30_000)})
		if r.Sandbox == nil || r.Sandbox.Exec == nil {
			t.Fatalf("exec %q: %+v", command, r)
		}
		return r.Sandbox.Exec
	}

	sandbox("sbx-1")
	pol, ok := policies.ForClaim("sbx-1")
	if !ok || len(pol.Secrets) != 1 || !policy.ValidPlaceholder(pol.Secrets[0].Placeholder) {
		t.Fatalf("signed policy secrets %+v", pol.Secrets)
	}
	// The machine holds the placeholder under the secret's name, never the value.
	env := run("sbx-1", `test "$`+refs[0].Name+`" = "`+pol.Secrets[0].Placeholder+`" && echo placeholder; env`)
	if !strings.HasPrefix(env.Stdout, "placeholder\n") || strings.Contains(env.Stdout, value) {
		t.Fatalf("the machine's env: %q", env.Stdout)
	}
	// Its call to the secret's host carries the placeholder; the host gets
	// the value. curl runs with the machine's default trust (no --cacert):
	// the variables the cell set point at the bundle with the cell CA.
	call := run("sbx-1", fmt.Sprintf(`curl -sS --max-time 20 --connect-to %s:443:127.0.0.1:%d -H "Authorization: Bearer $%s" https://%s/pkg`,
		host, tl.Addr().(*net.TCPAddr).Port, refs[0].Name, host))
	if call.ExitCode != 0 {
		t.Fatalf("curl: exit %d: %s", call.ExitCode, call.Stderr)
	}
	select {
	case got := <-seen:
		if got.Get("Authorization") != "Bearer "+value {
			t.Fatal("the secret's host did not receive the stored value")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the secret's host received nothing")
	}
	// The echoed header comes back masked: the value never reaches the machine.
	if strings.Contains(call.Stdout, value) || !strings.Contains(call.Stdout, "Bearer") {
		t.Fatalf("what the machine read back: %q", call.Stdout)
	}
	// A public host is still trusted, through the same default trust: the
	// bundle keeps the public roots beside the cell CA.
	pub := run("sbx-1", fmt.Sprintf(`curl -sS --max-time 20 --connect-to %s:443:127.0.0.1:%d https://%s/`,
		publicHost, tl.Addr().(*net.TCPAddr).Port, publicHost))
	if pub.ExitCode != 0 || pub.Stdout != "public ok" {
		t.Fatalf("curl to the public host: exit %d: %q %s", pub.ExitCode, pub.Stdout, pub.Stderr)
	}

	// The same placeholder over plain HTTP: refused by the proxy, and the
	// claim is compromised through the proxy's alert feed. (One claim: the
	// fake's machines all have the host's address, the proxy's key for a
	// claim.)
	// The step does not answer: the alert stops it with the claim.
	leak := fmt.Sprintf(`curl -sS --max-time 10 --connect-to %s:80:127.0.0.1:%d -H "X-Token: $%s" http://%s/`,
		plainHost, pl.Addr().(*net.TCPAddr).Port, refs[0].Name, plainHost)
	if err := h.handle("sbx-1", protocol.MessageTypeSandboxOp, &protocol.SandboxOpBody{StepID: hubclient.NewID(), Op: protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &leak, TimeoutMs: i64(30_000)}}); err != nil {
		t.Fatal(err)
	}
	bl := h.conn.next(t, func(f any) bool {
		b, ok := f.(*protocol.BlockedBody)
		return ok && b.Signature == egress.ReasonPlaceholderLeak
	}).(*protocol.BlockedBody)
	if bl.Kind != protocol.BlockerKindSecurityViolation || !strings.Contains(bl.Message, plainHost) {
		t.Fatalf("blocked %+v", bl)
	}
	select {
	case <-seen:
		t.Fatal("the plain HTTP request carrying a placeholder went out")
	default:
	}
}
