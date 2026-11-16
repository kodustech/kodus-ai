package resolver

import (
	"context"
	"testing"
	"time"

	"github.com/miekg/dns"
)

// A stopping resolver returns once its context ends, on both networks,
// whether or not its server had started yet.
func TestListenAndServeReturnsOnceItsContextEnds(t *testing.T) {
	for _, network := range []string{"udp", "tcp"} {
		for _, settle := range []bool{false, true} {
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() {
				done <- ListenAndServe(ctx, "127.0.0.1:0", network, dns.HandlerFunc(func(dns.ResponseWriter, *dns.Msg) {}))
			}()
			if settle {
				time.Sleep(10 * time.Millisecond) // let the server start: the other branch stops it first
			}
			cancel()
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("%s: %v", network, err)
				}
			case <-time.After(10 * time.Second):
				t.Fatalf("%s: the server outlived its context", network)
			}
		}
	}
}

func TestListenAndServeFailsOnASocketItCannotOpen(t *testing.T) {
	if err := ListenAndServe(context.Background(), "256.0.0.1:53", "udp", nil); err == nil {
		t.Fatal("a bad address served")
	}
	if err := ListenAndServe(context.Background(), "127.0.0.1:0", "sctp", nil); err == nil {
		t.Fatal("a bad network served")
	}
}
