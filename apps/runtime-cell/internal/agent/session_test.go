package agent

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

func TestSilenceEndsTheSessionOnlyAfterMaxUnansweredInARow(t *testing.T) {
	s := silence{max: 3}
	steps := []struct {
		err  error
		ends bool
	}{
		{hubclient.ErrAckTimeout, false},
		{hubclient.ErrAckTimeout, false},
		// A nack is the hub answering: the count starts again.
		{&hubclient.NackError{Code: "busy"}, false},
		{hubclient.ErrAckTimeout, false},
		{nil, false},
		{hubclient.ErrAckTimeout, false},
		{context.DeadlineExceeded, false},
		{hubclient.ErrAckTimeout, true},
	}
	for i, st := range steps {
		err := s.after(st.err)
		if (err != nil) != st.ends {
			t.Fatalf("step %d: after(%v) = %v, ends=%v", i, st.err, err, st.ends)
		}
		if err != nil && !errors.Is(err, hubclient.ErrAckTimeout) {
			t.Fatalf("step %d: the session's error must carry the last heartbeat's: %v", i, err)
		}
	}
}

// silentHub accepts the cell, acks its hello and its first answer heartbeats,
// then keeps the socket open and answers nothing: a path that died without
// closing the cell's end.
func silentHub(t *testing.T, answer int) (url string, tlsCfg *tls.Config, beats *atomic.Int64) {
	t.Helper()
	ca, err := testpki.NewCA("session-test")
	if err != nil {
		t.Fatal(err)
	}
	serverCert, _ := ca.Issue("hub", time.Hour, "127.0.0.1")
	clientCert, _ := ca.Issue("cell-1", time.Hour)
	beats = &atomic.Int64{}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx := r.Context()
		ack := func(m *protocol.Message, body *protocol.AckBody) {
			frame, err := protocol.Encode(protocol.Header{ID: hubclient.NewID(), CellID: m.Envelope.CellID, Re: m.Envelope.ID}, body)
			if err == nil {
				_ = ws.Write(ctx, websocket.MessageText, frame)
			}
		}
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			m, err := protocol.Decode(data)
			if err != nil {
				continue
			}
			switch m.Body.(type) {
			case *protocol.HelloBody:
				v := protocol.SupportedVersions()[0]
				ack(m, &protocol.AckBody{Version: &v})
			case *protocol.HeartbeatBody:
				if beats.Add(1) <= int64(answer) {
					ack(m, &protocol.AckBody{})
				}
			}
		}
	}))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientCAs: ca.Pool(), ClientAuth: tls.RequireAndVerifyClientCert}
	srv.StartTLS()
	t.Cleanup(func() { srv.CloseClientConnections(); srv.Close() })
	return "wss://" + strings.TrimPrefix(srv.URL, "https://"), &tls.Config{Certificates: []tls.Certificate{clientCert}, RootCAs: ca.Pool()}, beats
}

func TestASessionWhoseHubStopsAnsweringEnds(t *testing.T) {
	h := newHarness(t)
	url, tlsCfg, beats := silentHub(t, 2)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	ended := make(chan error, 1)
	go func() {
		ended <- h.a.session(ctx, RunConfig{HubURL: url, TLS: tlsCfg, HeartbeatEvery: 20 * time.Millisecond, AckTimeout: 40 * time.Millisecond, MissedHeartbeats: 3})
	}()
	select {
	case err := <-ended:
		if err == nil || !strings.Contains(err.Error(), "hub silent: 3 heartbeats unanswered") || !errors.Is(err, hubclient.ErrAckTimeout) {
			t.Fatalf("session ended with %v", err)
		}
	case <-ctx.Done():
		t.Fatal("the session held a connection whose hub stopped answering")
	}
	// Two answered, three left unanswered, never a sixth.
	if n := beats.Load(); n != 5 {
		t.Fatalf("heartbeats sent = %d, want 5", n)
	}
	h.a.mu.Lock()
	conn := h.a.conn
	h.a.mu.Unlock()
	if conn != nil {
		t.Fatal("the dead connection is still the agent's")
	}
}
