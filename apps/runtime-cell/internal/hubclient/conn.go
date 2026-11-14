// Package hubclient is the cell's one connection to the runtime-hub: an
// outbound WebSocket with mTLS, no compression, 1 MiB frames, and the
// ack/nack rule of the protocol (every request answered in 5 s).
package hubclient

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// AckTimeout is how long a sender waits for ack or nack (Config.AckTimeout
// lowers it in tests).
const AckTimeout = 5 * time.Second

// Nack field limits of the protocol (nack.code, nack.message).
const (
	maxNackCode    = 64
	maxNackMessage = 1024
)

var (
	ErrAckTimeout = errors.New("hubclient: no ack or nack in time")
	ErrClosed     = errors.New("hubclient: connection closed")
)

type NackError struct {
	Code    string
	Message string
}

func (e *NackError) Error() string { return "nack " + e.Code + ": " + e.Message }

// NewID returns a random UUID v4.
func NewID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Handler receives every decoded request frame (not ack or nack). It runs
// on the read loop and must return at once: the connection answers ack or
// nack from its result. A nil error means ack; a *NackError is sent as is;
// Later defers the answer to work off the read loop; any other error is a
// nack with code "internal".
type Handler func(ctx context.Context, m *protocol.Message) error

// deferred is what Later returns: the answer comes from run, which the
// connection starts off the read loop.
type deferred struct {
	run func(ctx context.Context) error
}

func (d *deferred) Error() string { return "hubclient: answer deferred" }

// Later lets a handler answer from work that does I/O (a cloud call)
// without stalling the frames behind it: the connection runs f in its own
// goroutine and acks or nacks with its result. f gets a context that ends
// before the hub's ack budget, so a slow f becomes a nack the hub can retry,
// never a silence.
func Later(f func(ctx context.Context) error) error { return &deferred{run: f} }

// IsLater reports whether err is a deferred answer (tests of handlers).
func IsLater(err error) (func(ctx context.Context) error, bool) {
	var d *deferred
	if errors.As(err, &d) {
		return d.run, true
	}
	return nil, false
}

// Sender sends a request and waits for its ack: what the agent needs of a
// connection.
type Sender interface {
	Request(ctx context.Context, h protocol.Header, body any) error
}

type Conn struct {
	ws      *websocket.Conn
	cellID  string
	log     *slog.Logger
	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[string]chan *protocol.Message
	closed  chan struct{}
	ackWait time.Duration
	later   sync.WaitGroup

	refused       atomic.Int64
	mRefused      *metrics.Vec
	mNacksSent    *metrics.Vec
	mNacksRecv    *metrics.Vec
	mDuplicateAck *metrics.Vec
}

type Config struct {
	URL    string
	TLS    *tls.Config
	CellID string
	// AckTimeout defaults to AckTimeout (5 s).
	AckTimeout time.Duration
	Log        *slog.Logger
	Metrics    *metrics.Registry
}

// Dial opens the connection. The TLS config must carry the cell's client
// certificate and the hub CA; nothing else is trusted.
func Dial(ctx context.Context, cfg Config) (*Conn, error) {
	if cfg.TLS == nil || len(cfg.TLS.Certificates) == 0 && cfg.TLS.GetClientCertificate == nil {
		return nil, errors.New("hubclient: mTLS client certificate required")
	}
	if cfg.TLS.RootCAs == nil {
		// A nil pool would mean the system roots: any public CA could stand
		// in for the hub.
		return nil, errors.New("hubclient: the hub CA (RootCAs) is required")
	}
	tlsCfg := cfg.TLS.Clone()
	if tlsCfg.MinVersion < tls.VersionTLS13 {
		tlsCfg.MinVersion = tls.VersionTLS13
	}
	ws, _, err := websocket.Dial(ctx, cfg.URL, &websocket.DialOptions{
		HTTPClient:      &http.Client{Transport: &http.Transport{TLSClientConfig: tlsCfg, ForceAttemptHTTP2: false}, Timeout: 30 * time.Second},
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(protocol.MaxFrameBytes)
	return newConn(ws, cfg), nil
}

func newConn(ws *websocket.Conn, cfg Config) *Conn {
	wait := cfg.AckTimeout
	if wait <= 0 {
		wait = AckTimeout
	}
	log := cfg.Log
	if log == nil {
		log = slog.Default()
	}
	return &Conn{
		ws: ws, cellID: cfg.CellID, log: log, pending: map[string]chan *protocol.Message{}, closed: make(chan struct{}), ackWait: wait,
		mRefused:      cfg.Metrics.Counter("cell_hub_frames_refused_total", "Frames from the hub the decoder refused or that named another cell (S-30).", "code"),
		mNacksSent:    cfg.Metrics.Counter("cell_hub_nacks_sent_total", "Nacks the cell sent to the hub.", "type", "code"),
		mNacksRecv:    cfg.Metrics.Counter("cell_hub_nacks_received_total", "Nacks the hub sent to the cell.", "code"),
		mDuplicateAck: cfg.Metrics.Counter("cell_hub_unmatched_acks_total", "Acks or nacks for a frame already answered or no longer waited for."),
	}
}

// RefusedFrames counts frames refused by the decoder or addressed to another
// cell (S-30).
func (c *Conn) RefusedFrames() int64 { return c.refused.Load() }

func (c *Conn) write(ctx context.Context, frame []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageText, frame)
}

// Send writes one message and does not wait.
func (c *Conn) Send(ctx context.Context, h protocol.Header, body any) (string, error) {
	if h.ID == "" {
		h.ID = NewID()
	}
	h.CellID = c.cellID
	frame, err := protocol.Encode(h, body)
	if err != nil {
		return "", err
	}
	return h.ID, c.write(ctx, frame)
}

// Request writes a message and waits for its ack or nack.
func (c *Conn) Request(ctx context.Context, h protocol.Header, body any) error {
	_, err := c.RequestAck(ctx, h, body)
	return err
}

// RequestAck is Request that also returns the ack's body (the hello ack
// carries the protocol version the hub chose).
func (c *Conn) RequestAck(ctx context.Context, h protocol.Header, body any) (*protocol.AckBody, error) {
	if h.ID == "" {
		h.ID = NewID()
	}
	// Buffered: the read loop never waits for this requester (see deliver).
	ch := make(chan *protocol.Message, 1)
	c.mu.Lock()
	c.pending[h.ID] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, h.ID)
		c.mu.Unlock()
	}()
	if _, err := c.Send(ctx, h, body); err != nil {
		return nil, err
	}
	t := time.NewTimer(c.ackWait)
	defer t.Stop()
	select {
	case m := <-ch:
		if n, ok := m.Body.(*protocol.NackBody); ok {
			c.mNacksRecv.Inc(n.Code)
			return nil, &NackError{Code: n.Code, Message: n.Message}
		}
		return m.Body.(*protocol.AckBody), nil
	case <-t.C:
		return nil, ErrAckTimeout
	case <-c.closed:
		return nil, ErrClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// deliver hands an ack or nack to the request waiting for it. It never
// blocks the read loop: a second answer to the same frame, or one for a
// request that gave up, is dropped.
func (c *Conn) deliver(m *protocol.Message) {
	c.mu.Lock()
	ch, ok := c.pending[*m.Envelope.Re]
	c.mu.Unlock()
	if ok {
		select {
		case ch <- m:
			return
		default:
		}
	}
	c.mDuplicateAck.Inc()
	c.log.Warn("hub.ack.unmatched", "re", *m.Envelope.Re, "type", m.Envelope.Type)
}

func (c *Conn) reply(ctx context.Context, re string, typ protocol.MessageType, claim string, err error) {
	h := protocol.Header{Re: re, ClaimID: claim}
	var body any = &protocol.AckBody{}
	if err != nil {
		var n *NackError
		if !errors.As(err, &n) {
			n = &NackError{Code: "internal", Message: err.Error()}
		}
		code, _ := redact.Clip(n.Code, maxNackCode)
		msg, _ := redact.Clip(n.Message, maxNackMessage)
		body = &protocol.NackBody{Code: code, Message: msg}
		c.mNacksSent.Inc(string(typ), code)
		c.log.Info("hub.nack.sent", "re", re, "type", typ, "claim", claim, "code", code, "message", msg)
	}
	if _, serr := c.Send(ctx, h, body); serr != nil {
		c.log.Warn("hub.reply.failed", "re", re, "type", typ, "claim", claim, "err", serr)
	}
}

// refuse counts and logs a refused frame, and nacks it when it can be
// named: a nack must carry re, and a frame that did not decode has no id.
func (c *Conn) refuse(ctx context.Context, re string, code, msg string) {
	c.refused.Add(1)
	c.mRefused.Inc(code)
	c.log.Warn("hub.frame.refused", "re", re, "code", code, "message", msg)
	if re != "" {
		c.reply(ctx, re, "", "", &NackError{Code: code, Message: msg})
	}
}

// Serve reads until the connection ends. Frames the decoder refuses never
// reach the handler; one addressed to another cell gets a nack (the decoder
// refusals have no id to answer).
func (c *Conn) Serve(ctx context.Context, h Handler) error {
	defer func() {
		close(c.closed)
		c.later.Wait()
	}()
	for {
		typ, data, err := c.ws.Read(ctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			c.refuse(ctx, "", "invalid_json", "binary frame")
			continue
		}
		m, err := protocol.Decode(data)
		if err != nil {
			code := string(protocol.CodeInvalidJSON)
			var de *protocol.DecodeError
			if errors.As(err, &de) {
				code = string(de.Code)
			}
			c.refuse(ctx, "", code, err.Error())
			continue
		}
		if m.Envelope.CellID != c.cellID {
			c.refuse(ctx, m.Envelope.ID, "wrong_cell", "frame addressed to another cell")
			continue
		}
		switch m.Body.(type) {
		case *protocol.AckBody, *protocol.NackBody:
			if m.Envelope.Re != nil {
				c.deliver(m)
			}
			continue
		}
		claim := ""
		if m.Envelope.ClaimID != nil {
			claim = *m.Envelope.ClaimID
		}
		herr := h(ctx, m)
		if run, ok := IsLater(herr); ok {
			c.later.Add(1)
			go func() {
				defer c.later.Done()
				dctx, cancel := context.WithTimeout(ctx, c.ackWait*9/10)
				defer cancel()
				c.reply(ctx, m.Envelope.ID, m.Envelope.Type, claim, run(dctx))
			}()
			continue
		}
		c.reply(ctx, m.Envelope.ID, m.Envelope.Type, claim, herr)
	}
}

func (c *Conn) Close(reason string) error {
	return c.ws.Close(websocket.StatusNormalClosure, reason)
}

var _ Sender = (*Conn)(nil)
