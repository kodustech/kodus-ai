package observersrv

import (
	"bytes"
	"context"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// The bridge carries one connection between its stdin and stdout and the
// observer's loopback listener, both ways, and ends when the server closes
// it.
func TestTheBridgeCarriesOneConnectionToTheLoopbackListener(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	served := make(chan string, 1)
	go func() {
		c, err := l.Accept()
		if err != nil {
			served <- err.Error()
			return
		}
		defer func() { _ = c.Close() }()
		buf := make([]byte, 5)
		_, _ = io.ReadFull(c, buf)
		_, _ = c.Write([]byte("pong:" + string(buf)))
		served <- string(buf)
	}()
	in, inW := io.Pipe()
	var out bytes.Buffer
	done := make(chan error, 1)
	go func() { done <- Bridge(context.Background(), l.Addr().String(), in, &out) }()
	if _, err := inW.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the bridge did not end when the server closed the connection")
	}
	if got := <-served; got != "hello" {
		t.Errorf("the server read %q", got)
	}
	if out.String() != "pong:hello" {
		t.Errorf("the bridge wrote %q", out.String())
	}
}

// The bridge dials loopback only: it is the cell's way into its own
// observer, never a relay to the claim's network.
func TestTheBridgeDialsLoopbackOnly(t *testing.T) {
	for _, addr := range []string{"10.0.0.1:7443", "example.com:7443", "localhost:7443", "7443", ""} {
		err := Bridge(context.Background(), addr, io.NopCloser(strings.NewReader("")), io.Discard)
		if err == nil || !strings.Contains(err.Error(), "loopback") {
			t.Errorf("%q: %v", addr, err)
		}
	}
}
