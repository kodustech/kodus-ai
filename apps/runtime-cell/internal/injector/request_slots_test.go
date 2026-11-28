package injector

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// Completed claims used to retain a channel in the process map forever.
func TestRequestSlotsRetireIdleClaims(t *testing.T) {
	in := &Injector{}
	in.defaults()
	for i := range 1000 {
		release, err := in.acquire(context.Background(), fmt.Sprintf("claim-%d", i))
		if err != nil {
			t.Fatal(err)
		}
		release()
	}
	in.mu.Lock()
	retained := len(in.inFlight)
	in.mu.Unlock()
	if retained != 0 {
		t.Fatalf("retained %d completed claim entries", retained)
	}
}

type slotObservedContext struct {
	context.Context
	entered chan struct{}
	once    sync.Once
}

func (c *slotObservedContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.entered) })
	return c.Context.Done()
}

// Retiring an idle entry must account for callers already waiting on its
// semaphore; creating a second semaphore would defeat the per-claim limit.
func TestRequestSlotsKeepQueuedWaitersOnSameLimit(t *testing.T) {
	in := &Injector{MaxConcurrentPerClaim: 1}
	in.defaults()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first, err := in.acquire(ctx, "claim")
	if err != nil {
		t.Fatal(err)
	}
	waiterCtx := &slotObservedContext{Context: ctx, entered: make(chan struct{})}
	started := make(chan func(), 1)
	go func() {
		release, err := in.acquire(waiterCtx, "claim")
		if err == nil {
			started <- release
		}
	}()
	select {
	case <-waiterCtx.entered:
	case <-ctx.Done():
		t.Fatal("waiter did not register")
	}
	first()
	var second func()
	select {
	case second = <-started:
	case <-ctx.Done():
		t.Fatal("waiter did not acquire")
	}
	defer second()
	thirdCtx, cancelThird := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancelThird()
	if release, err := in.acquire(thirdCtx, "claim"); !errors.Is(err, context.DeadlineExceeded) {
		if release != nil {
			release()
		}
		t.Fatal("queued claim acquired a separate semaphore")
	}
}

func TestRequestSlotsCancelledWaiterReleasesOnlyItsReference(t *testing.T) {
	in := &Injector{MaxConcurrentPerClaim: 1}
	in.defaults()
	first, err := in.acquire(context.Background(), "claim")
	if err != nil {
		t.Fatal(err)
	}
	deadline, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	ctx, cancel := context.WithCancel(deadline)
	waiterCtx := &slotObservedContext{Context: ctx, entered: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		release, err := in.acquire(waiterCtx, "claim")
		if release != nil {
			release()
		}
		done <- err
	}()
	select {
	case <-waiterCtx.entered:
	case <-deadline.Done():
		t.Fatal("waiter did not register before deadline")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("waiter ignored cancellation")
		}
	case <-deadline.Done():
		t.Fatal("cancelled waiter did not exit before deadline")
	}
	in.mu.Lock()
	retained := len(in.inFlight)
	in.mu.Unlock()
	if retained != 1 {
		t.Fatal("active claim semaphore was removed")
	}
	first()
	in.mu.Lock()
	retained = len(in.inFlight)
	in.mu.Unlock()
	if retained != 0 {
		t.Fatal("idle cancelled claim semaphore remained")
	}
}

func TestRequestSlotsRefuseAlreadyCancelledCallers(t *testing.T) {
	in := &Injector{}
	in.defaults()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for range 100 {
		release, err := in.acquire(ctx, "cancelled")
		if release != nil {
			release()
		}
		if !errors.Is(err, context.Canceled) {
			t.Fatal("cancelled caller acquired capacity")
		}
	}
	in.mu.Lock()
	retained := len(in.inFlight)
	in.mu.Unlock()
	if retained != 0 {
		t.Fatal("cancelled caller allocated retained state")
	}
}
