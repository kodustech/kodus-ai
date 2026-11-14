package egress

import (
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// liveConn is one connection the proxy let through. It lives no longer than
// the claim's policy (and MaxConnLifetime), dies after IdleTimeout without a
// byte either way, and is closed when a new policy no longer allows it.
type liveConn struct {
	claim, host, source string
	port                int
	injects             bool
	started             time.Time
	client, upstream    net.Conn

	up, down   atomic.Int64
	lastActive atomic.Int64 // unix nano

	mu       sync.Mutex
	closed   bool
	why      string
	deadline *time.Timer
	idle     *time.Timer
}

func (c *liveConn) touch(now time.Time) { c.lastActive.Store(now.UnixNano()) }

// close ends both sides once and remembers the first reason.
func (c *liveConn) close(why string) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed, c.why = true, why
	if c.deadline != nil {
		c.deadline.Stop()
	}
	if c.idle != nil {
		c.idle.Stop()
	}
	c.mu.Unlock()
	_ = c.client.Close()
	if c.upstream != nil {
		_ = c.upstream.Close()
	}
}

func (c *liveConn) reason() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.why == "" {
		return "eof"
	}
	return c.why
}

// setDeadline (re)arms the absolute end of the connection.
func (c *liveConn) setDeadline(now, until time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	if c.deadline != nil {
		c.deadline.Stop()
	}
	c.deadline = time.AfterFunc(until.Sub(now), func() { c.close("policy_expired") })
}

// watchIdle closes the connection after idle without traffic either way:
// one timer, re-armed for whatever is left when it fires early.
func (c *liveConn) watchIdle(idle time.Duration, now func() time.Time) {
	var check func()
	check = func() {
		quiet := now().Sub(time.Unix(0, c.lastActive.Load()))
		if quiet >= idle {
			c.close("idle")
			return
		}
		c.mu.Lock()
		if !c.closed {
			c.idle = time.AfterFunc(idle-quiet, check)
		}
		c.mu.Unlock()
	}
	c.mu.Lock()
	c.idle = time.AfterFunc(idle, check)
	c.mu.Unlock()
}

// countingConn counts bytes and marks activity on reads.
type countingConn struct {
	net.Conn
	n    *atomic.Int64
	live *liveConn
	now  func() time.Time
}

func (c countingConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if n > 0 {
		c.n.Add(int64(n))
		c.live.touch(c.now())
	}
	return n, err
}

func (c countingConn) CloseWrite() error {
	if cw, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return nil
}

// registry tracks live connections by claim and by source address.
type registry struct {
	mu       sync.Mutex
	byClaim  map[string]map[*liveConn]struct{}
	bySource map[string]int
}

func newRegistry() *registry {
	return &registry{byClaim: map[string]map[*liveConn]struct{}{}, bySource: map[string]int{}}
}

// admit counts a new connection from source unless it already has max.
func (r *registry) admit(source string, max int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if max > 0 && r.bySource[source] >= max {
		return false
	}
	r.bySource[source]++
	return true
}

func (r *registry) release(source string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.bySource[source] <= 1 {
		delete(r.bySource, source)
		return
	}
	r.bySource[source]--
}

func (r *registry) add(c *liveConn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	set := r.byClaim[c.claim]
	if set == nil {
		set = map[*liveConn]struct{}{}
		r.byClaim[c.claim] = set
	}
	set[c] = struct{}{}
}

func (r *registry) remove(c *liveConn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.byClaim[c.claim], c)
	if len(r.byClaim[c.claim]) == 0 {
		delete(r.byClaim, c.claim)
	}
}

func (r *registry) of(claim string) []*liveConn {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*liveConn, 0, len(r.byClaim[claim]))
	for c := range r.byClaim[claim] {
		out = append(out, c)
	}
	return out
}

func (r *registry) count(claim string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.byClaim[claim])
}
