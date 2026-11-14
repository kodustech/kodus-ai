package egress

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// A second request on a kept-alive plain HTTP connection names another
// Host: before, only the first was checked and the second reached the same
// address (a shared host or CDN serves it). Now one request per connection.
func TestPlainHTTPCarriesOneCheckedRequestPerConnection(t *testing.T) {
	r := newRig(t, nil)
	c, err := net.DialTimeout("tcp4", r.proxyHTTP, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fmt.Fprintf(c, "GET / HTTP/1.1\r\nHost: registry.example\r\n\r\nGET / HTTP/1.1\r\nHost: attacker.example\r\n\r\n")
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	all, _ := io.ReadAll(c)
	if !bytes.Contains(all, []byte("plain registry.example")) {
		t.Fatalf("first request not answered: %q", all)
	}
	if bytes.Contains(all, []byte("attacker.example")) || r.plainRequests.Load() != 1 {
		t.Fatalf("the second request went through (%d served): %q", r.plainRequests.Load(), all)
	}
	resp, err := http.ReadResponse(bufio.NewReader(bytes.NewReader(all)), nil)
	if err != nil || !resp.Close {
		t.Fatalf("the answer does not close the connection: %v %+v", err, resp)
	}
}

func TestPlainHTTPRequestBodyIsForwarded(t *testing.T) {
	r := newRig(t, nil)
	c, err := net.DialTimeout("tcp4", r.proxyHTTP, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	body := strings.Repeat("x", 200<<10) // longer than the head limit
	fmt.Fprintf(c, "POST / HTTP/1.1\r\nHost: registry.example\r\nContent-Length: %d\r\n\r\n%s", len(body), body)
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("%v %+v", err, resp)
	}
}

// Encrypted Client Hello puts the real name in an encrypted inner hello;
// the outer SNI the proxy reads is only a cover. Refused.
func TestClientHelloWithECHIsRefused(t *testing.T) {
	r := newRig(t, nil)
	hello := clientHelloWithECH(t, "registry.example")
	c, err := net.DialTimeout("tcp4", r.proxyTLS, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = c.Write(hello)
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _ = io.ReadAll(c)
	if got := r.lastReason(t); got != "ech" {
		t.Fatalf("reason %s, want ech", got)
	}
}

// clientHelloWithECH is a real ClientHello for sni with an outer
// encrypted_client_hello extension appended.
func clientHelloWithECH(t *testing.T, sni string) []byte {
	t.Helper()
	a, b := net.Pipe()
	go func() {
		_ = tls.Client(a, &tls.Config{ServerName: sni, InsecureSkipVerify: true}).Handshake()
	}()
	hdr := make([]byte, 5)
	if _, err := io.ReadFull(b, hdr); err != nil {
		t.Fatal(err)
	}
	body := make([]byte, binary.BigEndian.Uint16(hdr[3:5]))
	if _, err := io.ReadFull(b, body); err != nil {
		t.Fatal(err)
	}
	a.Close()
	b.Close()
	// body: handshake type (1), length (3), client_hello.
	ch := body[4:]
	off := 2 + 32
	off += 1 + int(ch[off])
	off += 2 + int(binary.BigEndian.Uint16(ch[off:]))
	off += 1 + int(ch[off])
	extLen := int(binary.BigEndian.Uint16(ch[off:]))
	// outer ECH: type 0, kdf 1, aead 1, config id 0, enc (empty), payload (1 byte)
	ech := []byte{0xfe, 0x0d, 0x00, 0x0a, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00}
	ech[3] = byte(len(ech) - 4)
	newCH := append(append([]byte{}, ch[:off]...), byte((extLen+len(ech))>>8), byte(extLen+len(ech)))
	newCH = append(newCH, ch[off+2:]...)
	newCH = append(newCH, ech...)
	hs := append([]byte{0x01, byte(len(newCH) >> 16), byte(len(newCH) >> 8), byte(len(newCH))}, newCH...)
	return append([]byte{0x16, hdr[1], hdr[2], byte(len(hs) >> 8), byte(len(hs))}, hs...)
}

// keptConn opens a TLS connection through the proxy and keeps it open.
func (r *rig) keptConn(t *testing.T, sni string) *tls.Conn {
	t.Helper()
	c, err := tls.DialWithDialer(&net.Dialer{Timeout: 2 * time.Second}, "tcp4", r.proxyTLS, &tls.Config{ServerName: sni, InsecureSkipVerify: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func waitClosed(t *testing.T, c net.Conn) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 1)
	_, err := c.Read(buf)
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("the connection is still open")
	}
}

// A connection opened under the build policy outlived the switch to the
// test policy: the proxy read the policy once, at accept.
func TestLiveConnectionIsCutWhenThePolicyNoLongerAllowsIt(t *testing.T) {
	r := newRig(t, nil)
	c := r.keptConn(t, "registry.example")
	deadline := time.Now().Add(2 * time.Second)
	for r.proxy.LiveConnections("claim-1") != 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	pol, _ := r.store.ForClaim("claim-1")
	pol.Phase, pol.Allow, pol.IssuedAt = policy.PhaseTest, []string{"other.example"}, time.Now()
	if err := r.store.Put(pol); err != nil {
		t.Fatal(err)
	}
	r.proxy.Revalidate("claim-1")
	waitClosed(t, c)
}

func TestLiveConnectionIsCutWhenTheClaimIsRemoved(t *testing.T) {
	r := newRig(t, nil)
	c := r.keptConn(t, "registry.example")
	r.store.Delete("claim-1")
	r.proxy.CloseClaim("claim-1")
	waitClosed(t, c)
}

func TestIdleConnectionIsClosed(t *testing.T) {
	r := newRig(t, nil, func(p *Proxy) { p.IdleTimeout = 200 * time.Millisecond })
	c := r.keptConn(t, "registry.example")
	waitClosed(t, c)
}

func TestConnectionEndsWithItsPolicy(t *testing.T) {
	r := newRig(t, nil)
	pol, _ := r.store.ForClaim("claim-1")
	pol.ExpiresAt, pol.IssuedAt = time.Now().Add(300*time.Millisecond), time.Now()
	_ = r.store.Put(pol)
	c := r.keptConn(t, "registry.example")
	waitClosed(t, c)
}

func TestConnectionsPerSourceAreBounded(t *testing.T) {
	r := newRig(t, nil, func(p *Proxy) { p.MaxConnsPerSource = 1 })
	_ = r.keptConn(t, "registry.example")
	if _, err := r.tlsGet("registry.example"); err == nil {
		t.Fatal("second connection went through")
	}
	if got := r.lastReason(t); got != "too_many_connections" {
		t.Fatal(got)
	}
}

// A CDN that rotates its answers: the VM got 127.0.0.1 from the cell
// resolver, the proxy's own lookup now says 10.9.9.9 (refused anyway as
// internal). The resolver's answer counts, so the connection goes through.
func TestAddressTheResolverHandedTheClaimIsAccepted(t *testing.T) {
	r := newRig(t, func(net.Conn) (net.IP, int, error) { return net.ParseIP("127.0.0.1"), 443, nil })
	r.proxy.Resolve = func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("192.0.2.77")}, nil }
	if _, err := r.tlsGet("registry.example"); err == nil {
		t.Fatal("without the resolver's answer the connection should be ip_mismatch")
	}
	r.answers.Record("claim-1", "registry.example", []net.IP{net.ParseIP("127.0.0.1")}, time.Minute)
	if body, err := r.tlsGet("registry.example"); err != nil || body != "upstream registry.example" {
		t.Fatalf("handed address refused: %q %v", body, err)
	}
	// The answer is the claim's own: an address handed for another name is
	// still a mismatch.
	r.answers.Record("claim-1", "other.example", []net.IP{net.ParseIP("192.0.2.9")}, time.Minute)
}

func TestTrailingDotIPIsNotAHostName(t *testing.T) {
	r := newRig(t, nil)
	c, err := net.DialTimeout("tcp4", r.proxyHTTP, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fmt.Fprintf(c, "GET / HTTP/1.1\r\nHost: 127.0.0.1.\r\n\r\n")
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if b, _ := io.ReadAll(c); len(b) != 0 {
		t.Fatalf("answered: %q", b)
	}
	if got := r.lastReason(t); got != "bad_host" {
		t.Fatal(got)
	}
}

func TestDenialsAreCountedAndAllowedAreLogged(t *testing.T) {
	r := newRig(t, nil)
	_, _ = r.tlsGet("pastebin.com")
	_, _ = r.tlsGet("pastebin.com")
	if n := r.proxy.Metrics.Denied("denied"); n != 2 {
		t.Fatalf("denied counter %d", n)
	}
	rec := httptest.NewRecorder()
	r.proxy.Metrics.ServeHTTP(rec, nil)
	if !strings.Contains(rec.Body.String(), `kodus_egress_denied_total{reason="denied"} 2`) {
		t.Fatal(rec.Body.String())
	}
}
