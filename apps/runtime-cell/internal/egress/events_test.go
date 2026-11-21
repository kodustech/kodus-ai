package egress

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
	"time"
)

// One claim that hammers a refused name pushes out its own oldest events,
// never another claim's: the other claim keeps its refusal for the failure
// bundle and its window of outbound evidence.
func TestAFloodingClaimDoesNotEvictAnotherClaimsEvents(t *testing.T) {
	e := NewEvents(100)
	e.Add(Event{ClaimID: "claim-b", Host: "registry.example", Reason: "not_allowed"})
	for i := 0; i < 1_000; i++ {
		e.Add(Event{ClaimID: "claim-a", Host: "refused.example", Reason: "not_allowed"})
	}
	e.Add(Event{ClaimID: "claim-b", Host: "api.example", Reason: "not_allowed"})
	got := e.After(context.Background(), 0, 0)
	if len(got) > 100 {
		t.Fatalf("kept %d events past the capacity", len(got))
	}
	var b []string
	for i, ev := range got {
		if i > 0 && ev.Seq <= got[i-1].Seq {
			t.Fatalf("out of order at %d: %d after %d", i, ev.Seq, got[i-1].Seq)
		}
		if ev.ClaimID == "claim-b" {
			b = append(b, ev.Host)
		}
	}
	if len(b) != 2 || b[0] != "registry.example" || b[1] != "api.example" {
		t.Fatalf("claim-b kept %v", b)
	}
	if last := got[len(got)-1]; last.Seq != 1_002 {
		t.Fatalf("last seq %d", last.Seq)
	}
}

// The control port serves one claim's events on ?claim=, all of them
// without it, and refuses a malformed cursor.
func TestEventsHandlerFiltersByClaim(t *testing.T) {
	e := NewEvents(10)
	e.Add(Event{ClaimID: "claim-a", Host: "a.example", Reason: "not_allowed"})
	e.Add(Event{ClaimID: "claim-b", Host: "b.example", Reason: "not_allowed"})
	get := func(q string) (int, []Event) {
		rec := httptest.NewRecorder()
		e.Handler()(rec, httptest.NewRequest(http.MethodGet, "/v1/events?"+q, nil))
		var evs []Event
		_ = json.NewDecoder(rec.Body).Decode(&evs)
		return rec.Code, evs
	}
	if code, evs := get("after=0"); code != http.StatusOK || len(evs) != 2 {
		t.Fatalf("all: %d %+v", code, evs)
	}
	if code, evs := get("after=0&claim=claim-b"); code != http.StatusOK || len(evs) != 1 || evs[0].Host != "b.example" {
		t.Fatalf("claim-b: %d %+v", code, evs)
	}
	if code, evs := get("after=1"); code != http.StatusOK || len(evs) != 1 || evs[0].Seq != 2 {
		t.Fatalf("after 1: %d %+v", code, evs)
	}
	if code, _ := get("after=x"); code != http.StatusBadRequest {
		t.Fatalf("bad cursor: %d", code)
	}
}

// A long poll returns as soon as an event comes in.
func TestEventsLongPollWakesOnAdd(t *testing.T) {
	e := NewEvents(10)
	done := make(chan []Event)
	go func() { done <- e.After(context.Background(), 0, 5*time.Second) }()
	time.Sleep(20 * time.Millisecond)
	e.Add(Event{ClaimID: "claim-a", Host: "a.example"})
	select {
	case got := <-done:
		if len(got) != 1 {
			t.Fatalf("%+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the long poll did not wake")
	}
}

// An add to a full log costs the same whatever its size: the proxy adds one
// for every connection it lets through and every one it refuses.
func TestAddingToAFullEventsLogDoesNotCopyIt(t *testing.T) {
	e := NewEvents(10_000)
	ev := Event{ClaimID: "claim-a", Host: "refused.example", Reason: "not_allowed"}
	for i := 0; i < 10_000; i++ {
		e.Add(ev)
	}
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	for i := 0; i < 1_000; i++ {
		e.Add(ev)
	}
	runtime.ReadMemStats(&after)
	if grew := after.TotalAlloc - before.TotalAlloc; grew > 4<<20 {
		t.Fatalf("1000 adds to a full log allocated %d bytes", grew)
	}
}

func BenchmarkEventsAddToAFullLog(b *testing.B) {
	e := NewEvents(10_000)
	ev := Event{ClaimID: "claim-a", Host: "refused.example", Reason: "not_allowed"}
	for i := 0; i < 10_000; i++ {
		e.Add(ev)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		e.Add(ev)
	}
}
