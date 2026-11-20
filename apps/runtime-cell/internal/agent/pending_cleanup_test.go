package agent

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// racingRemovalDriver removes a machine as Docker does: a second destroy of
// a machine another destroy is still removing fails with the daemon's
// "removal ... already in progress". The release's first destroy waits for
// the test; a destroy that starts while it waits (a sweep) stays in
// progress until the release is over.
type racingRemovalDriver struct {
	*fake.Driver
	mu           sync.Mutex
	removing     map[string]bool
	calls        int
	firstStarted chan struct{}
	letFirstGo   chan struct{}
	sweepStarted chan struct{}
	releaseDone  chan struct{}
}

func (d *racingRemovalDriver) ClaimMemory(driver.ClaimSize) driver.ClaimMemory {
	return driver.ClaimMemory{BootMB: 4096, ReadyMB: 4096}
}

func (d *racingRemovalDriver) Destroy(ctx context.Context, r driver.MachineRef) error {
	d.mu.Lock()
	if d.removing[r.MachineID] {
		d.mu.Unlock()
		return errors.New("Error response from daemon: removal of container " + r.MachineID + " is already in progress")
	}
	d.removing[r.MachineID] = true
	d.calls++
	call := d.calls
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.removing, r.MachineID)
		d.mu.Unlock()
	}()
	switch {
	case call == 1: // the release's first machine
		close(d.firstStarted)
		<-d.letFirstGo
	case !d.firstDone():
		select {
		case d.sweepStarted <- struct{}{}:
		default:
		}
		<-d.releaseDone
	}
	return d.Driver.Destroy(ctx, r)
}

func (d *racingRemovalDriver) firstDone() bool {
	select {
	case <-d.letFirstGo:
		return true
	default:
		return false
	}
}

// A sweep ran while a release destroyed the claim's machines: it took the
// rest for machines no one held and removed one, the release's docker rm of
// it failed on a removal already in progress, and the cell held the claim's
// 2 GB until it restarted, so no PR side fit again (dev cell, 2026-11-19).
// A release concurrent with a sweep ends with nothing committed and no hold.
func TestAReleaseConcurrentWithASweepGivesItsMemoryBack(t *testing.T) {
	var drv *racingRemovalDriver
	h := newHarness(t, func(c *Config) {
		drv = &racingRemovalDriver{
			Driver: c.Driver.(*fake.Driver), removing: map[string]bool{},
			firstStarted: make(chan struct{}), letFirstGo: make(chan struct{}),
			sweepStarted: make(chan struct{}, 1), releaseDone: make(chan struct{}),
		}
		c.Driver, c.Parts.Memory = drv, drv
		c.MemoryAllocatableMB = 4096
		c.RequireMemoryAdmission = true
	})
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureCellMemory}})
	h.ready("claim-1")
	if err := h.handle("claim-1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	<-drv.firstStarted
	swept := make(chan struct{})
	go func() {
		defer close(swept)
		_, _ = h.a.leases.Sweep(context.Background())
	}()
	select { // the sweep either leaves the claim alone or starts removing one of its machines
	case <-swept:
	case <-drv.sweepStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("the sweep neither returned nor destroyed anything")
	}
	close(drv.letFirstGo)
	waitFor(t, func() bool { _, ok := h.a.claims.Get("claim-1"); return !ok })
	close(drv.releaseDone)
	<-swept
	h.a.settlePendingCleanups(context.Background()) // the next sweep tick
	if got, holds := h.a.mem.Committed(), h.a.mem.Holds(); got != 0 || holds != 0 {
		t.Fatalf("after the release and a sweep tick: %d MB committed, %d hold(s)", got, holds)
	}
}

// flakyRemovalDriver cannot confirm any destroy until the daemon recovers.
type flakyRemovalDriver struct {
	*fake.Driver
	mu     sync.Mutex
	broken bool
}

func (d *flakyRemovalDriver) ClaimMemory(driver.ClaimSize) driver.ClaimMemory {
	return driver.ClaimMemory{BootMB: 4096, ReadyMB: 4096}
}

func (d *flakyRemovalDriver) Destroy(ctx context.Context, r driver.MachineRef) error {
	d.mu.Lock()
	broken := d.broken
	d.mu.Unlock()
	if broken {
		return errors.New("daemon could not confirm container removal")
	}
	return d.Driver.Destroy(ctx, r)
}

func (d *flakyRemovalDriver) heal() {
	d.mu.Lock()
	d.broken = false
	d.mu.Unlock()
}

// An unconfirmed release keeps the claim's memory held (the quarantine),
// and the hold used to have no end: its release was dropped. The sweep tick
// after the machines are confirmed gone lets the memory go; one before that
// keeps it.
func TestAQuarantinedReleaseLetsItsMemoryGoOnceTheMachinesAreGone(t *testing.T) {
	var drv *flakyRemovalDriver
	h := newHarness(t, func(c *Config) {
		drv = &flakyRemovalDriver{Driver: c.Driver.(*fake.Driver)}
		c.Driver, c.Parts.Memory = drv, drv
		c.MemoryAllocatableMB = 4096
		c.RequireMemoryAdmission = true
	})
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureCellMemory}})
	h.ready("claim-1")
	drv.mu.Lock()
	drv.broken = true
	drv.mu.Unlock()
	if err := h.handle("claim-1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { _, ok := h.a.claims.Get("claim-1"); return !ok })
	h.a.settlePendingCleanups(context.Background())
	if got := h.a.mem.Committed(); got != 4096 {
		t.Fatalf("memory let go before its machines were confirmed gone: %d MB committed", got)
	}
	drv.heal()
	h.a.settlePendingCleanups(context.Background())
	if got, holds := h.a.mem.Committed(), h.a.mem.Holds(); got != 0 || holds != 0 {
		t.Fatalf("machines gone, memory still held: %d MB committed, %d hold(s)", got, holds)
	}
	if len(drv.Machines()) != 0 {
		t.Fatalf("machines left: %v", drv.Machines())
	}
	if err := h.handle("claim-2", protocol.MessageTypeClaimAcquire, h.acquireBody()); err != nil {
		t.Fatalf("the freed memory does not admit the next claim: %v", err)
	}
}
