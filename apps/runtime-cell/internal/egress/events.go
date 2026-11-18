package egress

import (
	"cmp"
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
)

// Event is one connection the proxy refused (egress.blocked), or one it let
// through (Reason "allowed", the Connections log).
type Event struct {
	Seq     int64     `json:"seq"`
	ClaimID string    `json:"claimId,omitempty"`
	Host    string    `json:"host"`
	SNI     string    `json:"sni,omitempty"`
	Port    int       `json:"port"`
	Phase   string    `json:"phase,omitempty"`
	Reason  string    `json:"reason"`
	At      time.Time `json:"at"`
}

// Events is the bounded log the control port serves. Every claim shares one
// sequence and one capacity, but a full log drops the oldest event of the
// claim that holds the most: a claim that hammers a refused name pushes out
// its own history, never another claim's refusals or outbound evidence.
// It is a snapshot a reader filters by claim, not a continuity feed: there
// is no single oldest sequence, so a strict eventlog reader is refused.
type Events struct {
	mu      sync.Mutex
	seq     int64
	max     int
	total   int
	byClaim map[string]*claimEvents
	wake    chan struct{}
	watched bool
}

// claimEvents is one claim's events, oldest first, from head on.
type claimEvents struct {
	buf  []Event
	head int
}

func (c *claimEvents) len() int { return len(c.buf) - c.head }

func (c *claimEvents) dropOldest() {
	c.buf[c.head] = Event{}
	c.head++
	// Compact once half the slice is dropped: amortized O(1) per event.
	if c.head > len(c.buf)/2 {
		c.buf = append(c.buf[:0], c.buf[c.head:]...)
		c.head = 0
	}
}

func NewEvents(capacity int) *Events {
	return &Events{max: max(capacity, 1), byClaim: map[string]*claimEvents{}, wake: make(chan struct{})}
}

func (e *Events) Add(ev Event) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.seq++
	ev.Seq = e.seq
	c := e.byClaim[ev.ClaimID]
	if c == nil {
		c = &claimEvents{}
		e.byClaim[ev.ClaimID] = c
	}
	c.buf = append(c.buf, ev)
	e.total++
	if e.total > e.max {
		e.evictLocked()
	}
	if e.watched {
		close(e.wake)
		e.wake, e.watched = make(chan struct{}), false
	}
}

// evictLocked drops the oldest event of the claim holding the most (on a
// tie, the one whose oldest event is older).
func (e *Events) evictLocked() {
	var key string
	var big *claimEvents
	for k, c := range e.byClaim {
		if big == nil || c.len() > big.len() || (c.len() == big.len() && c.buf[c.head].Seq < big.buf[big.head].Seq) {
			key, big = k, c
		}
	}
	big.dropOldest()
	e.total--
	if big.len() == 0 {
		delete(e.byClaim, key)
	}
}

// After returns events with Seq > after, oldest first, waiting up to wait
// for one.
func (e *Events) After(ctx context.Context, after int64, wait time.Duration) []Event {
	return e.read(ctx, after, wait, "", false)
}

func (e *Events) read(ctx context.Context, after int64, wait time.Duration, claim string, oneClaim bool) []Event {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		e.mu.Lock()
		var out []Event
		collect := func(c *claimEvents) {
			for _, ev := range c.buf[c.head:] {
				if ev.Seq > after {
					out = append(out, ev)
				}
			}
		}
		if oneClaim {
			if c := e.byClaim[claim]; c != nil {
				collect(c)
			}
		} else {
			for _, c := range e.byClaim {
				collect(c)
			}
			slices.SortFunc(out, func(a, b Event) int { return cmp.Compare(a.Seq, b.Seq) })
		}
		if len(out) > 0 || wait <= 0 || ctx.Err() != nil {
			e.mu.Unlock()
			return out
		}
		wake := e.wake
		e.watched = true
		e.mu.Unlock()
		select {
		case <-wake:
		case <-timer.C:
			wait = 0
		case <-ctx.Done():
			wait = 0
		}
	}
}

// Handler serves GET ?after=<seq>[&wait=<duration>][&claim=<id>] as a JSON
// array, oldest first; claim limits it to one claim's events.
func (e *Events) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		after, err := strconv.ParseInt(q.Get("after"), 10, 64)
		var wait time.Duration
		if err == nil && q.Has("wait") {
			wait, err = time.ParseDuration(q.Get("wait"))
		}
		if err != nil || after < 0 || wait < 0 || len(q["after"]) != 1 || len(q["wait"]) > 1 || len(q["claim"]) > 1 || r.Header.Get(eventlog.HeaderVersion) != "" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("[]\n"))
			return
		}
		out := e.read(r.Context(), after, min(wait, eventlog.MaxWait), q.Get("claim"), q.Has("claim"))
		if out == nil {
			out = []Event{}
		}
		_ = json.NewEncoder(w).Encode(out)
	}
}
