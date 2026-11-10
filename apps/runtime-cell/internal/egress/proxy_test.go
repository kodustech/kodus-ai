package egress

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

type rig struct {
	proxyTLS  string
	proxyHTTP string
	events    *Events
	store     *policy.Store
	proxy     *Proxy // the TLS one
	answers   *netguard.Answers
	// plainRequests counts the requests the plain HTTP upstream served.
	plainRequests atomic.Int32
}

type rigOption func(*Proxy)

func newRig(t *testing.T, origDst func(net.Conn) (net.IP, int, error), opts ...rigOption) *rig {
	t.Helper()
	r := &rig{events: NewEvents(100), answers: netguard.NewAnswers(nil)}
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { _, _ = io.WriteString(w, "upstream "+req.Host) }))
	t.Cleanup(up.Close)
	upHTTP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.plainRequests.Add(1)
		_, _ = io.WriteString(w, "plain "+req.Host)
	}))
	t.Cleanup(upHTTP.Close)
	upAddr := strings.TrimPrefix(up.URL, "https://")
	upHTTPAddr := strings.TrimPrefix(upHTTP.URL, "http://")

	store := policy.NewStore(nil)
	if err := store.Put(policy.ClaimPolicy{
		ClaimID: "claim-1", OrgID: "org-a", Sources: []string{"127.0.0.1"}, Phase: policy.PhaseBuild,
		Allow:     []string{"registry.example", "api.openai.com", "dns.google", "metadata.attacker.example", "intranet.attacker.example"},
		ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	r.store = store
	// Allowed names whose DNS the PR author controls.
	answers := map[string]string{
		"registry.example":          "127.0.0.1",
		"metadata.attacker.example": "169.254.169.254",
		"intranet.attacker.example": "10.0.0.5",
	}
	resolve := func(_ context.Context, host string) ([]net.IP, error) {
		if ip, ok := answers[host]; ok {
			return []net.IP{net.ParseIP(ip)}, nil
		}
		return nil, fmt.Errorf("nxdomain")
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	// The test upstreams listen on loopback: the rig's cell owns 127/8.
	loopback, _ := netguard.ParseCIDRs("127.0.0.0/8")
	start := func(upstream string, tlsMode bool) (*Proxy, string) {
		// Dial goes to the test upstream whatever port the proxy chose.
		dial := func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, upstream)
		}
		p := &Proxy{Policies: store, Events: r.events, Resolve: resolve, Answers: r.answers, OriginalDst: origDst, Dial: dial, InternalCIDRs: loopback}
		for _, o := range opts {
			o(p)
		}
		l, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		go func() { _ = p.Serve(ctx, l, 443, tlsMode) }()
		return p, l.Addr().String()
	}
	r.proxy, r.proxyTLS = start(upAddr, true)
	_, r.proxyHTTP = start(upHTTPAddr, false)
	return r
}

func (r *rig) tlsGet(sni string) (string, error) {
	c, err := tls.DialWithDialer(&net.Dialer{Timeout: 2 * time.Second}, "tcp4", r.proxyTLS, &tls.Config{ServerName: sni, InsecureSkipVerify: true})
	if err != nil {
		return "", err
	}
	defer c.Close()
	fmt.Fprintf(c, "GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", sni)
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		return "", err
	}
	b, _ := io.ReadAll(resp.Body)
	return string(b), nil
}

func (r *rig) lastReason(t *testing.T) string {
	t.Helper()
	evs := r.events.After(context.Background(), 0, time.Second)
	if len(evs) == 0 {
		t.Fatal("no egress.blocked event")
	}
	return evs[len(evs)-1].Reason
}

func TestAllowedHostPassesWithoutOpeningTLS(t *testing.T) {
	r := newRig(t, nil)
	body, err := r.tlsGet("registry.example")
	if err != nil || body != "upstream registry.example" {
		t.Fatalf("%q %v", body, err)
	}
	if evs := r.events.After(context.Background(), 0, 0); len(evs) != 0 {
		t.Fatalf("events %+v", evs)
	}
}

// S-03: every way out that is not an exact allowed host is refused and
// becomes an event.
func TestS03EgressRefusals(t *testing.T) {
	cases := []struct {
		name, sni, reason string
	}{
		{"random subdomain", "x7q2.registry.example", "not_allowed"},
		{"llm api even when allowlisted", "api.openai.com", "denied"},
		{"DoH even when allowlisted", "dns.google", "denied"},
		{"generic storage", "bucket.s3.amazonaws.com", "denied"},
		{"tunnel", "abc.trycloudflare.com", "denied"},
		{"direct IP, no SNI", "", "no_host"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t, nil)
			if _, err := r.tlsGet(c.sni); err == nil {
				t.Fatal("connection went through")
			}
			if got := r.lastReason(t); got != c.reason {
				t.Fatalf("reason %s, want %s", got, c.reason)
			}
			ev := r.events.After(context.Background(), 0, 0)[0]
			if ev.ClaimID != "claim-1" || ev.Phase != "build" || ev.Port != 443 {
				t.Fatalf("event %+v", ev)
			}
		})
	}
}

func TestS03FrontingAndIPv6ByOriginalDst(t *testing.T) {
	r := newRig(t, func(net.Conn) (net.IP, int, error) { return net.ParseIP("10.9.9.9"), 443, nil })
	if _, err := r.tlsGet("registry.example"); err == nil {
		t.Fatal("fronted connection went through")
	}
	if got := r.lastReason(t); got != "ip_mismatch" {
		t.Fatal(got)
	}
	r = newRig(t, func(net.Conn) (net.IP, int, error) { return net.ParseIP("2001:db8::1"), 443, nil })
	if _, err := r.tlsGet("registry.example"); err == nil {
		t.Fatal("ipv6 went through")
	}
	if got := r.lastReason(t); got != "ipv6" {
		t.Fatal(got)
	}
	r = newRig(t, func(net.Conn) (net.IP, int, error) { return net.ParseIP("127.0.0.1"), 443, nil })
	if _, err := r.tlsGet("registry.example"); err != nil {
		t.Fatalf("matching original dst refused: %v", err)
	}
}

// An allowlisted name whose DNS points at the metadata service or inside the
// cell's network is refused, and a transparent proxy that cannot read the
// original destination fails closed.
func TestAllowedNameResolvingInsideIsRefused(t *testing.T) {
	for host, reason := range map[string]string{
		"metadata.attacker.example": "link_local",
		"intranet.attacker.example": "internal_address",
	} {
		t.Run(host, func(t *testing.T) {
			r := newRig(t, nil)
			if _, err := r.tlsGet(host); err == nil {
				t.Fatal("connection went through")
			}
			if got := r.lastReason(t); got != reason {
				t.Fatalf("reason %s, want %s", got, reason)
			}
		})
	}
	r := newRig(t, func(net.Conn) (net.IP, int, error) { return nil, 0, fmt.Errorf("no SO_ORIGINAL_DST") })
	if _, err := r.tlsGet("registry.example"); err == nil {
		t.Fatal("went through without the original destination")
	}
	if got := r.lastReason(t); got != "no_original_dst" {
		t.Fatal(got)
	}
}

func TestUnknownSourceIsRefused(t *testing.T) {
	r := newRig(t, nil)
	r.store.Delete("claim-1")
	if _, err := r.tlsGet("registry.example"); err == nil {
		t.Fatal("no policy, still went through")
	}
	if got := r.lastReason(t); got != "unknown_source" {
		t.Fatal(got)
	}
}

func TestPlainHTTPByHost(t *testing.T) {
	r := newRig(t, nil)
	get := func(host string) (string, error) {
		c, err := net.DialTimeout("tcp4", r.proxyHTTP, 2*time.Second)
		if err != nil {
			return "", err
		}
		defer c.Close()
		fmt.Fprintf(c, "GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", host)
		resp, err := http.ReadResponse(bufio.NewReader(c), nil)
		if err != nil {
			return "", err
		}
		b, _ := io.ReadAll(resp.Body)
		return string(b), nil
	}
	if body, err := get("registry.example"); err != nil || body != "plain registry.example" {
		t.Fatalf("%q %v", body, err)
	}
	if _, err := get("pastebin.com"); err == nil {
		t.Fatal("pastebin went through")
	}
	if got := r.lastReason(t); got != "denied" {
		t.Fatal(got)
	}
}

func TestControlPortNeedsMTLSAndSignature(t *testing.T) {
	ca, _ := testpki.NewCA("cell-ca")
	serverCert, _ := ca.Issue("egress", time.Hour, "127.0.0.1")
	agentCert, _ := ca.Issue("cell-agent", time.Hour)
	other, _ := testpki.NewCA("other")
	strangerCert, _ := other.Issue("stranger", time.Hour)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	_, wrongPriv, _ := ed25519.GenerateKey(rand.Reader)

	ctl := &Control{Policies: policy.NewStore(nil), Events: NewEvents(10), AgentKey: pub}
	srv := httptest.NewUnstartedServer(ctl.Handler())
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientCAs: ca.Pool(), ClientAuth: tls.RequireAndVerifyClientCert, MinVersion: tls.VersionTLS13}
	srv.StartTLS()
	defer srv.Close()

	client := func(c *tls.Certificate) *http.Client {
		cfg := &tls.Config{RootCAs: ca.Pool()}
		if c != nil {
			cfg.Certificates = []tls.Certificate{*c}
		}
		return &http.Client{Transport: &http.Transport{TLSClientConfig: cfg}, Timeout: 2 * time.Second}
	}
	pol := policy.ClaimPolicy{ClaimID: "claim-1", OrgID: "org-a", Sources: []string{"10.0.3.10"}, Phase: policy.PhaseTest, Allow: []string{"registry.example"}, ExpiresAt: time.Now().Add(time.Hour)}
	put := func(c *http.Client, key ed25519.PrivateKey) (int, error) {
		s, err := policy.Sign(key, pol)
		if err != nil {
			return 0, err
		}
		b, _ := json.Marshal(s)
		req, _ := http.NewRequest(http.MethodPut, srv.URL+"/v1/policy", bytes.NewReader(b))
		resp, err := c.Do(req)
		if err != nil {
			return 0, err
		}
		resp.Body.Close()
		return resp.StatusCode, nil
	}
	if _, err := put(client(nil), priv); err == nil {
		t.Fatal("control port accepted a client without certificate")
	}
	if _, err := put(client(&strangerCert), priv); err == nil {
		t.Fatal("control port accepted a certificate from another CA")
	}
	if code, err := put(client(&agentCert), wrongPriv); err != nil || code != http.StatusForbidden {
		t.Fatalf("wrong key: %d %v", code, err)
	}
	if code, err := put(client(&agentCert), priv); err != nil || code != http.StatusNoContent {
		t.Fatalf("good policy: %d %v", code, err)
	}
	if got := ctl.Policies.Claims(); len(got) != 1 {
		t.Fatal("policy not stored")
	}
	// A wildcard never gets signed, let alone stored.
	pol.Allow = []string{"*.example"}
	if _, err := policy.Sign(priv, pol); err == nil {
		t.Fatal("signed a wildcard")
	}
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/v1/policy/claim-1", nil)
	sig, at := control.SignRemoval(priv, "claim-1", time.Now())
	req.Header.Set(control.SignatureHeader, sig)
	req.Header.Set(control.SignedAtHeader, at)
	if resp, err := client(&agentCert).Do(req); err != nil || resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %v", err)
	}
	ctl.Events.Add(Event{Host: "x", Reason: "denied"})
	resp, err := client(&agentCert).Get(srv.URL + "/v1/events?after=0")
	if err != nil {
		t.Fatal(err)
	}
	var evs []Event
	_ = json.NewDecoder(resp.Body).Decode(&evs)
	if len(evs) != 1 || evs[0].Seq != 1 {
		t.Fatalf("events %+v", evs)
	}
}

// An operator's own deny entry beats a policy that allows the host.
func TestOperatorDenyBeatsThePolicy(t *testing.T) {
	deny, err := netguard.NewDenyList([]string{".attacker.example"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	r := newRig(t, nil, func(p *Proxy) { p.Deny = deny })
	if _, err := r.tlsGet("intranet.attacker.example"); err == nil {
		t.Fatal("connection went through")
	}
	if got := r.lastReason(t); got != "denied" {
		t.Fatalf("reason %s, want denied", got)
	}
}

// A probe round's outbound evidence reads the connections let through from
// their own log; the refusals' log (the failure bundle's) stays refusals only.
func TestAllowedConnectionIsRecordedApart(t *testing.T) {
	conns := NewEvents(100)
	r := newRig(t, nil, func(p *Proxy) { p.Connections = conns })
	if body, err := r.tlsGet("registry.example"); err != nil || body != "upstream registry.example" {
		t.Fatalf("%q %v", body, err)
	}
	got := conns.After(context.Background(), 0, time.Second)
	if len(got) != 1 || got[0].ClaimID != "claim-1" || got[0].Host != "registry.example" || got[0].Reason != "allowed" || got[0].At.IsZero() {
		t.Fatalf("connections %+v", got)
	}
	if evs := r.events.After(context.Background(), 0, 0); len(evs) != 0 {
		t.Fatalf("refusals %+v", evs)
	}
}
