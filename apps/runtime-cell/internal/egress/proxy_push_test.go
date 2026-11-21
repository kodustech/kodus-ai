package egress

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// narrow pushes a policy without registry.example, as the agent does: the
// store first, then Revalidate.
func (r *rig) narrow(t *testing.T) {
	t.Helper()
	pol, _ := r.store.ForClaim("claim-1")
	pol.Phase, pol.Allow, pol.IssuedAt = policy.PhaseTest, []string{"api.openai.com"}, time.Now()
	if err := r.store.Put(pol); err != nil {
		t.Error(err)
	}
	r.proxy.Revalidate("claim-1")
}

// heldGet sends a request over a connection the proxy accepted earlier and
// reports whether an answer came back.
func heldGet(raw net.Conn, sni string) error {
	c := tls.Client(raw, &tls.Config{ServerName: sni, InsecureSkipVerify: true}) //nolint:gosec // G402: the test upstream presents a self-signed cert
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprintf(c, "GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", sni)
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	return nil
}

// A connection accepted before a push that narrows the policy, whose hello
// arrives after it, is decided on the new policy. Before, the proxy read the
// policy at accept, and Revalidate never saw a connection not yet tracked.
func TestAPushBeforeTheHelloDecidesTheConnection(t *testing.T) {
	r := newRig(t, nil)
	raw, err := net.Dial("tcp4", r.proxyTLS)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	time.Sleep(100 * time.Millisecond) // the proxy accepted and waits for the hello
	r.narrow(t)
	if err := heldGet(raw, "registry.example"); err == nil {
		t.Fatal("the held connection went out under the old allowlist")
	}
	if n := r.proxy.LiveConnections("claim-1"); n != 0 {
		t.Fatalf("live %d", n)
	}
	if got := r.lastReason(t); got != "not_allowed" {
		t.Fatalf("reason %s", got)
	}
}

// A push that lands while the proxy dials (decided, not yet tracked) still
// reaches the connection: it is checked again once tracked.
func TestAPushDuringTheDialCutsTheConnection(t *testing.T) {
	var onDial atomic.Pointer[func()]
	r := newRig(t, nil, func(p *Proxy) {
		dial := p.Dial
		p.Dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
			if f := onDial.Swap(nil); f != nil {
				(*f)()
			}
			return dial(ctx, network, addr)
		}
	})
	push := func() { r.narrow(t) }
	onDial.Store(&push)
	if body, err := r.tlsGet("registry.example"); err == nil {
		t.Fatalf("went out after the push: %q", body)
	}
	if onDial.Load() != nil {
		t.Fatal("the dial hook did not run")
	}
	if n := r.proxy.LiveConnections("claim-1"); n != 0 {
		t.Fatalf("live %d", n)
	}
	if got := r.lastReason(t); got != "policy_changed" {
		t.Fatalf("reason %s", got)
	}
}

// A machine that leaves the claim's policy (an image builder after its
// build, a machine replaced on reset) loses its live connections, even to a
// host the claim still allows.
func TestLiveConnectionIsCutWhenItsSourceLeavesThePolicy(t *testing.T) {
	r := newRig(t, nil)
	c := r.keptConn(t, "registry.example")
	deadline := time.Now().Add(2 * time.Second)
	for r.proxy.LiveConnections("claim-1") != 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	pol, _ := r.store.ForClaim("claim-1")
	pol.Sources, pol.IssuedAt = []string{"127.0.0.2"}, time.Now()
	if err := r.store.Put(pol); err != nil {
		t.Fatal(err)
	}
	r.proxy.Revalidate("claim-1")
	waitClosed(t, c)
}

// A source that leaves the image builder's addresses but stays on the claim
// changes route class: its build-time connection is cut.
func TestLiveBuildConnectionIsCutWhenItsSourceStopsBuilding(t *testing.T) {
	r := newRig(t, nil)
	pol, _ := r.store.ForClaim("claim-1")
	pol.BuildSources, pol.BuildPassthrough, pol.IssuedAt = []string{"127.0.0.1"}, []string{"registry.example"}, time.Now()
	if err := r.store.Put(pol); err != nil {
		t.Fatal(err)
	}
	c := r.keptConn(t, "registry.example")
	deadline := time.Now().Add(2 * time.Second)
	for r.proxy.LiveConnections("claim-1") != 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	pol.BuildSources, pol.BuildPassthrough, pol.IssuedAt = nil, nil, time.Now()
	if err := r.store.Put(pol); err != nil {
		t.Fatal(err)
	}
	r.proxy.Revalidate("claim-1")
	waitClosed(t, c)
}

// A stopping proxy gives its connections DrainTimeout, then cuts them, and
// Serve returns only once every connection it accepted has ended: the
// process's stop is the proxy's, not the exit's.
func TestServeDrainsItsConnectionsOnStop(t *testing.T) {
	r := newRig(t, nil, func(p *Proxy) { p.DrainTimeout = 100 * time.Millisecond })
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	served := make(chan error, 1)
	go func() { served <- r.proxy.Serve(ctx, l, 443, true) }()
	c, err := tls.DialWithDialer(&net.Dialer{Timeout: 2 * time.Second}, "tcp4", l.Addr().String(), &tls.Config{ServerName: "registry.example", InsecureSkipVerify: true}) //nolint:gosec // G402: the test upstream presents a self-signed cert
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	// An accepted connection still waiting for its hello is drained too.
	held, err := net.Dial("tcp4", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	deadline := time.Now().Add(2 * time.Second)
	for r.proxy.LiveConnections("claim-1") != 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-served:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Serve did not return after its drain")
	}
	if n := r.proxy.LiveConnections("claim-1"); n != 0 {
		t.Fatalf("Serve returned with %d live connections", n)
	}
	waitClosed(t, c)
	waitClosed(t, held)
}
