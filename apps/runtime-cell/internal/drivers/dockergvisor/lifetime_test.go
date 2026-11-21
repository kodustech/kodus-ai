package dockergvisor

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/remotecache"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lifecycle"
)

// pastDeadline is a shutdown deadline that has already passed.
func pastDeadline() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

// stillRunning fails the test if ch delivers within a short window: what a
// stop must not do while work it waits for still runs.
func stillRunning[T any](t *testing.T, ch <-chan T, what string) {
	t.Helper()
	select {
	case v := <-ch:
		t.Fatalf("%s (%v)", what, v)
	case <-time.After(20 * time.Millisecond):
	}
}

// reclaiming is a driver whose sweep started a disk reclaim that runs until
// the test lets it go.
func reclaiming(t *testing.T) (*Driver, *blockingStates) {
	t.Helper()
	d, _, err := newDriver(t, `{"runsc":{}}`)
	if err != nil {
		t.Fatal(err)
	}
	st := &blockingStates{evicting: make(chan struct{}, 4), release: make(chan struct{})}
	d.states = st
	if _, err := d.Sweep(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}
	within(t, st.evicting, "the reclaim never started")
	return d, st
}

// The cell used to close the catalog while a reclaim still removed BuildKit
// states (Close waited for nothing): Shutdown waits for it.
func TestShutdownWaitsForTheDiskReclaimInFlight(t *testing.T) {
	d, st := reclaiming(t)
	shut := make(chan error, 1)
	go func() { shut <- d.Shutdown(context.Background()) }()
	stillRunning(t, shut, "Shutdown returned while a reclaim runs")
	close(st.release)
	if err := <-shut; err != nil {
		t.Fatal(err)
	}
	// A closed driver starts no reclaim.
	if _, err := d.Sweep(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if n := st.calls.Load(); n != 1 {
		t.Fatalf("%d reclaims ran, want the one before Shutdown", n)
	}
}

func TestShutdownGivesUpOnAReclaimAtTheDeadline(t *testing.T) {
	d, st := reclaiming(t)
	t.Cleanup(func() { close(st.release) })
	err := d.Shutdown(pastDeadline())
	if !errors.Is(err, lifecycle.ErrGaveUp) || !strings.Contains(err.Error(), "disk reclaim") {
		t.Fatalf("Shutdown: %v", err)
	}
}

// blockingRemote is a store off the cell whose push runs until the test
// lets it go or its context ends.
type blockingRemote struct {
	fakeRemote
	pushing  chan struct{}
	release  chan struct{}
	canceled atomic.Bool
}

func (b *blockingRemote) Push(ctx context.Context, k remotecache.Key, dir string) (remotecache.Stats, error) {
	b.pushing <- struct{}{}
	select {
	case <-b.release:
		return b.fakeRemote.Push(ctx, k, dir)
	case <-ctx.Done():
		b.canceled.Store(true)
		return remotecache.Stats{}, ctx.Err()
	}
}

// pushing is a driver whose seeding setup's cache push is in flight.
func pushing(t *testing.T) (*Driver, *blockingRemote) {
	t.Helper()
	d, _, _ := statefulDriver(t)
	remote := &blockingRemote{pushing: make(chan struct{}, 1), release: make(chan struct{})}
	d.remote = remote
	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, true)
	boot(t, d, setup, sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"})
	within(t, remote.pushing, "the seed never pushed")
	return d, remote
}

// A push ran on context.Background with a 30 minute timeout, past the
// driver's Close: Shutdown lets it finish, then ends it at the deadline.
func TestShutdownLetsAPushFinishAndEndsItAtTheDeadline(t *testing.T) {
	t.Run("finishes", func(t *testing.T) {
		d, remote := pushing(t)
		shut := make(chan error, 1)
		go func() { shut <- d.Shutdown(context.Background()) }()
		stillRunning(t, shut, "Shutdown returned while a push runs")
		close(remote.release)
		if err := <-shut; err != nil {
			t.Fatal(err)
		}
		if remote.canceled.Load() || len(remote.pushes) != 1 {
			t.Fatalf("the push was cut (canceled %v, pushes %d)", remote.canceled.Load(), len(remote.pushes))
		}
	})
	t.Run("ends at the deadline", func(t *testing.T) {
		d, remote := pushing(t)
		err := d.Shutdown(pastDeadline())
		if !errors.Is(err, lifecycle.ErrGaveUp) || !strings.Contains(err.Error(), "build cache push") {
			t.Fatalf("Shutdown: %v", err)
		}
		d.WaitRemotePushes()
		if !remote.canceled.Load() {
			t.Fatal("the push's context outlived the driver")
		}
	})
}
