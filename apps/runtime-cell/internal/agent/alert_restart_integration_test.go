package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type alertHTTP func(*http.Request) (*http.Response, error)

func (f alertHTTP) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// This is the original seq5→seq1 reproduction with the real eventlog,
// HTTP client and watcher. No cursor reset recovers or invents old events.
func TestAlertRestartRealFeedStopsTheUnobservedClaim(t *testing.T) {
	old, fresh := eventlog.New[injector.Alert](10), eventlog.New[injector.Alert](10)
	for range 5 {
		old.Add(func(seq int64) injector.Alert {
			return injector.Alert{Seq: seq, ClaimID: "old-claim", Kind: "bait_exfiltration"}
		})
	}
	fresh.Add(func(seq int64) injector.Alert {
		return injector.Alert{Seq: seq, ClaimID: "claim-target", Kind: "bait_exfiltration"}
	})
	current := old
	client := &injector.AlertClient{URL: "http://fixture.invalid", Wait: time.Nanosecond, HTTP: &http.Client{Transport: alertHTTP(func(r *http.Request) (*http.Response, error) {
		w := httptest.NewRecorder()
		current.Handler()(w, r)
		return w.Result(), nil
	})}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var h *harness
	polls := 0
	feed := sourceFunc(func(ctx context.Context, after int64) ([]Alert, error) {
		polls++
		if polls == 2 {
			h.ready("claim-target")
			current = fresh
		}
		if polls > 2 {
			cancel()
			return nil, ctx.Err()
		}
		got, err := client.After(ctx, after)
		out := make([]Alert, len(got))
		for i, v := range got {
			out[i] = Alert{Seq: v.Seq, ClaimID: v.ClaimID, Host: v.Host, Kind: v.Kind, At: v.At}
		}
		return out, err
	})
	h = newHarness(t, func(c *Config) { c.Alerts = feed })
	h.a.watchAlerts(ctx)
	h.a.Wait()
	if polls != 2 || h.a.claims.Len() != 0 || h.a.Heartbeat().FreeSlots != 0 {
		t.Fatal("restarted feed silently left a claim or reopened admission")
	}
	if !strings.Contains(h.logs.String(), "producer_restart") || strings.Contains(h.logs.String(), "claim.compromised") {
		t.Fatal("restart was not infrastructure failure")
	}
	if h.conn.attempts(func(f any) bool { _, ok := f.(*protocol.BlockedBody); return ok }) != 0 {
		t.Fatal("feed loss fabricated a blocked frame")
	}
	if got := fresh.After(context.Background(), 0, 0); len(got) != 1 || got[0].Seq != 1 {
		t.Fatal("the fresh alert was not actually buffered")
	}
}
