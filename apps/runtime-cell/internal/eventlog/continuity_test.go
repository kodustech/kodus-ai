package eventlog

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
)

func TestNegotiatedPollRefusesMalformedCursorAndHeaders(t *testing.T) {
	for _, query := range []string{"after=no", "after=-1", "after=0&after=1", "after=0&wait=no", "after=0&wait=-1s"} {
		r := httptest.NewRequest(http.MethodGet, "/v1/alerts?"+query, nil)
		r.Header.Set("X-Kodus-Eventlog-Version", "1")
		ctx, cancel := context.WithCancel(r.Context())
		cancel()
		w := httptest.NewRecorder()
		New[int64](2).Handler()(w, r.WithContext(ctx))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("malformed query %s accepted: %d", query, w.Code)
		}
	}
}

func TestMetadataSnapshotStaysAtomicDuringEviction(t *testing.T) {
	l := New[int64](8)
	l.Add(func(seq int64) int64 { return seq })
	var writer sync.WaitGroup
	writer.Go(func() {
		for range 1000 {
			l.Add(func(seq int64) int64 { return seq })
		}
	})
	for range 1000 {
		s := l.read(context.Background(), 0, 0, "", false)
		if int64(len(s.events)) != s.latest-s.oldest+1 || s.events[0] != s.oldest || s.events[len(s.events)-1] != s.latest {
			t.Fatal("bounds and events came from different snapshots")
		}
	}
	writer.Wait()
}

// A restarted producer used to answer an old cursor with an empty healthy
// array; a bounded log also silently skipped entries evicted before a poll.
func TestNegotiatedPollDetectsRestartAndRetention(t *testing.T) {
	old := New[int64](10)
	for range 5 {
		old.Add(func(seq int64) int64 { return seq })
	}
	read := func(l *Log[int64], after int64, epoch string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/v1/alerts?after="+strconv.FormatInt(after, 10), nil)
		r.Header.Set("X-Kodus-Eventlog-Version", "1")
		if epoch != "" {
			r.Header.Set("X-Kodus-Eventlog-Epoch", epoch)
		}
		w := httptest.NewRecorder()
		l.Handler()(w, r)
		return w
	}
	first := read(old, 0, "")
	epoch := first.Header().Get("X-Kodus-Eventlog-Epoch")
	if epoch == "" || first.Header().Get("X-Kodus-Eventlog-Version") != "1" {
		t.Fatal("producer identity was not negotiated")
	}
	if first.Code != http.StatusOK || first.Header().Get("X-Kodus-Eventlog-Oldest") != "1" || first.Header().Get("X-Kodus-Eventlog-Latest") != "5" {
		t.Fatalf("first poll: %d %v", first.Code, first.Header())
	}
	fresh := New[int64](10)
	fresh.Add(func(seq int64) int64 { return seq })
	if got := read(fresh, 5, epoch); got.Code != http.StatusConflict || got.Header().Get("X-Kodus-Eventlog-Continuity") != "producer_restart" {
		t.Fatalf("restart accepted: %d %v", got.Code, got.Header())
	}
	bounded := New[int64](2)
	for range 5 {
		bounded.Add(func(seq int64) int64 { return seq })
	}
	if got := read(bounded, 0, ""); got.Code != http.StatusConflict || got.Header().Get("X-Kodus-Eventlog-Continuity") != "retention_gap" {
		t.Fatalf("retention loss accepted: %d %v", got.Code, got.Header())
	}
	if got := read(old, 6, epoch); got.Code != http.StatusConflict || got.Header().Get("X-Kodus-Eventlog-Continuity") != "cursor_invalid" {
		t.Fatalf("future cursor accepted: %d %v", got.Code, got.Header())
	}
}

func TestLegacyArrayAndAtomicMetadata(t *testing.T) {
	l := New[int64](2)
	for range 5 {
		l.Add(func(seq int64) int64 { return seq })
	}
	w := httptest.NewRecorder()
	l.Handler()(w, httptest.NewRequest(http.MethodGet, "/v1/events?after=0", nil))
	var got []int64
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK || len(got) != 2 || got[0] != 4 || got[1] != 5 {
		t.Fatalf("legacy array: %q %v", w.Body.String(), err)
	}
	if w.Header().Get("X-Kodus-Eventlog-Oldest") != "4" || w.Header().Get("X-Kodus-Eventlog-Latest") != "5" {
		t.Fatal("bounds absent or detached from returned snapshot")
	}
}
