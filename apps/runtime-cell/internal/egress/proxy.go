// Package egress is the cell's only way out (docs §4 "Proxy de saída",
// ADR-040, ADR-056). It never opens TLS: it reads the SNI of the
// ClientHello (or the Host of the plain HTTP request), checks it against
// the claim's exact allowlist and the Kodus deny list, and checks that the
// address the client was going to is one the cell resolver handed the claim
// for that name, or one the proxy resolves for it now.
//
// What it cannot see: inside TLS, a client may send another Host or reuse
// the connection for another name the certificate covers (HTTP/2
// coalescing). On a multi-tenant CDN address that reaches other tenants of
// the same CDN; an allowlist entry on a shared CDN carries that risk, and a
// credentialed host goes through the injector, which checks Host itself.
// Encrypted Client Hello hides the real SNI, so a ClientHello carrying it
// is refused. Plain HTTP carries exactly one request per connection.
//
// Every refusal is an egress.blocked event on the control port; every
// connection let through is logged when it closes (egress.allowed, with its
// bytes and duration); both are counted on /metrics. A live connection
// lives no longer than its claim's policy and is cut when a new policy no
// longer allows it.
package egress

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// Resolver is the proxy's own lookup of an allowed name (IPv4 only).
type Resolver func(ctx context.Context, host string) ([]net.IP, error)

const (
	defaultIdleTimeout       = 2 * time.Minute
	defaultMaxConnLifetime   = 2 * time.Hour
	defaultMaxConnsPerSource = 512
	headTimeout              = 10 * time.Second
	maxHead                  = 64 << 10
	// extECH is the encrypted_client_hello extension codepoint every
	// deployed client uses.
	extECH = 0xfe0d
)

type Proxy struct {
	Policies *policy.Store
	Events   *Events
	// Connections are the connections the proxy let through (Reason
	// "allowed"), kept apart from Events so a busy app never pushes a
	// refusal out of the failure bundle's log; nil: not recorded. The cell
	// reads a probe's window of both for its outbound evidence.
	Connections *Events
	Resolve     Resolver
	// Answers is what the cell resolver handed each claim. A destination it
	// handed for the name is accepted without a new lookup; nil: only the
	// proxy's own lookup counts.
	Answers *netguard.Answers
	// OriginalDst returns where the client was going before the redirect
	// (SO_ORIGINAL_DST on Linux). nil: the proxy is not transparent and
	// dials the address it resolved itself.
	OriginalDst func(net.Conn) (net.IP, int, error)
	Dial        func(ctx context.Context, network, addr string) (net.Conn, error)
	// Deny is the hosts no policy reaches (netguard.DenyList); its zero
	// value is the Kodus list.
	Deny netguard.DenyList
	// InjectorAddr is where credentialed hosts go (Inc. 5). The proxy writes
	// a PROXY v1 line with the VM's address and the destination it
	// validated, and replays the ClientHello; it never sees the credential.
	InjectorAddr string
	// InternalCIDRs are the cell's own networks (its mirror, its evidence
	// endpoint): the only private addresses a name may lead to. Link-local
	// (the metadata service) is refused even inside them.
	InternalCIDRs []*net.IPNet
	// IdleTimeout closes a connection with no traffic either way;
	// MaxConnLifetime bounds any connection even under a renewed policy;
	// MaxConnsPerSource bounds what one machine holds open.
	IdleTimeout       time.Duration
	MaxConnLifetime   time.Duration
	MaxConnsPerSource int
	Metrics           *Metrics
	Log               *slog.Logger
	Now               func() time.Time

	once   sync.Once
	conns  *registry
	logMu  sync.Mutex
	logged map[string]denialLog
}

type denialLog struct {
	at         time.Time
	suppressed int
}

func (p *Proxy) defaults() {
	p.once.Do(func() {
		if p.Dial == nil {
			d := &net.Dialer{Timeout: 10 * time.Second}
			p.Dial = d.DialContext
		}
		if p.Log == nil {
			p.Log = slog.Default()
		}
		if p.Now == nil {
			p.Now = time.Now
		}
		if p.Metrics == nil {
			p.Metrics = NewMetrics()
		}
		if p.Events == nil {
			p.Events = NewEvents(10_000)
		}
		if p.IdleTimeout == 0 {
			p.IdleTimeout = defaultIdleTimeout
		}
		if p.MaxConnLifetime == 0 {
			p.MaxConnLifetime = defaultMaxConnLifetime
		}
		if p.MaxConnsPerSource == 0 {
			p.MaxConnsPerSource = defaultMaxConnsPerSource
		}
		p.conns = newRegistry()
		p.logged = map[string]denialLog{}
	})
}

// Serve accepts on l; tlsMode true reads SNI, false reads the HTTP Host.
// A temporary accept failure (too many open files) is retried with backoff:
// a workload that exhausts descriptors must not take the proxy down for
// every other claim.
func (p *Proxy) Serve(ctx context.Context, l net.Listener, port int, tlsMode bool) error {
	p.defaults()
	go func() { <-ctx.Done(); l.Close() }()
	var backoff time.Duration
	for {
		c, err := l.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if temporaryAccept(err) {
				backoff = min(max(2*backoff, 5*time.Millisecond), time.Second)
				p.Log.Warn("egress.accept_retry", "err", err, "backoff", backoff)
				select {
				case <-time.After(backoff):
					continue
				case <-ctx.Done():
					return nil
				}
			}
			return err
		}
		backoff = 0
		go p.serveConn(ctx, c, port, tlsMode)
	}
}

func temporaryAccept(err error) bool {
	if errors.Is(err, syscall.EMFILE) || errors.Is(err, syscall.ENFILE) || errors.Is(err, syscall.ENOBUFS) || errors.Is(err, syscall.ECONNABORTED) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// Revalidate re-checks the claim's live connections against its current
// policy: a host no longer allowed (a new phase, a narrower allowlist) is
// cut, and the others live until the new policy expires.
func (p *Proxy) Revalidate(claimID string) {
	p.defaults()
	pol, ok := p.Policies.ForClaim(claimID)
	now := p.Now()
	for _, c := range p.conns.of(claimID) {
		if !ok {
			c.close("policy_removed")
			continue
		}
		if !pol.Allows(c.host) || pol.Injects(c.host) != c.injects || p.Deny.Denies(c.host) {
			c.close("policy_changed")
			continue
		}
		c.setDeadline(now, p.until(pol, c.started))
	}
}

// CloseClaim cuts every live connection of the claim (its policy is gone).
func (p *Proxy) CloseClaim(claimID string) {
	p.defaults()
	for _, c := range p.conns.of(claimID) {
		c.close("policy_removed")
	}
}

// LiveConnections is how many connections the claim has open.
func (p *Proxy) LiveConnections(claimID string) int {
	p.defaults()
	return p.conns.count(claimID)
}

func (p *Proxy) until(pol policy.ClaimPolicy, started time.Time) time.Time {
	limit := started.Add(p.MaxConnLifetime)
	if pol.ExpiresAt.Before(limit) {
		return pol.ExpiresAt
	}
	return limit
}

func sourceIP(c net.Conn) net.IP {
	if a, ok := c.RemoteAddr().(*net.TCPAddr); ok {
		return a.IP
	}
	return nil
}

func addrPort(a net.Addr) int {
	if t, ok := a.(*net.TCPAddr); ok {
		return t.Port
	}
	return 0
}

// deny records a refusal (event and counter, always) and logs it at most
// once per ten seconds per claim, host and reason: a workload that hammers
// a refused name cannot flood the cell's logs.
func (p *Proxy) deny(pol policy.ClaimPolicy, host, sni string, port int, reason string) {
	now := p.Now().UTC()
	p.Events.Add(Event{ClaimID: pol.ClaimID, Host: host, SNI: sni, Port: port, Phase: string(pol.Phase), Reason: reason, At: now})
	p.Metrics.deny(reason)
	key := pol.ClaimID + "|" + host + "|" + reason
	p.logMu.Lock()
	last, seen := p.logged[key]
	if seen && now.Sub(last.at) < 10*time.Second {
		last.suppressed++
		p.logged[key] = last
		p.logMu.Unlock()
		return
	}
	if len(p.logged) > 10_000 {
		p.logged = map[string]denialLog{}
	}
	p.logged[key] = denialLog{at: now}
	p.logMu.Unlock()
	p.Log.Info("egress.blocked", "claim", pol.ClaimID, "host", host, "sni", sni, "port", port, "reason", reason, "suppressed", last.suppressed)
}

// request is what the proxy read before deciding: the name, and for TLS the
// ClientHello bytes it replays, for HTTP the parsed request it forwards.
type request struct {
	host, sni string
	ech       bool
	hello     []byte
	http      *http.Request
}

func (p *Proxy) serveConn(ctx context.Context, c net.Conn, port int, tlsMode bool) {
	defer c.Close()
	src := sourceIP(c)
	if !p.conns.admit(src.String(), p.MaxConnsPerSource) {
		p.deny(policy.ClaimPolicy{}, src.String(), "", port, "too_many_connections")
		return
	}
	defer p.conns.release(src.String())
	_ = c.SetReadDeadline(p.Now().Add(headTimeout))
	pol, ok := p.Policies.ForSource(src)
	if !ok {
		p.deny(policy.ClaimPolicy{}, src.String(), "", port, "unknown_source")
		return
	}

	var req request
	var err error
	head := &headLimit{r: c, left: maxHead}
	if tlsMode {
		req, err = readClientHello(c)
	} else {
		req, err = readHTTPRequest(bufio.NewReader(head))
		head.done = true
	}
	dstIP, dstPort := net.IP(nil), port
	if p.OriginalDst != nil {
		ip, op, oerr := p.OriginalDst(c)
		if oerr != nil || ip == nil {
			// Transparent mode without the original destination (a VM that
			// dialed the proxy directly): the destination check cannot run,
			// so the connection does not go anywhere.
			p.deny(pol, req.host, req.sni, dstPort, "no_original_dst")
			return
		}
		dstIP, dstPort = ip, op
	}
	norm, reason := p.checkName(pol, req, err, tlsMode)
	if reason != "" {
		shown := norm
		if shown == "" {
			shown = req.host
		}
		if shown == "" && dstIP != nil {
			shown = dstIP.String()
		}
		if shown == "" {
			shown = "?"
		}
		p.deny(pol, shown, req.sni, dstPort, reason)
		return
	}
	target, reason := p.chooseTarget(ctx, pol.ClaimID, norm, dstIP)
	if reason != "" {
		p.deny(pol, norm, req.sni, dstPort, reason)
		return
	}

	live := &liveConn{claim: pol.ClaimID, host: norm, source: src.String(), port: dstPort, injects: pol.Injects(norm), started: p.Now(), client: c}
	addr := net.JoinHostPort(target.String(), strconv.Itoa(dstPort))
	if live.injects {
		addr = p.InjectorAddr
	}
	up, err := p.Dial(ctx, "tcp4", addr)
	if err != nil {
		reason := "upstream_unreachable"
		if live.injects {
			reason = "injector_unreachable"
		}
		p.deny(pol, norm, req.sni, dstPort, reason)
		return
	}
	live.upstream = up
	defer up.Close()
	if p.Connections != nil {
		p.Connections.Add(Event{ClaimID: pol.ClaimID, Host: norm, SNI: req.sni, Port: dstPort, Phase: string(pol.Phase), Reason: "allowed", At: live.started.UTC()})
	}
	_ = c.SetReadDeadline(time.Time{})
	p.track(live, pol)
	defer p.untrack(live)

	client := countingConn{Conn: c, n: &live.up, live: live, now: p.Now}
	upstream := countingConn{Conn: up, n: &live.down, live: live, now: p.Now}
	if live.injects {
		if _, err := fmt.Fprintf(up, "PROXY TCP4 %s %s %d %d\r\n", src, target, addrPort(c.RemoteAddr()), dstPort); err != nil {
			return
		}
	}
	if tlsMode {
		if _, err := up.Write(req.hello); err != nil {
			return
		}
		splice(client, upstream)
		return
	}
	head.r = client // the body, if any, is counted from here on
	forwardOneRequest(req.http, client, upstream)
}

// checkName decides on the name alone: present, a host name (not an IP),
// not on the deny list, on the claim's allowlist, and, for a credentialed
// host, reached over TLS so the injector can take it.
func (p *Proxy) checkName(pol policy.ClaimPolicy, req request, readErr error, tlsMode bool) (string, string) {
	if req.ech {
		return "", "ech"
	}
	if readErr != nil || req.host == "" {
		return "", "no_host"
	}
	norm, err := policy.NormalizeHost(req.host)
	if err != nil || net.ParseIP(norm) != nil {
		return "", "bad_host"
	}
	if p.Deny.Denies(norm) {
		return norm, "denied"
	}
	if !pol.Allows(norm) {
		return norm, "not_allowed"
	}
	if pol.Injects(norm) && (!tlsMode || p.InjectorAddr == "") {
		return norm, "credential_host_needs_injector"
	}
	return norm, ""
}

// chooseTarget picks the address to dial. In transparent mode it is where
// the client was going, which must be an address the cell resolver handed
// the claim for this name or one the proxy resolves for it now; a direct IP
// or a fronted CDN address is refused. Either way the address must not lead
// inside the cell (netguard.RefusedDestination).
func (p *Proxy) chooseTarget(ctx context.Context, claim, name string, dst net.IP) (net.IP, string) {
	if dst != nil && dst.To4() == nil {
		return nil, "ipv6"
	}
	if dst != nil && p.Answers.Handed(claim, name, dst) {
		if why := netguard.RefusedDestination(dst, p.InternalCIDRs); why != "" {
			return nil, why
		}
		return dst.To4(), ""
	}
	ips, err := p.Resolve(ctx, name)
	if err != nil || len(ips) == 0 {
		return nil, "resolve_failed"
	}
	var usable []net.IP
	refused := ""
	for _, ip := range ips {
		if ip.To4() == nil {
			continue
		}
		// An allowed name whose DNS points inside (the metadata service, the
		// cell's network) is refused: the PR author may control that DNS.
		if why := netguard.RefusedDestination(ip, p.InternalCIDRs); why != "" {
			refused = why
			continue
		}
		usable = append(usable, ip.To4())
	}
	if len(usable) == 0 {
		if refused != "" {
			return nil, refused
		}
		return nil, "ipv6"
	}
	if dst == nil {
		return usable[0], ""
	}
	for _, ip := range usable {
		if ip.Equal(dst) {
			return ip, ""
		}
	}
	return nil, "ip_mismatch"
}

func (p *Proxy) track(c *liveConn, pol policy.ClaimPolicy) {
	now := p.Now()
	c.touch(now)
	p.conns.add(c)
	p.Metrics.allowed.Add(1)
	p.Metrics.live.Add(1)
	c.setDeadline(now, p.until(pol, c.started))
	c.watchIdle(p.IdleTimeout, p.Now)
}

func (p *Proxy) untrack(c *liveConn) {
	c.close("")
	p.conns.remove(c)
	p.Metrics.live.Add(-1)
	p.Metrics.up.Add(c.up.Load())
	p.Metrics.down.Add(c.down.Load())
	p.Log.Info("egress.allowed", "claim", c.claim, "host", c.host, "port", c.port, "injected", c.injects,
		"bytesUp", c.up.Load(), "bytesDown", c.down.Load(), "durationMs", p.Now().Sub(c.started).Milliseconds(), "closed", c.reason())
}

// forwardOneRequest sends the one request the proxy checked, with
// Connection: close, and copies the answer back. A second request on the
// same connection could name another Host on the same address (a shared
// host or CDN): there is none, the client opens a new, checked connection.
func forwardOneRequest(req *http.Request, client, upstream net.Conn) {
	req.Close = true
	for _, h := range []string{"Connection", "Upgrade", "Proxy-Connection", "Keep-Alive"} {
		req.Header.Del(h)
	}
	// The request goes up while the answer comes back: an upstream may
	// answer (and close) before it read a large body.
	sent := make(chan struct{})
	go func() {
		defer close(sent)
		_ = req.Write(upstream)
	}()
	_, _ = io.Copy(client, upstream)
	_ = upstream.Close()
	<-sent
}

// headLimit caps what the request head may take (maxHead); once the head
// is read, done lets the body through unbounded (http.ReadRequest bounds it
// by its own length).
type headLimit struct {
	r    io.Reader
	left int
	done bool
}

func (h *headLimit) Read(b []byte) (int, error) {
	if h.done {
		return h.r.Read(b)
	}
	if h.left <= 0 {
		return 0, errors.New("egress: request head too large")
	}
	if len(b) > h.left {
		b = b[:h.left]
	}
	n, err := h.r.Read(b)
	h.left -= n
	return n, err
}

func splice(a, b net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)
	cp := func(dst, src net.Conn) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
	}
	go cp(a, b)
	go cp(b, a)
	wg.Wait()
}

// helloTee lets crypto/tls parse the ClientHello while keeping the bytes;
// writes fail so no handshake byte ever goes back to the client.
type helloTee struct {
	net.Conn
	r   io.Reader
	buf bytes.Buffer
}

func (r *helloTee) Read(b []byte) (int, error) {
	n, err := r.r.Read(b)
	r.buf.Write(b[:n])
	return n, err
}
func (r *helloTee) Write([]byte) (int, error) { return 0, errors.New("read-only") }

var errGotHello = errors.New("hello read")

// readClientHello reads the SNI and whether the hello hides another one
// (ECH), keeping the bytes to replay.
func readClientHello(c net.Conn) (request, error) {
	tee := &helloTee{Conn: c, r: io.LimitReader(c, maxHead)}
	var req request
	cfg := &tls.Config{GetConfigForClient: func(h *tls.ClientHelloInfo) (*tls.Config, error) {
		req.sni = h.ServerName
		for _, e := range h.Extensions {
			if e == extECH {
				req.ech = true
			}
		}
		return nil, errGotHello
	}}
	err := tls.Server(tee, cfg).Handshake()
	req.host, req.hello = req.sni, tee.buf.Bytes()
	if !errors.Is(err, errGotHello) && req.sni == "" {
		return req, errors.New("no ClientHello")
	}
	return req, nil
}

// readHTTPRequest reads the first request's head; its Host decides.
func readHTTPRequest(br *bufio.Reader) (request, error) {
	hr, err := http.ReadRequest(br)
	if err != nil {
		return request{}, err
	}
	host := hr.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return request{host: host, http: hr}, nil
}
