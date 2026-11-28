package preview

import (
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

const (
	// AuthScheme is PREVIEW_TUNNEL_AUTH_SCHEME: the ticket rides in its own
	// Authorization scheme, beside the client certificate.
	AuthScheme = protocol.PreviewTunnelAuthScheme
	// DefaultIdleClose is how long the tunnel stays open after its last
	// route is gone (docs/runtime/preview-urls.md §4.2): nothing is open when nobody previews.
	DefaultIdleClose = 5 * time.Minute
	// maxMessage bounds one WebSocket message from the edge (a chunk of the
	// HTTP/2 byte stream, a few frames at most).
	maxMessage  = 16 << 20
	dialTimeout = 30 * time.Second
	// maxConnStreams bounds the tunnel's concurrent streams over all its
	// previews; each preview has DefaultMaxStreams of them.
	maxConnStreams = 1024
	// idleCheckEvery is how often an open tunnel asks CloseIdle.
	idleCheckEvery = 30 * time.Second
)

// Config is what a Service needs. TLS is called at each dial: the cell's
// client certificate (it renews) and the roots the edge's certificate
// chains to.
type Config struct {
	TLS            func() *tls.Config
	Clock          clock.Clock
	Log            *slog.Logger
	Metrics        *metrics.Registry
	IdleClose      time.Duration
	MaxStreams     int
	MaxRequestBody int64
	RequestTimeout time.Duration
}

// Service is the cell's preview capability: its routes and its one tunnel.
type Service struct {
	cfg     Config
	routes  *Table
	handler *handler
	gauge   *metrics.Vec

	mu         sync.Mutex
	tun        *tunnel
	emptySince time.Time
	closed     bool
	wg         sync.WaitGroup
}

type tunnel struct {
	url  string
	ws   *websocket.Conn
	srv  *http.Server
	done chan struct{}
}

// New makes the preview capability. It opens nothing until a tunnel is asked for.
func New(cfg Config) *Service {
	cfg.Clock = clock.Or(cfg.Clock)
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.Metrics == nil {
		cfg.Metrics = metrics.NewRegistry()
	}
	if cfg.IdleClose <= 0 {
		cfg.IdleClose = DefaultIdleClose
	}
	if cfg.MaxRequestBody <= 0 {
		cfg.MaxRequestBody = DefaultMaxRequestBody
	}
	if cfg.RequestTimeout <= 0 {
		cfg.RequestTimeout = DefaultRequestTimeout
	}
	s := &Service{cfg: cfg, routes: NewTable(cfg.Clock, cfg.MaxStreams)}
	s.gauge = cfg.Metrics.Gauge("cell_preview_tunnels", "Preview tunnels this cell holds open to an edge (0 or 1).")
	s.handler = &handler{
		routes: s.routes, log: cfg.Log, maxBody: cfg.MaxRequestBody, timeout: cfg.RequestTimeout,
		streams: cfg.Metrics.Counter("cell_preview_streams_total", "Tunnel streams the cell served or refused, by outcome.", "outcome"),
		bytes:   cfg.Metrics.Counter("cell_preview_bytes_total", "Bytes through the cell's preview proxy, up (to the app) or down (to the edge).", "direction"),
	}
	s.routes.onEmpty = s.markEmpty
	return s
}

// Handler serves one stream as the tunnel does (tests, an in-process edge).
func (s *Service) Handler() http.Handler { return s.handler }

// Route adds or renews a route.
func (s *Service) Route(r Route) error {
	if err := s.routes.Set(r); err != nil {
		return err
	}
	s.mu.Lock()
	s.emptySince = time.Time{} // a route is back: no idle close
	s.mu.Unlock()
	return nil
}

// Unroute refuses previewID from now on and ends its streams.
func (s *Service) Unroute(previewID, claimID string) bool { return s.routes.Remove(previewID, claimID) }

// ReleaseClaim drops a released claim's routes and ends their streams.
func (s *Service) ReleaseClaim(claimID string) int { return s.routes.RemoveClaim(claimID) }

// Routes is how many routes the cell holds.
func (s *Service) Routes() int { return s.routes.Len() }

// Connected is the edge URL of the open tunnel, if any.
func (s *Service) Connected() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tun == nil {
		return "", false
	}
	return s.tun.url, true
}

// Tunnel dials the edge at url with the ticket and serves HTTP/2 on the
// connection until it closes. A tunnel already open to url is kept and the
// ticket is not used; one open to another url is replaced. It returns once
// the tunnel is up (or the dial failed); serving goes on in the background.
// After a drop nothing redials: the ticket was single-use, and the worker
// sends a new preview.tunnel when the edge has no tunnel of this cell.
func (s *Service) Tunnel(ctx context.Context, url, ticket string) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return errors.New("preview: closed")
	}
	if s.tun != nil && s.tun.url == url {
		s.mu.Unlock()
		return nil
	}
	old := s.tun
	s.mu.Unlock()
	if old != nil {
		s.closeTunnel(old, "replaced")
	}
	if s.cfg.TLS == nil {
		return errors.New("preview: no client TLS")
	}
	tlsCfg := s.cfg.TLS().Clone()
	if tlsCfg.RootCAs == nil || (len(tlsCfg.Certificates) == 0 && tlsCfg.GetClientCertificate == nil) {
		return errors.New("preview: the tunnel needs the cell certificate and the edge roots")
	}
	if tlsCfg.MinVersion < tls.VersionTLS13 {
		tlsCfg.MinVersion = tls.VersionTLS13
	}
	dctx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	ws, _, err := websocket.Dial(dctx, url, &websocket.DialOptions{ //nolint:bodyclose // websocket.Dial owns the handshake response
		HTTPClient:      &http.Client{Transport: &http.Transport{TLSClientConfig: tlsCfg, ForceAttemptHTTP2: false}},
		HTTPHeader:      http.Header{"Authorization": []string{AuthScheme + " " + ticket}},
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		msg, _ := redact.Clip(err.Error(), 256)
		return errors.New("preview: dial the edge: " + msg)
	}
	// The tunnel outlives this call (its frame's context): only its values go on.
	return s.serve(context.WithoutCancel(ctx), url, ws)
}

// serve runs the HTTP/2 server on an open WebSocket (Tunnel, and tests
// that hold both ends).
func (s *Service) serve(ctx context.Context, url string, ws *websocket.Conn) error {
	ws.SetReadLimit(maxMessage)
	nc := websocket.NetConn(ctx, ws, websocket.MessageBinary)
	var protocols http.Protocols
	protocols.SetUnencryptedHTTP2(true)
	t := &tunnel{url: url, ws: ws, done: make(chan struct{})}
	t.srv = &http.Server{
		Handler:           s.handler,
		Protocols:         &protocols,
		ReadHeaderTimeout: 30 * time.Second,
		HTTP2:             &http.HTTP2Config{MaxConcurrentStreams: maxConnStreams},
		ErrorLog:          slog.NewLogLogger(s.cfg.Log.Handler(), slog.LevelDebug),
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = ws.CloseNow()
		return errors.New("preview: closed")
	}
	s.tun = t
	if s.routes.Len() == 0 && s.emptySince.IsZero() {
		s.emptySince = s.cfg.Clock.Now()
	}
	s.wg.Add(2)
	s.mu.Unlock()
	go s.watchIdle(t)
	s.gauge.Set(1)
	s.cfg.Log.Info("preview.tunnel.connected", "routes", s.routes.Len())
	go func() {
		defer s.wg.Done()
		_ = t.srv.Serve(&oneConn{c: nc, done: t.done})
		s.mu.Lock()
		if s.tun == t {
			s.tun = nil
			s.gauge.Set(0)
		}
		s.mu.Unlock()
		s.cfg.Log.Info("preview.tunnel.closed", "routes", s.routes.Len())
	}()
	return nil
}

func (s *Service) closeTunnel(t *tunnel, why string) {
	s.cfg.Log.Info("preview.tunnel.closing", "why", why)
	_ = t.srv.Close()
	_ = t.ws.Close(websocket.StatusNormalClosure, why)
}

// markEmpty records when the table went empty: the idle close counts from it.
func (s *Service) markEmpty() {
	s.mu.Lock()
	if s.routes.Len() == 0 && s.emptySince.IsZero() {
		s.emptySince = s.cfg.Clock.Now()
	}
	s.mu.Unlock()
}

// CloseIdle closes the tunnel when no route has been held for IdleClose;
// true when it closed one. The tunnel's own loop calls it every
// idleCheckEvery; the decision is the clock's.
func (s *Service) CloseIdle() bool {
	s.mu.Lock()
	t := s.tun
	idle := t != nil && s.routes.Len() == 0 && !s.emptySince.IsZero() && s.cfg.Clock.Now().Sub(s.emptySince) >= s.cfg.IdleClose
	s.mu.Unlock()
	if idle {
		s.closeTunnel(t, "idle")
	}
	return idle
}

// watchIdle runs CloseIdle while t is open.
func (s *Service) watchIdle(t *tunnel) {
	defer s.wg.Done()
	tick := time.NewTicker(idleCheckEvery)
	defer tick.Stop()
	for {
		select {
		case <-t.done:
			return
		case <-tick.C:
			s.CloseIdle()
		}
	}
}

// Close ends the tunnel and every stream, and waits for them.
func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	t := s.tun
	s.mu.Unlock()
	if t != nil {
		s.closeTunnel(t, "cell_stopping")
	}
	s.wg.Wait()
}

// oneConn is a listener of one connection: the tunnel. Accept returns it
// once, then blocks until the server closes.
type oneConn struct {
	c    net.Conn
	done chan struct{}
	once sync.Once
	mu   sync.Mutex
	used bool
}

func (l *oneConn) Accept() (net.Conn, error) {
	l.mu.Lock()
	if !l.used {
		l.used = true
		l.mu.Unlock()
		return &closeNotify{Conn: l.c, l: l}, nil
	}
	l.mu.Unlock()
	<-l.done
	return nil, net.ErrClosed
}

func (l *oneConn) Close() error   { l.once.Do(func() { close(l.done) }); return nil }
func (l *oneConn) Addr() net.Addr { return l.c.LocalAddr() }

// closeNotify ends the listener when the tunnel connection ends, so Serve
// returns after a drop.
type closeNotify struct {
	net.Conn
	l *oneConn
}

func (c *closeNotify) Close() error {
	err := c.Conn.Close()
	_ = c.l.Close()
	return err
}
