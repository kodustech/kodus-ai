package injector

import "context"

// refs includes both active requests and waiters. An idle semaphore can be
// removed only after the last reference leaves; otherwise a new caller could
// create a second semaphore while an old waiter still uses the first one.
type claimRequestSlots struct {
	semaphore chan struct{}
	refs      int
}

// acquire takes one slot. The returned release must be called exactly once.
func (in *Injector) acquire(ctx context.Context, claim string) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	in.mu.Lock()
	entry := in.inFlight[claim]
	if entry == nil {
		entry = &claimRequestSlots{semaphore: make(chan struct{}, in.MaxConcurrentPerClaim)}
		in.inFlight[claim] = entry
	}
	entry.refs++
	in.mu.Unlock()
	select {
	case entry.semaphore <- struct{}{}:
		release := func() { <-entry.semaphore; in.releaseClaimReference(claim, entry) }
		if err := ctx.Err(); err != nil {
			release()
			return nil, err
		}
		return release, nil
	case <-ctx.Done():
		in.releaseClaimReference(claim, entry)
		return nil, ctx.Err()
	}
}

func (in *Injector) releaseClaimReference(claim string, entry *claimRequestSlots) {
	in.mu.Lock()
	defer in.mu.Unlock()
	entry.refs--
	if entry.refs == 0 && in.inFlight[claim] == entry {
		delete(in.inFlight, claim)
	}
}
