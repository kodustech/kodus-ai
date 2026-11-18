package egress

import (
	"net"
	"net/url"
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
	// injects: the connection goes to the injector, for a credential or
	// for inspection (inspects).
	injects, inspects bool
	// tls: the connection replayed a ClientHello (an HTTP one carries one
	// checked request).
	tls bool
	// build: the source was the claim's image builder when the proxy
	// decided (policy.FromBuild), a route class of its own.
	build bool
	// http: the one plain HTTP request the connection carries, which an
	// inspected rule decides again on a push.
	http             *checkedRequest
	started          time.Time
	client, upstream net.Conn

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

// checkedRequest is what an inspected rule reads of a plain HTTP request.
type checkedRequest struct {
	method        string
	url           *url.URL
	contentLength int64
}

// armLocked (re)arms the absolute end of the connection; c.mu is held and
// the connection is open.
func (c *liveConn) armLocked(now, until time.Time) {
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
	if !c.closed {
		c.idle = time.AfterFunc(idle, check)
	}
	c.mu.Unlock()
}

// countingConn counts bytes and marks activity on reads.
type countingConn struct {
	net.Conn
	n    *atomic.Int64
	live *liveConn
	now  func() time.Time
	// budget and claimUp count what the client side sends out (D8); nil on
	// the upstream side and with the budget off.
	budget  *uploadBudget
	claimUp *claimUpload
}

func (c countingConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if n > 0 {
		c.n.Add(int64(n))
		c.live.touch(c.now())
		c.budget.add(c.live.claim, c.live.host, c.claimUp, int64(n))
	}
	return n, err
}

func (c countingConn) CloseWrite() error {
	if cw, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return nil
}

// registry tracks live connections by claim, and every accepted one (live
// or still reading its head) by source address and by claim.
type registry struct {
	mu       sync.Mutex
	byClaim  map[string]map[*liveConn]struct{}
	bySource map[string]int
	// accepted is every connection of the claim from its accept to its
	// end, the ones still before their hello included (N1).
	accepted map[string]int
	total    int
}

func newRegistry() *registry {
	return &registry{byClaim: map[string]map[*liveConn]struct{}{}, bySource: map[string]int{}, accepted: map[string]int{}}
}

// admitLimits bound the connections accepted at once: per source machine,
// per claim (all its machines) and for the whole cell. Zero: no bound.
type admitLimits struct{ perSource, perClaim, total int }

// admit counts a new connection of claim from source, at accept and
// before its head is read, unless the source, the claim or the cell is
// already at its limit: a claim that parks connections before their hello
// holds at most perClaim of the cell's total (N1).
func (r *registry) admit(source, claim string, l admitLimits) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if l.perSource > 0 && r.bySource[source] >= l.perSource || l.perClaim > 0 && r.accepted[claim] >= l.perClaim || l.total > 0 && r.total >= l.total {
		return false
	}
	r.bySource[source]++
	r.accepted[claim]++
	r.total++
	return true
}

func (r *registry) release(source, claim string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.total--
	decrement(r.bySource, source)
	decrement(r.accepted, claim)
}

func decrement(m map[string]int, key string) {
	if m[key] <= 1 {
		delete(m, key)
		return
	}
	m[key]--
}

// add tracks c unless its claim already has limit connections.
func (r *registry) add(c *liveConn, limit int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	set := r.byClaim[c.claim]
	if limit > 0 && len(set) >= limit {
		return false
	}
	if set == nil {
		set = map[*liveConn]struct{}{}
		r.byClaim[c.claim] = set
	}
	set[c] = struct{}{}
	return true
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
