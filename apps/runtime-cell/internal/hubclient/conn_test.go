package hubclient

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// hubEnd is the hub's side of one test connection.
type hubEnd struct {
	t  *testing.T
	ws *websocket.Conn
}

func (h *hubEnd) read(ctx context.Context) *protocol.Message {
	h.t.Helper()
	_, data, err := h.ws.Read(ctx)
	if err != nil {
		h.t.Fatalf("hub read: %v", err)
	}
	m, err := protocol.Decode(data)
	if err != nil {
		h.t.Fatalf("hub decode: %v", err)
	}
	return m
}

func (h *hubEnd) send(ctx context.Context, hd protocol.Header, body any) string {
	h.t.Helper()
	if hd.ID == "" {
		hd.ID = NewID()
	}
	if hd.CellID == "" {
		hd.CellID = "cell-1"
	}
	frame, err := protocol.Encode(hd, body)
	if err != nil {
		h.t.Fatal(err)
	}
	if err := h.ws.Write(ctx, websocket.MessageText, frame); err != nil {
		h.t.Fatal(err)
	}
	return hd.ID
}

// pair dials a real mTLS WebSocket and returns both ends.
func pair(t *testing.T, ackWait time.Duration) (*Conn, *hubEnd) {
	t.Helper()
	ca, err := testpki.NewCA("hubclient-test")
	if err != nil {
		t.Fatal(err)
	}
	serverCert, _ := ca.Issue("hub", time.Hour, "127.0.0.1")
	clientCert, _ := ca.Issue("cell-1", time.Hour)
	ends := make(chan *websocket.Conn, 1)
	done := make(chan struct{})
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ends <- ws
		<-done
	}))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientCAs: ca.Pool(), ClientAuth: tls.RequireAndVerifyClientCert}
	srv.StartTLS()
	t.Cleanup(func() { close(done); srv.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := Dial(ctx, Config{
		URL: "wss://" + strings.TrimPrefix(srv.URL, "https://"), CellID: "cell-1", AckTimeout: ackWait,
		TLS: &tls.Config{Certificates: []tls.Certificate{clientCert}, RootCAs: ca.Pool()},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close("test") })
	return c, &hubEnd{t: t, ws: <-ends}
}

func serve(t *testing.T, c *Conn, h Handler) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = c.Serve(ctx, h) }()
	t.Cleanup(func() { cancel(); _ = c.Close("test"); <-done })
}

func ackHandler(context.Context, *protocol.Message) error { return nil }

func TestRequestGetsAckAndNack(t *testing.T) {
	c, hub := pair(t, time.Second)
	serve(t, c, ackHandler)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	errc := make(chan error, 1)
	go func() {
		errc <- c.Request(ctx, protocol.Header{}, &protocol.HeartbeatBody{Claims: []protocol.HeartbeatClaim{}})
	}()
	m := hub.read(ctx)
	hub.send(ctx, protocol.Header{Re: m.Envelope.ID}, &protocol.AckBody{})
	if err := <-errc; err != nil {
		t.Fatalf("ack: %v", err)
	}

	go func() {
		errc <- c.Request(ctx, protocol.Header{}, &protocol.HeartbeatBody{Claims: []protocol.HeartbeatClaim{}})
	}()
	m = hub.read(ctx)
	hub.send(ctx, protocol.Header{Re: m.Envelope.ID}, &protocol.NackBody{Code: "busy", Message: "later"})
	var n *NackError
	if err := <-errc; !errors.As(err, &n) || n.Code != "busy" {
		t.Fatalf("nack: %v", err)
	}
}

func TestRequestTimesOutWithoutAnAck(t *testing.T) {
	c, hub := pair(t, 100*time.Millisecond)
	serve(t, c, ackHandler)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	errc := make(chan error, 1)
	go func() {
		errc <- c.Request(ctx, protocol.Header{}, &protocol.HeartbeatBody{Claims: []protocol.HeartbeatClaim{}})
	}()
	hub.read(ctx)
	if err := <-errc; !errors.Is(err, ErrAckTimeout) {
		t.Fatalf("want ErrAckTimeout, got %v", err)
	}
}

// A second answer to the same frame used to block the read loop on the
// requester's full channel: every frame after it was never read.
func TestDuplicateAnswerNeverBlocksDelivery(t *testing.T) {
	c := newConn(nil, Config{CellID: "cell-1"})
	ch := make(chan *protocol.Message, 1)
	c.pending["req-1"] = ch
	re := "req-1"
	m := &protocol.Message{Envelope: protocol.Envelope{Re: &re}, Body: &protocol.AckBody{}}
	done := make(chan struct{})
	go func() {
		c.deliver(m)
		c.deliver(m) // nobody reads ch yet
		c.deliver(m)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("deliver blocked on a duplicate answer")
	}
	if len(ch) != 1 {
		t.Fatalf("requester got %d answers, want 1", len(ch))
	}
}

func TestFramesForAnotherCellAndBinaryFramesAreRefused(t *testing.T) {
	c, hub := pair(t, time.Second)
	reached := make(chan struct{}, 4)
	serve(t, c, func(context.Context, *protocol.Message) error { reached <- struct{}{}; return nil })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	id := hub.send(ctx, protocol.Header{CellID: "cell-2", ClaimID: "claim-1"}, &protocol.ClaimReleaseBody{})
	m := hub.read(ctx)
	if n, ok := m.Body.(*protocol.NackBody); !ok || n.Code != "wrong_cell" || m.Envelope.Re == nil || *m.Envelope.Re != id {
		t.Fatalf("want wrong_cell nack for %s, got %+v", id, m)
	}
	// A binary frame has no id to answer: refused and counted, not nacked.
	if err := hub.ws.Write(ctx, websocket.MessageBinary, []byte{1, 2}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for c.RefusedFrames() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := c.RefusedFrames(); got != 2 {
		t.Fatalf("refused %d, want 2", got)
	}
	select {
	case <-reached:
		t.Fatal("a refused frame reached the handler")
	default:
	}
}

// Later answers from its own goroutine: a frame behind a slow one is
// answered first, and the slow one is still answered.
func TestLaterAnswersOffTheReadLoop(t *testing.T) {
	c, hub := pair(t, 2*time.Second)
	release := make(chan struct{})
	serve(t, c, func(_ context.Context, m *protocol.Message) error {
		if _, ok := m.Body.(*protocol.ClaimRenewBody); ok {
			return Later(func(context.Context) error {
				<-release
				return &NackError{Code: "renew_failed", Message: "tags"}
			})
		}
		return nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	slow := hub.send(ctx, protocol.Header{ClaimID: "claim-1"}, &protocol.ClaimRenewBody{LeaseExpiresAt: "2030-01-01T00:00:00Z"})
	fast := hub.send(ctx, protocol.Header{ClaimID: "claim-1"}, &protocol.ClaimReleaseBody{})
	if m := hub.read(ctx); *m.Envelope.Re != fast {
		t.Fatalf("first answer is for %s, want the fast frame %s", *m.Envelope.Re, fast)
	}
	close(release)
	m := hub.read(ctx)
	if n, ok := m.Body.(*protocol.NackBody); !ok || *m.Envelope.Re != slow || n.Code != "renew_failed" {
		t.Fatalf("deferred answer %+v", m)
	}
}

func TestNackMessageIsClippedOnARuneBoundary(t *testing.T) {
	c, hub := pair(t, time.Second)
	long := strings.Repeat("é", 600) // 1200 bytes
	serve(t, c, func(context.Context, *protocol.Message) error { return &NackError{Code: "x", Message: long} })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	hub.send(ctx, protocol.Header{ClaimID: "claim-1"}, &protocol.ClaimReleaseBody{})
	n, ok := hub.read(ctx).Body.(*protocol.NackBody)
	if !ok || len(n.Message) > maxNackMessage || !utf8.ValidString(n.Message) || !strings.HasPrefix(long, n.Message) {
		t.Fatalf("nack message %d bytes, valid %v", len(n.Message), utf8.ValidString(n.Message))
	}
}

func TestDialRequiresTheHubCA(t *testing.T) {
	ca, _ := testpki.NewCA("x")
	cert, _ := ca.Issue("cell-1", time.Hour)
	_, err := Dial(context.Background(), Config{URL: "wss://127.0.0.1:1", CellID: "cell-1", TLS: &tls.Config{Certificates: []tls.Certificate{cert}}})
	if err == nil || !strings.Contains(err.Error(), "RootCAs") {
		t.Fatalf("dial without RootCAs: %v", err)
	}
}
