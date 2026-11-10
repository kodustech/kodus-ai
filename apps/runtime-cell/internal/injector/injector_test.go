package injector

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/egress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

const (
	host   = "registry.private"
	secret = "Bearer kodus-test-token-6c1f9a2e7b"
	bait   = "AKIAKODUSBAIT7Q2X9Z"
)

// tap records every byte that crosses the proxy.
type tap struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

type tapConn struct {
	net.Conn
	t *tap
}

func (c tapConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	c.t.mu.Lock()
	c.t.buf.Write(b[:n])
	c.t.mu.Unlock()
	return n, err
}

func (c tapConn) Write(b []byte) (int, error) {
	c.t.mu.Lock()
	c.t.buf.Write(b)
	c.t.mu.Unlock()
	return c.Conn.Write(b)
}

func (c tapConn) CloseWrite() error {
	if cw, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return nil
}

type rig struct {
	vm       *http.Client
	proxyTap *tap
	alerts   chan Alert
	alertLog *eventlog.Log[Alert]
	seen     chan http.Header
	injAddr  string
	inj      *Injector
	// dialed are the addresses the injector dialed upstream.
	dialed chan string
}

func newRig(t *testing.T, opts ...func(*Injector)) *rig {
	t.Helper()
	cellCA, _ := testpki.NewCA("cell-ca")
	publicCA, _ := testpki.NewCA("public-ca")
	upCert, _ := publicCA.Issue(host, time.Hour, host)
	r := &rig{proxyTap: &tap{}, alerts: make(chan Alert, 8), seen: make(chan http.Header, 8), alertLog: eventlog.New[Alert](10), dialed: make(chan string, 16)}

	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.seen <- req.Header.Clone()
		switch req.URL.Path {
		case "/echo": // an upstream that reflects the request (S-50)
			w.Header().Set("X-Echo-Auth", req.Header.Get("Authorization"))
			_ = req.Header.Write(w)
		case "/echo-gzip": // reflects the request, gzipped when the client asks for it
			var buf bytes.Buffer
			_ = req.Header.Write(&buf)
			if strings.Contains(req.Header.Get("Accept-Encoding"), "gzip") {
				w.Header().Set("Content-Encoding", "gzip")
				zw := gzip.NewWriter(w)
				_, _ = zw.Write(buf.Bytes())
				_ = zw.Close()
				return
			}
			_, _ = w.Write(buf.Bytes())
		case "/always-gzip": // compresses unasked: the injector cannot mask it
			w.Header().Set("Content-Encoding", "br")
			_, _ = w.Write([]byte(req.Header.Get("Authorization")))
		case "/big":
			_, _ = io.WriteString(w, strings.Repeat("y", 4096))
		case "/artifact": // a package whose metadata embeds the token (S-28)
			_, _ = io.WriteString(w, `{"name":"pkg","_resolved":"https://u:`+strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")+`@registry.private/pkg.tgz"}`)
		default:
			b, _ := io.ReadAll(req.Body)
			_, _ = w.Write(b)
		}
	}))
	up.TLS = &tls.Config{Certificates: []tls.Certificate{upCert}}
	up.StartTLS()
	t.Cleanup(up.Close)
	upAddr := strings.TrimPrefix(up.URL, "https://")

	store := policy.NewStore(nil)
	if err := store.Put(policy.ClaimPolicy{ClaimID: "claim-1", OrgID: "org-a", Sources: []string{"127.0.0.1"}, Phase: policy.PhaseBuild,
		Allow: []string{host, "public.example"}, CredentialHosts: []string{host}, ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	vault := &MemoryVault{}
	vault.Put("org-a", "claim-1", host, Credential{Header: "Authorization", Value: secret, ExpiresAt: time.Now().Add(15 * time.Minute), Baits: []string{bait}})

	inj := &Injector{
		Policies: store, Vault: vault, CA: cellCA.Cert, CAKey: cellCA.Key, TrustedProxies: []string{"127.0.0.1"},
		UpstreamRoots: publicCA.Pool(), InternalCIDRs: loopbackNet(), Alerts: r.alertLog,
		// The rig's upstream listens on a test port: the dial records the
		// address the injector chose, then goes there.
		Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			r.dialed <- addr
			return (&net.Dialer{}).DialContext(ctx, network, upAddr)
		},
		OnAlert: func(a Alert) { r.alerts <- a },
	}
	for _, o := range opts {
		o(inj)
	}
	r.inj = inj
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	il, _ := net.Listen("tcp4", "127.0.0.1:0")
	r.injAddr = il.Addr().String()
	go func() { _ = inj.Serve(ctx, il) }()

	px := &egress.Proxy{
		Policies: store, Events: egress.NewEvents(10), InjectorAddr: r.injAddr, InternalCIDRs: loopbackNet(),
		Resolve: func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("127.0.0.1")}, nil },
		Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			c, err := (&net.Dialer{}).DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			return tapConn{Conn: c, t: r.proxyTap}, nil
		},
	}
	pl, _ := net.Listen("tcp4", "127.0.0.1:0")
	go func() { _ = px.Serve(ctx, pl, 443, true) }()

	// The VM: everything goes to the proxy; it trusts the cell CA (bake).
	r.vm = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: cellCA.Pool()},
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp4", pl.Addr().String())
		},
	}}
	return r
}

func noSecret(t *testing.T, where string, data []byte) {
	t.Helper()
	for _, s := range []string{secret, strings.TrimPrefix(secret, "Bearer "), bait} {
		for _, v := range redact.Variants(s) {
			if len(v) >= 6 && bytes.Contains(data, []byte(v)) {
				t.Fatalf("%s contains a variant of %q", where, s)
			}
		}
	}
}

// S-50: the VM reads the answer of a credentialed host whose upstream echoes
// the header; a compromised proxy looks at everything it carries.
func TestS50CredentialNeverReachesVMOrProxy(t *testing.T) {
	r := newRig(t)
	req, _ := http.NewRequest(http.MethodGet, "https://"+host+"/echo", nil)
	req.Header.Set("Authorization", "Bearer vm-chosen") // the VM cannot pick it
	resp, err := r.vm.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if got := (<-r.seen).Get("Authorization"); got != secret {
		t.Fatalf("upstream saw %q", got)
	}
	var head bytes.Buffer
	_ = resp.Header.Write(&head)
	noSecret(t, "VM response body", body)
	noSecret(t, "VM response headers", head.Bytes())
	if !strings.Contains(string(body), "***") {
		t.Fatalf("echo not masked: %s", body)
	}
	r.proxyTap.mu.Lock()
	defer r.proxyTap.mu.Unlock()
	if r.proxyTap.buf.Len() == 0 {
		t.Fatal("nothing crossed the proxy")
	}
	noSecret(t, "proxy traffic", r.proxyTap.buf.Bytes())
}

// S-50 with compression: the VM asks for gzip so the echo would come back
// compressed past the mask. The injector drops the VM's Accept-Encoding,
// masks the plain body, and refuses an encoding it cannot read.
func TestS50CompressedEchoIsMaskedOrRefused(t *testing.T) {
	r := newRig(t)
	raw := &http.Client{Timeout: 5 * time.Second, Transport: r.vm.Transport.(*http.Transport).Clone()}
	raw.Transport.(*http.Transport).DisableCompression = true

	req, _ := http.NewRequest(http.MethodGet, "https://"+host+"/echo-gzip", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	resp, err := raw.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	<-r.seen
	if ce := resp.Header.Get("Content-Encoding"); ce != "" {
		if zr, err := gzip.NewReader(bytes.NewReader(body)); err == nil {
			body, _ = io.ReadAll(zr)
		}
		t.Fatalf("VM got a %s body: %q", ce, body)
	}
	noSecret(t, "VM response body", body)
	if !strings.Contains(string(body), "***") {
		t.Fatalf("echo not masked: %s", body)
	}

	resp, err = raw.Get("https://" + host + "/always-gzip")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	<-r.seen
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status %d, want 502 for an encoding the mask cannot read", resp.StatusCode)
	}
	noSecret(t, "VM response body", body)
}

// S-29: the repo tries to send the bait out through the credentialed host.
func TestS29BaitExfiltrationAlertsAndStops(t *testing.T) {
	r := newRig(t)
	resp, err := r.vm.Post("https://"+host+"/upload?x=1", "text/plain", strings.NewReader("aws_key="+bait))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", resp.StatusCode)
	}
	select {
	case a := <-r.alerts:
		if a.Kind != "bait_exfiltration" || a.ClaimID != "claim-1" {
			t.Fatalf("alert %+v", a)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no alert")
	}
	select {
	case <-r.seen:
		t.Fatal("the bait reached the upstream")
	default:
	}
}

// S-28: a bake that downloads through the credentialed registry writes no
// trace of the credential or the bait on the image disk.
func TestS28BakeLeavesNoCredentialOnDisk(t *testing.T) {
	r := newRig(t)
	disk := t.TempDir()
	for i, path := range []string{"/artifact", "/echo"} {
		resp, err := r.vm.Get("https://" + host + path)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		<-r.seen
		_ = os.WriteFile(filepath.Join(disk, "layer"+string(rune('0'+i))), b, 0o644)
		var h bytes.Buffer
		_ = resp.Header.Write(&h)
		_ = os.WriteFile(filepath.Join(disk, "headers"+string(rune('0'+i))), h.Bytes(), 0o644)
	}
	_ = filepath.Walk(disk, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			b, _ := os.ReadFile(p)
			noSecret(t, p, b)
		}
		return nil
	})
}

func TestOnlyDeclaredHostsAndOnlyTheProxy(t *testing.T) {
	r := newRig(t)
	// A host on the allowlist without a declared credential never reaches
	// the injector's TLS: there is no leaf for it.
	conn, err := net.Dial("tcp4", r.injAddr)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(conn, "PROXY TCP4 127.0.0.1 127.0.0.1 1 443\r\n")
	tc := tls.Client(conn, &tls.Config{ServerName: "public.example", InsecureSkipVerify: true})
	if err := tc.Handshake(); err == nil {
		t.Fatal("injector served a host without a declared credential")
	}
	conn.Close()
	// A PROXY line naming a source with no policy gets nothing either.
	conn, _ = net.Dial("tcp4", r.injAddr)
	_, _ = io.WriteString(conn, "PROXY TCP4 10.9.9.9 127.0.0.1 1 443\r\n")
	tc = tls.Client(conn, &tls.Config{ServerName: host, InsecureSkipVerify: true})
	if err := tc.Handshake(); err == nil {
		t.Fatal("injector served an unknown source")
	}
	conn.Close()
}

// The rig's upstreams listen on loopback: its cell owns 127/8.
func loopbackNet() []*net.IPNet {
	n, _ := netguard.ParseCIDRs("127.0.0.0/8")
	return n
}

// The injector re-resolved the host with the system resolver, so a
// rebinding between the proxy's check and the injector's dial sent the
// credential wherever DNS said then. Now it dials the address the proxy
// validated, on 443, and nothing else.
func TestInjectorDialsOnlyTheAddressTheProxyValidated(t *testing.T) {
	r := newRig(t)
	resp, err := r.vm.Get("https://" + host + "/echo")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	<-r.seen
	if got := <-r.dialed; got != "127.0.0.1:443" {
		t.Fatalf("injector dialed %q, want the proxy's 127.0.0.1:443", got)
	}
}

// A PROXY line whose destination leads inside the cell (the metadata
// service) gets no credential, even from a trusted proxy.
func TestInjectorRefusesAnInternalDestination(t *testing.T) {
	r := newRig(t)
	conn, err := net.Dial("tcp4", r.injAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = io.WriteString(conn, "PROXY TCP4 127.0.0.1 169.254.169.254 1 443\r\n")
	tc := tls.Client(conn, &tls.Config{ServerName: host, InsecureSkipVerify: true})
	if err := tc.Handshake(); err == nil {
		t.Fatal("injector served a request bound for the metadata service")
	}
	select {
	case a := <-r.dialed:
		t.Fatalf("dialed %s", a)
	default:
	}
}

// Alerts reach the control port's log, not only a log line.
func TestAlertsAreServedForTheAgent(t *testing.T) {
	r := newRig(t)
	resp, err := r.vm.Post("https://"+host+"/upload", "text/plain", strings.NewReader(bait))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	<-r.alerts
	got := r.alertLog.After(context.Background(), 0, time.Second)
	if len(got) != 1 || got[0].Kind != AlertBaitExfiltration || got[0].Seq != 1 {
		t.Fatalf("alerts %+v", got)
	}
}

// A response past the cap reached the VM truncated, with the upstream's
// status, as if whole. Now the VM sees a broken response.
func TestResponsePastTheCapIsBrokenNotShort(t *testing.T) {
	r := newRig(t, func(in *Injector) { in.MaxResponse = 1024 })
	resp, err := r.vm.Get("https://" + host + "/big")
	if err == nil {
		_, err = io.ReadAll(resp.Body)
		resp.Body.Close()
	}
	<-r.seen
	if err == nil {
		t.Fatal("a cut response read as complete")
	}
}
