// Package dedup keeps the steps a cell has seen for an hour, so a step is
// executed at most once (docs §1b "Entrega do passo").
package dedup

import (
	"crypto/sha256"
	"sync"
	"time"
)

type Verdict int

const (
	// New: never seen; run it.
	New Verdict = iota
	// Duplicate: same claim, stepId and command hash; do not run again.
	Duplicate
	// Conflict: the stepId was seen with another command or another claim;
	// the frame gets a nack (S-30).
	Conflict
	// Refused: new work did not pass admission and was not recorded.
	Refused
)

func (v Verdict) String() string {
	return [...]string{"new", "duplicate", "conflict", "refused"}[v]
}

const DefaultTTL = time.Hour

type entry struct {
	claim string
	hash  [32]byte
	at    time.Time
}

type Store struct {
	mu   sync.Mutex
	ttl  time.Duration
	now  func() time.Time
	seen map[string]entry // by stepId: hub UUIDs are global, not per claim
	// gcAt is when entries past the TTL were last dropped: at most once a
	// minute, so a step costs O(1) and not a scan of the hour.
	gcAt time.Time
}

func NewStore(ttl time.Duration, now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{ttl: ttl, now: now, seen: map[string]entry{}}
}

// Admit records the step and says what to do with it. command is the
// canonical bytes of what the step runs (command and cwd, or the probe).
// Call it last, once every other admission check passed: a step recorded
// here and then refused would be acked as a Duplicate on the hub's retry
// and never run.
func (s *Store) Admit(claimID, stepID string, command []byte) Verdict {
	return s.AdmitIf(claimID, stepID, command, nil)
}

// AdmitIf checks existing entries first and records new work only when
// reserve accepts it. reserve runs under the store lock: it must not block,
// perform I/O, or call the store again.
func (s *Store) AdmitIf(claimID, stepID string, command []byte, reserve func() bool) Verdict {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.gc(now)
	h := sha256.Sum256(command)
	if e, ok := s.seen[stepID]; ok && now.Sub(e.at) <= s.ttl {
		if e.claim == claimID && e.hash == h {
			return Duplicate
		}
		return Conflict
	}
	if reserve != nil && !reserve() {
		return Refused
	}
	s.seen[stepID] = entry{claim: claimID, hash: h, at: now}
	return New
}

func (s *Store) gc(now time.Time) {
	if now.Sub(s.gcAt) < time.Minute {
		return
	}
	s.gcAt = now
	for k, e := range s.seen {
		if now.Sub(e.at) > s.ttl {
			delete(s.seen, k)
		}
	}
}

func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.seen)
}
