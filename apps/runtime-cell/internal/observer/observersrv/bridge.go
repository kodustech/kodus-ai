package observersrv

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

// bridgeDrain is how long the bridge waits for its stdin side to end once
// the server closed the connection.
const bridgeDrain = 5 * time.Second

// Bridge carries one connection of the cell to the observer's server at addr
// over in and out: on Kubernetes the observer serves on loopback only, and
// the cell reaches it through pods/exec, running `observer -stdio-bridge` per
// connection (k8ssandbox DialObserver). What the cell writes goes to the
// server, half-closed when in ends; what the server answers goes to out, and
// the bridge ends when the server closes the connection or ctx ends. addr
// must be a loopback address: the bridge never relays to the claim's network.
func Bridge(ctx context.Context, addr string, in io.ReadCloser, out io.Writer) error {
	host, _, err := net.SplitHostPort(addr)
	if ip := net.ParseIP(host); err != nil || ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("observersrv: the bridge dials a loopback address only, not %q", addr)
	}
	c, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("observersrv: bridge: %w", err)
	}
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	sent := make(chan struct{})
	go func() {
		defer close(sent)
		_, _ = io.Copy(c, in)
		if tc, ok := c.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
	}()
	_, err = io.Copy(out, c)
	_ = c.Close()
	_ = in.Close()
	select {
	case <-sent:
	case <-time.After(bridgeDrain):
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}
