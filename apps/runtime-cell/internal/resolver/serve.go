package resolver

import (
	"context"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/miekg/dns"
)

// dnsShutdownGrace is what the queries in flight get once a stop begins.
const dnsShutdownGrace = 5 * time.Second

// ListenAndServe serves h on addr over network (udp or tcp) until ctx
// ends, then stops taking queries, waits for the ones in flight up to
// dnsShutdownGrace and returns. A socket it cannot open is its error.
func ListenAndServe(ctx context.Context, addr, network string, h dns.Handler) error {
	s := &dns.Server{Net: network, Handler: h}
	var lc net.ListenConfig
	var sock io.Closer
	switch network {
	case "udp":
		pc, err := lc.ListenPacket(ctx, "udp", addr)
		if err != nil {
			return err
		}
		s.PacketConn, sock = pc, pc
	case "tcp":
		l, err := lc.Listen(ctx, "tcp", addr)
		if err != nil {
			return err
		}
		s.Listener, sock = l, l
	default:
		return fmt.Errorf("resolver: network %q is neither udp nor tcp", network)
	}
	var serveErr error
	served := make(chan struct{})
	go func() {
		defer close(served)
		serveErr = s.ActivateAndServe()
	}()
	select {
	case <-served:
		_ = sock.Close()
		return serveErr
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), dnsShutdownGrace)
	defer cancel()
	_ = s.ShutdownContext(sctx) // "not started" when the stop came first
	_ = sock.Close()            // which ends a server that had not started yet
	<-served                    // its error is the closed socket's: the stop asked for it
	return nil
}
