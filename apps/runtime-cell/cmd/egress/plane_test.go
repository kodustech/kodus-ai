package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"flag"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/miekg/dns"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
)

const secretHost = "echo.secret.example"

// upstreamIP is what the fake recursive resolver answers for every name: a
// public (TEST-NET-3) address, so no -internal-cidrs is needed.
const upstreamIP = "203.0.113.7"

// egressRig is the egress the binary builds (newDataPlane from cmd/egress's
// flags), with a fake recursive resolver behind it and the agent's key.
type egressRig struct {
	d    *dataPlane
	key  ed25519.PrivateKey
	logs *bytes.Buffer
	tls  string // the proxy's TLS listener
	http string // its plain HTTP listener
}

func startEgress(t *testing.T, args ...string) *egressRig {
	t.Helper()
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	pubFile := filepath.Join(t.TempDir(), "agent.pub.pem")
	if err := os.WriteFile(pubFile, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}

	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ns := &dns.Server{PacketConn: pc, Handler: dns.HandlerFunc(func(w dns.ResponseWriter, q *dns.Msg) {
		m := new(dns.Msg)
		m.SetReply(q)
		m.Answer = append(m.Answer, &dns.A{Hdr: dns.RR_Header{Name: q.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60}, A: net.ParseIP(upstreamIP)})
		_ = w.WriteMsg(m)
	})}
	go func() { _ = ns.ActivateAndServe() }()
	t.Cleanup(func() { _ = ns.Shutdown() })

	fs := flag.NewFlagSet("egress", flag.ContinueOnError)
	o := registerPlaneOptions(fs)
	// Not transparent: loopback has no SO_ORIGINAL_DST (the dev cell runs
	// the same way).
	base := []string{"-agent-pub", pubFile, "-upstream-dns", pc.LocalAddr().String(), "-transparent=false"}
	if err := fs.Parse(append(base, args...)); err != nil {
		t.Fatal(err)
	}
	logs := &bytes.Buffer{}
	d, err := newDataPlane(o, slog.New(slog.NewJSONHandler(logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = d.proxy.Serve(ctx, l, 443, true) }()
	hl, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = d.proxy.Serve(ctx, hl, 80, false) }()
	return &egressRig{d: d, key: key, logs: logs, tls: l.Addr().String(), http: hl.Addr().String()}
}

// push sends the agent's signed policy to the control handler, as the cell
// does; it returns the status and body.
func (r *egressRig) push(t *testing.T, pol policy.ClaimPolicy) (int, string) {
	t.Helper()
	signed, err := policy.Sign(r.key, pol)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(signed)
	rec := httptest.NewRecorder()
	r.d.control.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/v1/policy", bytes.NewReader(body)))
	return rec.Code, rec.Body.String()
}

func credentialedPolicy() policy.ClaimPolicy {
	return policy.ClaimPolicy{
		ClaimID: "claim-1", OrgID: "org-a", Sources: []string{"127.0.0.1"}, Phase: policy.PhaseTest,
		Allow: []string{secretHost}, CredentialHosts: []string{secretHost}, ExpiresAt: time.Now().Add(time.Hour),
	}
}

// hello starts a TLS handshake for host through the proxy; the handshake
// itself never completes (the fake injector does not answer it).
func (r *egressRig) hello(t *testing.T, host string) {
	t.Helper()
	c, err := net.Dial("tcp4", r.tls)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	go func() {
		_ = tls.Client(c, &tls.Config{ServerName: host, InsecureSkipVerify: true}).Handshake() //nolint:gosec // G402: the handshake only carries the SNI to the proxy; nothing is verified or sent
	}()
}

func (r *egressRig) refusals() []string {
	var out []string
	for _, e := range r.d.proxy.Events.After(context.Background(), 0, 0) {
		out = append(out, e.Host+" "+e.Reason)
	}
	return out
}

// A secret's host reaches the injector the egress binary is given. On the
// dev cell (2026-11-13) cmd/egress built its proxy with no injector address
// and had no flag for one, so every credentialed host was refused with
// credential_host_needs_injector; the end-to-end tests set
// Proxy.InjectorAddr in process and never saw it.
func TestACredentialedHostIsRelayedToTheInjectorTheEgressIsGiven(t *testing.T) {
	inj, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = inj.Close() })
	type relayed struct {
		line  string
		first byte
	}
	got := make(chan relayed, 1)
	go func() {
		c, err := inj.Accept()
		if err != nil {
			return
		}
		defer func() { _ = c.Close() }()
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		br := bufio.NewReader(c)
		line, _ := br.ReadString('\n')
		first, _ := br.ReadByte()
		got <- relayed{line, first}
	}()

	r := startEgress(t, "-injector-addr", inj.Addr().String())
	if code, body := r.push(t, credentialedPolicy()); code != http.StatusNoContent {
		t.Fatalf("the credentialed policy was refused: %d %s", code, body)
	}
	r.hello(t, secretHost)
	select {
	case g := <-got:
		// The VM's address and the destination the proxy validated, then
		// the ClientHello replayed (a TLS handshake record).
		if !strings.HasPrefix(g.line, "PROXY TCP4 127.0.0.1 "+upstreamIP+" ") || !strings.HasSuffix(g.line, " 443\r\n") || g.first != 0x16 {
			t.Fatalf("the injector got %q then %#x", g.line, g.first)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("nothing reached the injector; the proxy refused %v", r.refusals())
	}
}

// Without an injector the egress says so: an alarm at startup, and a policy
// that names a credentialed host is refused at the control port with the
// reason, which the cell turns into the claim's egress_policy blocker. It
// used to take the policy and refuse each request to that host
// (credential_host_needs_injector) with nothing else to see.
func TestAnEgressWithoutAnInjectorRefusesACredentialedPolicyAndSaysWhy(t *testing.T) {
	r := startEgress(t)
	if !strings.Contains(r.logs.String(), `"msg":"egress.injector.unconfigured","alarm":true`) {
		t.Fatalf("no startup alarm: %s", r.logs)
	}
	code, body := r.push(t, credentialedPolicy())
	if code != http.StatusUnprocessableEntity || !strings.Contains(body, "-injector-addr") || !strings.Contains(body, secretHost) {
		t.Fatalf("a credentialed policy on an egress with no injector: %d %q", code, body)
	}
	if _, ok := r.d.store.ForClaim("claim-1"); ok {
		t.Fatal("the refused policy was stored")
	}
	if !strings.Contains(r.logs.String(), `"msg":"egress.policy.refused","alarm":true`) {
		t.Fatalf("no alarm for the refused policy: %s", r.logs)
	}
	// A policy with no credentialed host is the egress's ordinary work.
	plain := credentialedPolicy()
	plain.CredentialHosts = nil
	if code, body := r.push(t, plain); code != http.StatusNoContent {
		t.Fatalf("a policy with no credentialed host: %d %s", code, body)
	}
}

// A secret's placeholder sent over plain HTTP is refused and raised on the
// control port's alert feed, which the cell agent reads to mark the claim
// compromised. The end-to-end test wires Proxy.OnPlaceholderLeak and the
// feed in process; this is the binary's own wiring of both.
func TestAPlaceholderOverPlainHTTPIsRefusedAndRaisedOnTheAlertFeed(t *testing.T) {
	r := startEgress(t, "-injector-addr", "127.0.0.1:1")
	placeholder, err := policy.NewPlaceholder()
	if err != nil {
		t.Fatal(err)
	}
	pol := credentialedPolicy()
	pol.Allow = append(pol.Allow, "plain.example")
	pol.Secrets = []policy.Secret{{ID: "npm_token", Placeholder: placeholder, Hosts: []string{secretHost}}}
	if code, body := r.push(t, pol); code != http.StatusNoContent {
		t.Fatalf("policy: %d %s", code, body)
	}
	c, err := net.Dial("tcp4", r.http)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	_, _ = io.WriteString(c, "GET / HTTP/1.1\r\nHost: plain.example\r\nX-Token: "+placeholder+"\r\n\r\n")
	_, _ = io.Copy(io.Discard, c) // the proxy closes it unanswered

	rec := httptest.NewRecorder()
	r.d.control.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/alerts?after=0&wait=2s", nil))
	var alerts []struct{ ClaimID, Host, Kind string }
	if err := json.Unmarshal(rec.Body.Bytes(), &alerts); err != nil || len(alerts) != 1 {
		t.Fatalf("the alert feed: %d %s", rec.Code, rec.Body)
	}
	if a := alerts[0]; a.ClaimID != "claim-1" || a.Host != "plain.example" || a.Kind != "placeholder_leak" {
		t.Fatalf("alert %+v", a)
	}
	if strings.Contains(r.logs.String(), placeholder) {
		t.Fatal("the placeholder is in the egress log")
	}
}

// The address is checked at startup, not at the first secret.
func TestAnInjectorAddressWithoutAPortStopsTheEgressAtStartup(t *testing.T) {
	for _, bad := range []string{"kodus-injector", "10.0.0.3:", ":8443", "10.0.0.3:https"} {
		fs := flag.NewFlagSet("egress", flag.ContinueOnError)
		fs.SetOutput(io.Discard)
		o := registerPlaneOptions(fs)
		if err := fs.Parse([]string{"-agent-pub", "/nonexistent", "-injector-addr", bad}); err != nil {
			t.Fatal(err)
		}
		if _, err := newDataPlane(o, slog.New(slog.DiscardHandler)); err == nil || !strings.Contains(err.Error(), "injector-addr") {
			t.Errorf("-injector-addr %q: %v", bad, err)
		}
	}
}

func TestMirrorPublicURLIsTheMirrorNameAtTheListenPort(t *testing.T) {
	u, err := mirrorPublicURL("", ":8080")
	if err != nil || u.String() != "http://mirror.cell.internal:8080" {
		t.Fatalf("%v %v", u, err)
	}
	u, err = mirrorPublicURL("http://mirror.example:9000", ":8080")
	if err != nil || u.String() != "http://mirror.example:9000" {
		t.Fatalf("%v %v", u, err)
	}
	if _, err := mirrorPublicURL("", "no-port"); err == nil {
		t.Fatal("a listen address without a port")
	}
}

// The operator's -deny-hosts beats a policy that allows the name, at the
// proxy and at the resolver this binary runs beside it, and the push answer
// carries the list's fingerprint, which the cell compares with the
// standalone resolver's (control.ErrDenyListsDiffer).
func TestTheOperatorListIsDeniedByBothProxyAndResolver(t *testing.T) {
	r := startEgress(t, "-deny-hosts", ".corp.example")
	pol := credentialedPolicy()
	pol.CredentialHosts = nil
	pol.Allow = []string{"git.corp.example", "plain.example"}
	signed, err := policy.Sign(r.key, pol)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(signed)
	rec := httptest.NewRecorder()
	r.d.control.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/v1/policy", bytes.NewReader(body)))
	want, _ := netguard.ParseDenyList(".corp.example", nil)
	if rec.Code != http.StatusNoContent || rec.Header().Get(control.DenyFingerprintHeader) != want.Fingerprint() {
		t.Fatalf("push: %d, fingerprint %q, want %q", rec.Code, rec.Header().Get(control.DenyFingerprintHeader), want.Fingerprint())
	}

	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ns := &dns.Server{PacketConn: pc, Handler: r.d.dns}
	go func() { _ = ns.ActivateAndServe() }()
	t.Cleanup(func() { _ = ns.Shutdown() })
	ask := func(name string) int {
		m := new(dns.Msg)
		m.SetQuestion(dns.Fqdn(name), dns.TypeA)
		resp, _, err := (&dns.Client{Timeout: 2 * time.Second}).Exchange(m, pc.LocalAddr().String())
		if err != nil {
			t.Fatal(err)
		}
		return resp.Rcode
	}
	if rc := ask("git.corp.example"); rc != dns.RcodeNameError {
		t.Fatalf("the resolver answered an operator-denied name: rcode %s", dns.RcodeToString[rc])
	}
	if rc := ask("plain.example"); rc != dns.RcodeSuccess {
		t.Fatalf("the resolver refused an allowed name: rcode %s", dns.RcodeToString[rc])
	}

	r.hello(t, "git.corp.example")
	var got []string
	for _, e := range r.d.proxy.Events.After(context.Background(), 0, 5*time.Second) {
		got = append(got, e.Host+" "+e.Reason)
	}
	if !slices.Contains(got, "git.corp.example denied") {
		t.Fatalf("the proxy did not deny an operator-denied name: %v", got)
	}
}
