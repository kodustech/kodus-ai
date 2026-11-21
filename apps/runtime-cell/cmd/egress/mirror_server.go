package main

import (
	"net"
	"net/http"
	"sync"
	"time"
)

const (
	// mirrorIdleTimeout closes a keep-alive connection with no request.
	mirrorIdleTimeout = time.Minute
	// mirrorConnsPerSource bounds what one machine holds open on the mirror
	// (npm opens about 15 sockets per host, a pull a few per layer).
	mirrorConnsPerSource = 128
)

// newMirrorServer is the mirror's server: it serves every claim network from
// the egress process every claim depends on, so a source past perSource
// open connections is closed at accept, and an idle keep-alive connection
// after idle. There is no ReadTimeout or WriteTimeout: a blob streams for as
// long as it takes, and once the request is read net/http cancels the
// handler's context on a read deadline, which would cut the stream.
func newMirrorServer(h http.Handler, l net.Listener, idle time.Duration, perSource int) (*http.Server, net.Listener) {
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: idle}
	return srv, &perSourceListener{Listener: l, limit: perSource, open: map[string]int{}}
}

// perSourceListener closes a connection from a source that already holds
// limit open ones.
type perSourceListener struct {
	net.Listener
	limit int
	mu    sync.Mutex
	open  map[string]int
}

func (l *perSourceListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		src, _, err := net.SplitHostPort(c.RemoteAddr().String())
		if err != nil {
			_ = c.Close()
			continue
		}
		l.mu.Lock()
		if l.open[src] >= l.limit {
			l.mu.Unlock()
			_ = c.Close()
			continue
		}
		l.open[src]++
		l.mu.Unlock()
		return &countedConn{Conn: c, release: sync.OnceFunc(func() { l.release(src) })}, nil
	}
}

func (l *perSourceListener) release(src string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.open[src]--; l.open[src] <= 0 {
		delete(l.open, src)
	}
}

// countedConn frees its source's slot on its first Close.
type countedConn struct {
	net.Conn
	release func()
}

func (c *countedConn) Close() error {
	err := c.Conn.Close()
	c.release()
	return err
}
