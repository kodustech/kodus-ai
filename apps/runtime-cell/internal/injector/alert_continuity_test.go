package injector

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
)

type feedTransport func(*http.Request) (*http.Response, error)

func (f feedTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestAlertClientDetectsRestartRetentionAndLegacy(t *testing.T) {
	for _, scenario := range []string{"restart", "retention", "legacy"} {
		t.Run(scenario, func(t *testing.T) {
			l := eventlog.New[Alert](2)
			c := AlertClient{URL: "http://feed.invalid", Wait: time.Nanosecond, HTTP: &http.Client{Transport: feedTransport(func(r *http.Request) (*http.Response, error) {
				w := httptest.NewRecorder()
				if l == nil {
					w.WriteString("[]")
				} else {
					l.Handler()(w, r)
				}
				return w.Result(), nil
			})}}
			if got, err := c.After(context.Background(), 0); err != nil || len(got) != 0 {
				t.Fatalf("handshake: %v %v", got, err)
			}
			switch scenario {
			case "restart":
				l = eventlog.New[Alert](2)
			case "retention":
				for range 3 {
					l.Add(func(seq int64) Alert { return Alert{Seq: seq} })
				}
			case "legacy":
				l = nil
			}
			got, err := c.After(context.Background(), 0)
			if err == nil || len(got) != 0 {
				t.Fatalf("loss accepted: %v %v", got, err)
			}
			var feedErr *eventlog.FeedError
			if !errors.As(err, &feedErr) {
				t.Fatalf("untyped loss: %T", err)
			}
			if scenario != "legacy" && !eventlog.HistoryLost(err) {
				t.Fatal("history loss not reported")
			}
		})
	}
}

func TestAlertClientSerializesConcurrentCursorProgress(t *testing.T) {
	l := eventlog.New[Alert](2)
	l.Add(func(seq int64) Alert { return Alert{Seq: seq} })
	c := AlertClient{URL: "http://feed.invalid", HTTP: &http.Client{Transport: feedTransport(func(r *http.Request) (*http.Response, error) {
		w := httptest.NewRecorder()
		l.Handler()(w, r)
		return w.Result(), nil
	})}}
	var callers sync.WaitGroup
	outcomes := make(chan error, 2)
	for range 2 {
		callers.Go(func() { _, err := c.After(context.Background(), 0); outcomes <- err })
	}
	callers.Wait()
	close(outcomes)
	passed, stale := 0, 0
	for err := range outcomes {
		if err == nil {
			passed++
		} else if eventlog.FailureReason(err) == eventlog.ReasonCursorInvalid {
			stale++
		} else {
			t.Fatal(err)
		}
	}
	if passed != 1 || stale != 1 {
		t.Fatalf("concurrent callers moved/replayed one cursor: %d %d", passed, stale)
	}
}

func TestAlertClientRefusesUnverifiableResponses(t *testing.T) {
	for _, scenario := range []string{"initial_legacy", "duplicate_header", "trailing_json", "oversized", "missing_sequence"} {
		t.Run(scenario, func(t *testing.T) {
			l := eventlog.New[Alert](2)
			l.Add(func(seq int64) Alert { return Alert{Seq: seq} })
			c := AlertClient{URL: "http://feed.invalid", HTTP: &http.Client{Transport: feedTransport(func(r *http.Request) (*http.Response, error) {
				w := httptest.NewRecorder()
				l.Handler()(w, r)
				res := w.Result()
				switch scenario {
				case "initial_legacy":
					res.Header.Del(eventlog.HeaderVersion)
				case "duplicate_header":
					res.Header.Add(eventlog.HeaderEpoch, "untrusted")
				case "trailing_json":
					w.Body.WriteString("[]")
				case "oversized":
					w.Body.WriteString(strings.Repeat(" ", maxAlertsBody))
				case "missing_sequence":
					w.Body.Reset()
					w.Body.WriteString("[]")
				}
				res.Body = io.NopCloser(strings.NewReader(w.Body.String()))
				return res, nil
			})}}
			if got, err := c.After(context.Background(), 0); err == nil || len(got) != 0 {
				t.Fatalf("unverifiable response accepted: %v %v", got, err)
			}
		})
	}
}
