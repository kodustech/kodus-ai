package dockergvisor

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// What a crashed cell left past its claims' ceilings goes; a live claim's
// container and another cell's stay.
func TestSweepExpiredRemovesOnlyThisCellsContainersPastTheirCeiling(t *testing.T) {
	d, r, _ := newDriver(t, `{"runsc":{}}`)
	r.answers["ps"] = "b1\nb2\nb3\n"
	r.answers["inspect"] = `[
{"Id":"b1","Name":"/kodus-build-old","Config":{"Labels":{"kodus.cell":"cell-1","kodus.claim":"claim-1","kodus.hard-expires":"2026-11-04T19:14:34Z"}}},
{"Id":"b2","Name":"/kodus-build-live","Config":{"Labels":{"kodus.cell":"cell-1","kodus.claim":"claim-2","kodus.hard-expires":"2026-11-04T20:30:00Z"}}},
{"Id":"b3","Name":"/other","Config":{"Labels":{"kodus.cell":"cell-2","kodus.hard-expires":"2026-11-04T19:00:00Z"}}}]`
	gone, err := d.SweepExpired(context.Background(), time.Date(2026, 11, 4, 19, 40, 0, 0, time.UTC))
	if err != nil || len(gone) != 1 || gone[0] != "kodus-build-old" {
		t.Fatalf("%v %v", gone, err)
	}
	if f := r.find("rm", "-f", "b1"); f == nil || r.find("rm", "-f", "b2") != nil || r.find("rm", "-f", "b3") != nil {
		t.Fatalf("calls %v", r.calls)
	}
}

// blockingStates is a store whose eviction runs until the test lets it go.
type blockingStates struct {
	noStates
	evicting chan struct{}
	release  chan struct{}
	calls    atomic.Int32
}

func (b *blockingStates) Evict() error {
	b.calls.Add(1)
	b.evicting <- struct{}{}
	<-b.release
	return nil
}

// within fails the test unless ch delivers before the watchdog: a guard
// against a deadlock, never a wait for time to pass.
func within(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(10 * time.Second):
		t.Fatal(what)
	}
}

// A machine past its ceiling goes while a reclaim still removes gigabytes:
// Sweep ran ReclaimDisk inline after SweepExpired, so the next minute's
// sweep, and every expired machine with it, waited for the disk.
func TestSweepDoesNotWaitForTheDiskReclaim(t *testing.T) {
	d, r, _ := newDriver(t, `{"runsc":{}}`)
	r.answers["ps"] = "b1\n"
	r.answers["inspect"] = `[{"Id":"b1","Name":"/kodus-build-old","Config":{"Labels":{"kodus.cell":"cell-1","kodus.hard-expires":"2026-11-04T19:14:34Z"}}}]`
	// Buffered: a second reclaim run at once must show in calls, not deadlock.
	st := &blockingStates{evicting: make(chan struct{}, 4), release: make(chan struct{})}
	d.states = st
	released := false
	t.Cleanup(func() {
		if !released {
			close(st.release)
		}
	})
	now := time.Date(2026, 11, 4, 19, 40, 0, 0, time.UTC)

	swept := make(chan struct{})
	var gone []string
	go func() {
		gone, _ = d.Sweep(context.Background(), now)
		close(swept)
	}()
	within(t, st.evicting, "the reclaim never started")
	within(t, swept, "the sweep waited for the disk reclaim")
	if len(gone) != 1 || gone[0] != "kodus-build-old" {
		t.Fatalf("gone %v", gone)
	}
	// The next sweep, with the reclaim still running, starts no second one.
	if _, err := d.Sweep(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	close(st.release)
	released = true
	d.reclaim.wait()
	if n := st.calls.Load(); n != 1 {
		t.Fatalf("%d reclaims ran at once", n)
	}
	// Once it ended, the next sweep reclaims again.
	if _, err := d.Sweep(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	within(t, st.evicting, "the reclaim after the first one never started")
	d.reclaim.wait()
}
