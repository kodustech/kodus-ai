package mirror

import (
	"context"
	"sync"
)

// flightGroup runs one fetch per key at a time; requests for a key that is
// already being fetched wait for that fetch instead of starting their own.
//
// The fetch runs in its own goroutine, not on the request that started it:
// a builder that disconnects does not cancel a download others wait on, and
// the finished blob still fills the cache for the next claim.
type flightGroup struct {
	mu    sync.Mutex
	calls map[string]*flight
}

type flight struct {
	done    chan struct{}
	err     error
	waiters int
}

// do runs fn for key unless a run is in flight, then waits for the run's
// result or ctx, whichever comes first.
func (g *flightGroup) do(ctx context.Context, key string, fn func() error) error {
	g.mu.Lock()
	if g.calls == nil {
		g.calls = map[string]*flight{}
	}
	f, ok := g.calls[key]
	if !ok {
		f = &flight{done: make(chan struct{})}
		g.calls[key] = f
		go func() {
			f.err = fn()
			g.mu.Lock()
			delete(g.calls, key)
			g.mu.Unlock()
			close(f.done)
		}()
	}
	f.waiters++
	g.mu.Unlock()
	select {
	case <-f.done:
		return f.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// waiting is how many requests joined the run in flight for key (tests).
func (g *flightGroup) waiting(key string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	if f, ok := g.calls[key]; ok {
		return f.waiters
	}
	return 0
}
