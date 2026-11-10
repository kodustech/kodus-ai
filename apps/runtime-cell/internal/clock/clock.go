// Package clock is the time source of the cell's control side: the agent,
// the leases and the certificate renewer read the time and wait through it,
// so tests run their retries and expiries without sleeping.
package clock

import (
	"sync"
	"time"
)

type Clock interface {
	Now() time.Time
	// After is time.After on this clock.
	After(d time.Duration) <-chan time.Time
}

// Real is the wall clock.
type Real struct{}

func (Real) Now() time.Time                         { return time.Now() }
func (Real) After(d time.Duration) <-chan time.Time { return time.After(d) }

// Fake is a manual clock. After never blocks: it moves the clock forward by
// d and fires at once, so a retry loop with backoff runs instantly and the
// time it "waited" shows in Now.
type Fake struct {
	mu sync.Mutex
	t  time.Time
}

func NewFake(t time.Time) *Fake { return &Fake{t: t} }

func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.t
}

func (f *Fake) Set(t time.Time) {
	f.mu.Lock()
	f.t = t
	f.mu.Unlock()
}

func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	f.t = f.t.Add(d)
	f.mu.Unlock()
}

func (f *Fake) After(d time.Duration) <-chan time.Time {
	f.Advance(d)
	ch := make(chan time.Time, 1)
	ch <- f.Now()
	return ch
}

// Or returns c, or the wall clock when c is nil.
func Or(c Clock) Clock {
	if c == nil {
		return Real{}
	}
	return c
}
