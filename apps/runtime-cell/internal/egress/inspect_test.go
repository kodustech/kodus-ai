package egress

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// inspectRig is the rig with registry.example on the inspected tier and a
// fake injector that records the PROXY line it got.
type inspectRig struct {
	*rig
	injected chan string
}

func newInspectRig(t *testing.T, inspectSources []string) *inspectRig {
	t.Helper()
	inj, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { inj.Close() })
	got := make(chan string, 4)
	go func() {
		for {
			c, err := inj.Accept()
			if err != nil {
				return
			}
			line, _ := bufio.NewReader(c).ReadString('\n')
			got <- strings.TrimSpace(line)
			c.Close()
		}
	}()
	injAddr := inj.Addr().String()
	r := newRig(t, nil, func(p *Proxy) {
		p.InjectorAddr = injAddr
		upstream := p.Dial
		p.Dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
			if addr == injAddr {
				return (&net.Dialer{}).DialContext(ctx, network, addr)
			}
			return upstream(ctx, network, addr)
		}
	})
	pol, _ := r.store.ForClaim("claim-1")
	pol.Inspected = []policy.InspectRule{{Host: "registry.example", Paths: []string{"/pkg/"}}}
	pol.InspectSources = inspectSources
	pol.IssuedAt = time.Now()
	if err := r.store.Put(pol); err != nil {
		t.Fatal(err)
	}
	return &inspectRig{rig: r, injected: got}
}

func (r *inspectRig) plain(t *testing.T, method, host, path string, body string) (string, error) {
	t.Helper()
	c, err := net.DialTimeout("tcp4", r.proxyHTTP, 2*time.Second)
	if err != nil {
		return "", err
	}
	defer c.Close()
	fmt.Fprintf(c, "%s %s HTTP/1.1\r\nHost: %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", method, path, host, len(body), body)
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b), nil
}

// S-56 at the proxy: TLS to an inspected host from a machine that trusts the
// cell CA goes to the injector, never straight out.
func TestS56InspectedHostOverTLSGoesToTheInjector(t *testing.T) {
	r := newInspectRig(t, []string{"127.0.0.1"})
	_, _ = r.tlsGet("registry.example")
	select {
	case line := <-r.injected:
		if !strings.HasPrefix(line, "PROXY TCP4 127.0.0.1 127.0.0.1 ") {
			t.Fatalf("PROXY line %q", line)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the inspected host went straight out")
	}
	if r.proxy.Metrics.InspectBypassed() != 0 {
		t.Fatal("counted as bypassed")
	}
}

// bun's TLS client (BoringSSL) sends a GREASE encrypted_client_hello on every
// connection, bun install included. To an inspected host the cell ends TLS
// itself: the injector answers for the outer SNI and dials that host on its
// own, so a hidden inner name reaches nothing. The hello goes to the
// injector instead of being refused as ECH.
func TestAClientHelloWithECHToAnInspectedHostGoesToTheInjector(t *testing.T) {
	r := newInspectRig(t, []string{"127.0.0.1"})
	c, err := net.DialTimeout("tcp4", r.proxyTLS, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = c.Write(clientHelloWithECH(t, "registry.example"))
	select {
	case line := <-r.injected:
		if !strings.HasPrefix(line, "PROXY TCP4 127.0.0.1 127.0.0.1 ") {
			t.Fatalf("PROXY line %q", line)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("the ECH hello to an inspected host did not reach the injector (last reason %q)", r.lastReason(t))
	}
}

// From a source that does not trust the cell CA (the image builder) the
// injector's leaf would be refused: the connection stays SNI passthrough
// and is counted, the gap docs/runtime/egress-allowlist.md names.
func TestInspectedHostFromAnUntrustedSourceIsPassthroughAndCounted(t *testing.T) {
	r := newInspectRig(t, nil)
	body, err := r.tlsGet("registry.example")
	if err != nil || body != "upstream registry.example" {
		t.Fatalf("%q %v", body, err)
	}
	if r.proxy.Metrics.InspectBypassed() != 1 {
		t.Fatalf("bypassed %d", r.proxy.Metrics.InspectBypassed())
	}
}

// S-53/S-56 over plain HTTP: the proxy reads the request from every source;
// a write or a path off the rule never leaves.
func TestS56PlainHTTPInspectedRequestsAreCheckedByTheProxy(t *testing.T) {
	r := newInspectRig(t, nil)
	if body, err := r.plain(t, "GET", "registry.example", "/pkg/a.tgz", ""); err != nil || body != "plain registry.example" {
		t.Fatalf("GET under the path: %q %v", body, err)
	}
	for _, c := range []struct{ method, path, body, reason string }{
		{"PUT", "/pkg/a", "{}", policy.InspectMethod},
		{"POST", "/pkg/a", "x", policy.InspectMethod},
		{"GET", "/other", "", policy.InspectPath},
		{"GET", "/pkg/../other", "", policy.InspectPath},
		{"GET", "/pkg/a", "data", policy.InspectBody},
	} {
		before := r.plainRequests.Load()
		if _, err := r.plain(t, c.method, "registry.example", c.path, c.body); err == nil {
			t.Fatalf("%s %s went through", c.method, c.path)
		}
		if got := r.lastReason(t); got != c.reason {
			t.Fatalf("%s %s: reason %s, want %s", c.method, c.path, got, c.reason)
		}
		if r.plainRequests.Load() != before {
			t.Fatalf("%s %s reached the upstream", c.method, c.path)
		}
	}
}

// A live passthrough connection to a host that the new policy inspects is
// cut: its next connection takes the injector.
func TestLiveConnectionIsCutWhenItsHostBecomesInspected(t *testing.T) {
	r := newRig(t, nil)
	c := r.keptConn(t, "registry.example")
	deadline := time.Now().Add(2 * time.Second)
	for r.proxy.LiveConnections("claim-1") != 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	pol, _ := r.store.ForClaim("claim-1")
	pol.Inspected = []policy.InspectRule{{Host: "registry.example", Paths: []string{"/"}}}
	pol.InspectSources, pol.IssuedAt = []string{"127.0.0.1"}, time.Now()
	if err := r.store.Put(pol); err != nil {
		t.Fatal(err)
	}
	r.proxy.Revalidate("claim-1")
	waitClosed(t, c)
}

// A recommended host that takes writes (github.com) is never SNI passthrough
// from a machine the cell cannot inspect (the image builder): it is refused.
// Before the flag, the builder reached it as plain passthrough once the
// recommended list put it on every claim.
func TestARefuseUntrustedHostIsRefusedFromAnUntrustedSource(t *testing.T) {
	r := newInspectRig(t, nil)
	pol, _ := r.store.ForClaim("claim-1")
	pol.Inspected[0].RefuseUntrusted = true
	pol.IssuedAt = time.Now()
	if err := r.store.Put(pol); err != nil {
		t.Fatal(err)
	}
	if _, err := r.tlsGet("registry.example"); err == nil {
		t.Fatal("went out as passthrough")
	}
	if got := r.lastReason(t); got != "inspected_needs_trust" {
		t.Fatalf("reason %s", got)
	}
}
