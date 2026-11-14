// Package eventlog is the bounded, sequenced log a data-plane component
// keeps for the cell agent to poll (the proxy's denials, the injector's
// alerts): every entry gets the next sequence number, the oldest fall off,
// and a reader long-polls for anything after the last number it saw.
package eventlog

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// MaxWait caps a long poll.
const MaxWait = 30 * time.Second

type entry[T any] struct {
	seq int64
	v   T
}

type Log[T any] struct {
	mu    sync.Mutex
	seq   int64
	buf   []entry[T]
	max   int
	wake  chan struct{}
	epoch string
}

func New[T any](max int) *Log[T] {
	if max < 1 {
		max = 1
	}
	return &Log[T]{max: max, wake: make(chan struct{}), epoch: rand.Text()}
}

// Add appends the entry build makes with its sequence number.
func (l *Log[T]) Add(build func(seq int64) T) {
	l.mu.Lock()
	l.seq++
	l.buf = append(l.buf, entry[T]{seq: l.seq, v: build(l.seq)})
	if len(l.buf) > l.max {
		// Copy so the backing array does not keep every entry ever added.
		l.buf = append([]entry[T](nil), l.buf[len(l.buf)-l.max:]...)
	}
	close(l.wake)
	l.wake = make(chan struct{})
	l.mu.Unlock()
}

// After returns the entries with a sequence above after, waiting up to wait
// for one.
func (l *Log[T]) After(ctx context.Context, after int64, wait time.Duration) []T {
	return l.read(ctx, after, wait, "", false).events
}

type snapshot[T any] struct {
	epoch          string
	oldest, latest int64
	events         []T
	reason         Reason
}

// read checks continuity and copies the entries and their bounds together.
// A long poll repeats that check after every wake, including eviction.
func (l *Log[T]) read(ctx context.Context, after int64, wait time.Duration, expected string, strict bool) snapshot[T] {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		l.mu.Lock()
		s := snapshot[T]{epoch: l.epoch, oldest: l.seq + 1, latest: l.seq, reason: ReasonOK}
		if len(l.buf) > 0 {
			s.oldest = l.buf[0].seq
		}
		if strict {
			switch {
			case expected != "" && expected != l.epoch:
				s.reason = ReasonProducerRestart
			case after < 0 || after > l.seq:
				s.reason = ReasonCursorInvalid
			case after < s.oldest-1:
				s.reason = ReasonRetentionGap
			}
		}
		for _, e := range l.buf {
			if s.reason == ReasonOK && e.seq > after {
				s.events = append(s.events, e.v)
			}
		}
		wake := l.wake
		l.mu.Unlock()
		if s.reason != ReasonOK || len(s.events) > 0 || wait <= 0 || ctx.Err() != nil {
			return s
		}
		select {
		case <-wake:
		case <-timer.C:
			wait = 0
		case <-ctx.Done():
			wait = 0
		}
	}
}

// Handler serves GET ?after=<seq>&wait=<duration> as a JSON array.
func (l *Log[T]) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		after, afterErr := strconv.ParseInt(q.Get("after"), 10, 64)
		wait, waitErr := time.ParseDuration(q.Get("wait"))
		wait = min(wait, MaxWait)
		strict := r.Header.Get(HeaderVersion) != ""
		expected := r.Header.Get(HeaderEpoch)
		if strict && (len(r.Header.Values(HeaderVersion)) != 1 || r.Header.Get(HeaderVersion) != Version || len(r.Header.Values(HeaderEpoch)) > 1 || len(expected) > 64 ||
			len(q["after"]) != 1 || afterErr != nil || after < 0 || strconv.FormatInt(after, 10) != q.Get("after") || len(q["wait"]) > 1 || (len(q["wait"]) == 1 && (waitErr != nil || wait < 0))) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("[]\n"))
			return
		}
		s := l.read(r.Context(), after, wait, expected, strict)
		if s.events == nil {
			s.events = []T{}
		}
		w.Header().Set(HeaderVersion, Version)
		w.Header().Set(HeaderEpoch, s.epoch)
		w.Header().Set(HeaderOldest, strconv.FormatInt(s.oldest, 10))
		w.Header().Set(HeaderLatest, strconv.FormatInt(s.latest, 10))
		w.Header().Set(HeaderContinuity, string(s.reason))
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		if s.reason != ReasonOK {
			w.WriteHeader(http.StatusConflict)
		}
		_ = json.NewEncoder(w).Encode(s.events)
	}
}
