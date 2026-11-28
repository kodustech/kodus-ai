package toollayer

import (
	"fmt"
	"sync"
	"time"
)

// Build admission (design 4.5): one build of a key at a time, at most one
// build on the cell and two per org, and no retry for 10 minutes after a
// failure, so a CLI that cannot be built never loops the cell.
const (
	failureMemory = 10 * time.Minute
	maxCellBuilds = 1
	maxOrgBuilds  = 2
)

// BuildRefusal says why a build did not start: in_flight, recent_failure,
// cell_busy or org_busy.
type BuildRefusal struct{ Reason string }

func (e *BuildRefusal) Error() string { return "toollayer: build refused: " + e.Reason }

// Builds is the admission of builds. Its state is memory only: a cell restart
// ends every builder, so nothing is left to remember but a recent failure,
// which a restart may retry.
type Builds struct {
	now             func() time.Time
	cellMax, orgMax int

	mu       sync.Mutex
	running  map[string]bool // org + "\x00" + key
	perOrg   map[string]int
	failedAt map[string]time.Time
}

// NewBuilds is an empty admission; now is the clock (time.Now when nil).
func NewBuilds(now func() time.Time) *Builds {
	return NewBuildsLimits(now, maxCellBuilds, maxOrgBuilds)
}

// NewBuildsLimits is NewBuilds with other concurrency limits (tests).
func NewBuildsLimits(now func() time.Time, cell, org int) *Builds {
	if now == nil {
		now = time.Now
	}
	return &Builds{now: now, cellMax: cell, orgMax: org, running: map[string]bool{}, perOrg: map[string]int{}, failedAt: map[string]time.Time{}}
}

// Begin admits a build of key for org, or refuses it. The returned end must
// be called once; failed starts the 10 minute memory of a failure.
func (b *Builds) Begin(org, key string) (end func(failed bool), err error) {
	if org == "" || !hexRe.MatchString(key) {
		return nil, fmt.Errorf("toollayer: a build needs an org and a sha256 key")
	}
	id := org + "\x00" + key
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	// Failures older than the memory are forgotten here, so the map stays small.
	for k, at := range b.failedAt {
		if now.Sub(at) >= failureMemory {
			delete(b.failedAt, k)
		}
	}
	switch {
	case b.running[id]:
		return nil, &BuildRefusal{Reason: "in_flight"}
	case !b.failedAt[id].IsZero():
		return nil, &BuildRefusal{Reason: "recent_failure"}
	case len(b.running) >= b.cellMax:
		return nil, &BuildRefusal{Reason: "cell_busy"}
	case b.perOrg[org] >= b.orgMax:
		return nil, &BuildRefusal{Reason: "org_busy"}
	}
	b.running[id] = true
	b.perOrg[org]++
	var once sync.Once
	return func(failed bool) {
		once.Do(func() {
			b.mu.Lock()
			defer b.mu.Unlock()
			delete(b.running, id)
			if b.perOrg[org]--; b.perOrg[org] <= 0 {
				delete(b.perOrg, org)
			}
			if failed {
				b.failedAt[id] = b.now()
			}
		})
	}, nil
}
