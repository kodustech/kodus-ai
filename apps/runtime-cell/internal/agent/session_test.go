package agent

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
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
	beats = &atomic.Int64{}
	url, tlsCfg = scriptedHub(t, func(m *protocol.Message, answerWith func(body any)) {
		switch m.Body.(type) {
		case *protocol.HelloBody:
			v := protocol.SupportedVersions()[0]
			answerWith(&protocol.AckBody{Version: &v})
		case *protocol.HeartbeatBody:
			if beats.Add(1) <= int64(answer) {
				answerWith(&protocol.AckBody{})
			}
		}
	})
	return url, tlsCfg, beats
}

// scriptedHub is a hub over mTLS that hands each frame the cell sends to
// onFrame, which may answer it (an ack or a nack body) or not.
func scriptedHub(t *testing.T, onFrame func(m *protocol.Message, answerWith func(body any))) (url string, tlsCfg *tls.Config) {
	t.Helper()
	ca, err := testpki.NewCA("session-test")
	if err != nil {
		t.Fatal(err)
	}
	serverCert, _ := ca.Issue("hub", time.Hour, "127.0.0.1")
	clientCert, _ := ca.Issue("cell-1", time.Hour)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx := r.Context()
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			m, err := protocol.Decode(data)
			if err != nil {
				continue
			}
			onFrame(m, func(body any) {
				frame, err := protocol.Encode(protocol.Header{ID: hubclient.NewID(), CellID: m.Envelope.CellID, Re: m.Envelope.ID}, body)
				if err == nil {
					_ = ws.Write(ctx, websocket.MessageText, frame)
				}
			})
		}
	}))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientCAs: ca.Pool(), ClientAuth: tls.RequireAndVerifyClientCert}
	srv.StartTLS()
	t.Cleanup(func() { srv.CloseClientConnections(); srv.Close() })
	return "wss://" + strings.TrimPrefix(srv.URL, "https://"), &tls.Config{Certificates: []tls.Certificate{clientCert}, RootCAs: ca.Pool()}
}

// A hub that refuses the cell's version refuses it again until one side is
// upgraded: the cell says so plainly, once per attempt, and dials again
// only after RefusedBackoff, not at its usual reconnect pace.
func TestAHelloRefusedForItsVersionIsLoggedAndRetriedOnlyAfterTheRefusedBackoff(t *testing.T) {
	for _, code := range []string{protocol.HelloRefusedCellTooNew, protocol.HelloRefusedCellTooOld, "unsupported_version"} {
		t.Run(code, func(t *testing.T) {
			h := newHarness(t)
			var hellos atomic.Int64
			url, tlsCfg := scriptedHub(t, func(m *protocol.Message, answerWith func(body any)) {
				if _, ok := m.Body.(*protocol.HelloBody); ok {
					hellos.Add(1)
					answerWith(&protocol.NackBody{Code: code, Message: "cell speaks protocol v9; this hub (protocol v1) accepts cells of protocol v1 to v1: upgrade the hub first"})
				}
			})
			ctx, cancel := context.WithTimeout(context.Background(), 900*time.Millisecond)
			defer cancel()
			_ = h.a.Run(ctx, RunConfig{HubURL: url, TLS: tlsCfg, Backoff: 5 * time.Millisecond, MaxBackoff: 10 * time.Millisecond, RefusedBackoff: 400 * time.Millisecond, AckTimeout: time.Second})
			// Dialed at 0, ~400 ms and ~800 ms: never at the 10 ms reconnect pace.
			if n := hellos.Load(); n < 1 || n > 3 {
				t.Fatalf("hellos = %d, want 1 to 3 in 900 ms with a 400 ms refused backoff", n)
			}
			logs := h.logs.String()
			for _, want := range []string{"level=ERROR", "msg=hub.refused_version", "code=" + code, "upgrade the hub first", "cellProtocol=", "retryIn=400ms"} {
				if !strings.Contains(logs, want) {
					t.Fatalf("the refusal log lacks %q:\n%s", want, logs)
				}
			}
			if strings.Contains(logs, "msg=hub.disconnected") {
				t.Fatalf("a version refusal is logged as a plain disconnect:\n%s", logs)
			}
		})
	}
}

// Any other refusal of the hello is a disconnect like before, at the usual pace.
func TestAHelloRefusedForAnotherReasonKeepsTheUsualBackoff(t *testing.T) {
	h := newHarness(t)
	var hellos atomic.Int64
	url, tlsCfg := scriptedHub(t, func(m *protocol.Message, answerWith func(body any)) {
		if _, ok := m.Body.(*protocol.HelloBody); ok {
			hellos.Add(1)
			answerWith(&protocol.NackBody{Code: "wrong_owner", Message: "owner differs from the registration"})
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()
	_ = h.a.Run(ctx, RunConfig{HubURL: url, TLS: tlsCfg, Backoff: 5 * time.Millisecond, MaxBackoff: 10 * time.Millisecond, RefusedBackoff: 400 * time.Millisecond, AckTimeout: time.Second})
	if n := hellos.Load(); n < 5 {
		t.Fatalf("hellos = %d: a refusal that is not about the version must not wait the refused backoff", n)
	}
	if logs := h.logs.String(); !strings.Contains(logs, "msg=hub.disconnected") || strings.Contains(logs, "hub.refused_version") {
		t.Fatalf("logs:\n%s", logs)
	}
}

// A session that reached the hub resets the reconnect pace: after a long run
// of failed dials, one drop of a good session is redialed at the base
// backoff, not at the maximum the failures had reached.
func TestAnEstablishedSessionResetsTheReconnectBackoff(t *testing.T) {
	h := newHarness(t)
	var mu sync.Mutex
	var hellos []time.Time
	url, tlsCfg := scriptedHub(t, func(m *protocol.Message, answerWith func(body any)) {
		if _, ok := m.Body.(*protocol.HelloBody); !ok {
			return // heartbeats go unanswered: an accepted session ends at once
		}
		mu.Lock()
		hellos = append(hellos, time.Now())
		n := len(hellos)
		mu.Unlock()
		if n <= 5 {
			answerWith(&protocol.NackBody{Code: "wrong_owner", Message: "not yet"})
			return
		}
		v := protocol.SupportedVersions()[0]
		answerWith(&protocol.AckBody{Version: &v})
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = h.a.Run(ctx, RunConfig{HubURL: url, TLS: tlsCfg, Backoff: 20 * time.Millisecond, MaxBackoff: 600 * time.Millisecond, RefusedBackoff: time.Hour, HeartbeatEvery: 10 * time.Millisecond, AckTimeout: 20 * time.Millisecond, MissedHeartbeats: 1})
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		n := len(hellos)
		mu.Unlock()
		if n >= 7 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if len(hellos) < 7 {
		t.Fatalf("hellos = %d, want 7", len(hellos))
	}
	// Hello 6 was accepted, the session ended at its first unanswered
	// heartbeat, and hello 7 came at the base pace (before the reset it
	// waited the 320 ms the failures had reached).
	if gap := hellos[6].Sub(hellos[5]); gap > 250*time.Millisecond {
		t.Fatalf("redial after an established session took %s: the backoff was not reset", gap)
	}
}

// A hub before the 64 limit refuses a hello of more than 32 features: the
// next hello fits its 32 (exercisedLines left out) and is accepted, and the
// one after that tries the whole list again, so an upgraded hub hears it.
func TestAHelloPastAnOlderHubsFeatureLimitIsSentTrimmedOnceAfterItsRefusal(t *testing.T) {
	h := newHarness(t, func(cfg *Config) { cfg.ExercisedLines = true })
	full := h.a.Hello().Features
	// The harness names fewer than a production cell: the older hub's
	// limit is brought down to one below what it names.
	limit, older := olderHubFeatureLimit, len(full)-1
	olderHubFeatureLimit = older
	t.Cleanup(func() { olderHubFeatureLimit = limit })
	if !slices.Contains(full, protocol.FeatureExercisedLines) {
		t.Fatalf("exercisedLines not named: %v", full)
	}
	var mu sync.Mutex
	var sent [][]string
	url, tlsCfg := scriptedHub(t, func(m *protocol.Message, answerWith func(body any)) {
		hello, ok := m.Body.(*protocol.HelloBody)
		if !ok {
			return // heartbeats go unanswered: an accepted session ends at once
		}
		mu.Lock()
		sent = append(sent, hello.Features)
		mu.Unlock()
		// The hub's own copy of its limit: its handler can outlive the test
		// (a hijacked connection), and the cleanup restores the variable.
		if len(hello.Features) > older {
			answerWith(&protocol.NackBody{Code: string(protocol.CodeInvalidBody), Message: "features: too many"})
			return
		}
		v := protocol.SupportedVersions()[0]
		answerWith(&protocol.AckBody{Version: &v})
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = h.a.Run(ctx, RunConfig{HubURL: url, TLS: tlsCfg, Backoff: 5 * time.Millisecond, MaxBackoff: 10 * time.Millisecond, RefusedBackoff: time.Hour, HeartbeatEvery: 10 * time.Millisecond, AckTimeout: 50 * time.Millisecond, MissedHeartbeats: 1})
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		n := len(sent)
		mu.Unlock()
		if n >= 3 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if len(sent) < 3 {
		t.Fatalf("hellos = %d, want 3", len(sent))
	}
	if len(sent[0]) != len(full) {
		t.Fatalf("first hello named %d features, want the whole %d", len(sent[0]), len(full))
	}
	if len(sent[1]) > older || slices.Contains(sent[1], protocol.FeatureExercisedLines) {
		t.Fatalf("hello after the refusal named %d features (exercisedLines %v)", len(sent[1]), slices.Contains(sent[1], protocol.FeatureExercisedLines))
	}
	if len(sent[2]) != len(full) {
		t.Fatalf("the hello after a trimmed session named %d features, want the whole %d again", len(sent[2]), len(full))
	}
	if !strings.Contains(h.logs.String(), "msg=hub.hello_features_refused") {
		t.Fatalf("the refusal is not logged:\n%s", h.logs.String())
	}
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
