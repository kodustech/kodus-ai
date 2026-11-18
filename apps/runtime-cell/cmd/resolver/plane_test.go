package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/miekg/dns"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
)

// The standalone resolver reads the operator's list with the proxy's flags
// (netguard.RegisterDenyFlags), denies it over a policy that allows the
// name, and reports its fingerprint on the push answer, which the cell
// compares with the proxy's (control.ErrDenyListsDiffer).
func TestTheStandaloneResolverDeniesTheOperatorListAndReportsIt(t *testing.T) {
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	pubFile := filepath.Join(t.TempDir(), "agent.pub.pem")
	if err := os.WriteFile(pubFile, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	up, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	upstream := &dns.Server{PacketConn: up, Handler: dns.HandlerFunc(func(w dns.ResponseWriter, q *dns.Msg) {
		m := new(dns.Msg)
		m.SetReply(q)
		m.Answer = append(m.Answer, &dns.A{Hdr: dns.RR_Header{Name: q.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60}, A: net.ParseIP("203.0.113.7")})
		_ = w.WriteMsg(m)
	})}
	go func() { _ = upstream.ActivateAndServe() }()
	t.Cleanup(func() { _ = upstream.Shutdown() })

	fs := flag.NewFlagSet("resolver", flag.ContinueOnError)
	o := registerResolverOptions(fs)
	if err := fs.Parse([]string{"-agent-pub", pubFile, "-upstream", up.LocalAddr().String(), "-deny-hosts", ".corp.example"}); err != nil {
		t.Fatal(err)
	}
	p, err := newResolverPlane(o, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}

	signed, err := policy.Sign(key, policy.ClaimPolicy{
		ClaimID: "claim-1", OrgID: "o", Sources: []string{"127.0.0.1"}, Phase: policy.PhaseTest,
		Allow: []string{"git.corp.example", "plain.example"}, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(signed)
	rec := httptest.NewRecorder()
	p.control.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/v1/policy", bytes.NewReader(body)))
	want, _ := netguard.ParseDenyList(".corp.example", nil)
	if rec.Code != http.StatusNoContent || rec.Header().Get(control.DenyFingerprintHeader) != want.Fingerprint() {
		t.Fatalf("push: %d, fingerprint %q, want %q", rec.Code, rec.Header().Get(control.DenyFingerprintHeader), want.Fingerprint())
	}

	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ns := &dns.Server{PacketConn: pc, Handler: p.dns}
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
		t.Fatalf("an operator-denied name answered: rcode %s", dns.RcodeToString[rc])
	}
	if rc := ask("plain.example"); rc != dns.RcodeSuccess {
		t.Fatalf("an allowed name refused: rcode %s", dns.RcodeToString[rc])
	}
}
