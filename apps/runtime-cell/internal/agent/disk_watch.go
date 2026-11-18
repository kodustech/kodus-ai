package agent

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// The free-disk watchdog (review #7). Every claim's containers, volumes and
// logs share the filesystem of Docker's data root: a service that writes
// without end fills it, and then every tenant's claims on the cell fail.
// The log bound and the writable-layer cap (compose/sandbox) bound most of
// it; a named volume has no quota, so the watchdog is the last line: when
// the free space falls under the floor the cell stops its claims, a booting
// one with the cell_disk_full blocker, a ready or held one by tearing its
// machines down, which stops its writes and gives the disk back. The cell
// cannot tell cheaply which claim wrote the most, so at the floor it stops
// them all: they would all fail on a full disk anyway, with no reason
// given. Before that, docker-gvisor keeps a margin of one floor above it
// (dockergvisor diskfloor.go): no new workload, and a running build stops.
// Under that margin, with a driver that measures each claim's disk
// (driver.DiskUsageReader: its volumes and writable layers), the watchdog
// also stops the one claim whose disk grew the most since its last look,
// one per look (R3-03), so the claim that fills a volume fails alone. That
// stop is the claim's own doing and says so: resources/disk_top_writer,
// which excuses no PR's boot. Only the stop-everything at the floor says
// resources/cell_disk_full, the cell's fault (N7).

// DiskWatch is what the watchdog reads and its floor.
type DiskWatch struct {
	// Free is the free bytes of the filesystem Docker writes to (statfs of
	// its data root).
	Free func() (uint64, error)
	// MinFreeBytes is the floor: under it the cell stops its claims.
	MinFreeBytes uint64
	// Every is how often it looks (DefaultDiskWatchEvery when zero).
	Every time.Duration
}

// DefaultDiskWatchEvery is how often the watchdog looks when unset.
const DefaultDiskWatchEvery = 15 * time.Second

// watchDisk checks the disk every DiskWatch.Every until ctx ends.
func (a *Agent) watchDisk(ctx context.Context) {
	every := a.cfg.DiskWatch.Every
	if every <= 0 {
		every = DefaultDiskWatchEvery
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-a.clock.After(every):
		}
		a.checkDisk()
	}
}

// checkDisk stops every claim of the cell when the disk is under the floor;
// true when it was. A disk it cannot read stops nothing (logged).
func (a *Agent) checkDisk() bool {
	w := a.cfg.DiskWatch
	if w == nil || w.Free == nil {
		return false
	}
	free, err := w.Free()
	if err != nil {
		a.log.Warn("disk.watch_failed", "err", err)
		return false
	}
	if free >= w.MinFreeBytes {
		if free < 2*w.MinFreeBytes {
			a.relieveDisk(free, w.MinFreeBytes)
		} else {
			a.disk.forget()
		}
		return false
	}
	why := blockerErr(protocol.BlockerKindResources, "cell_disk_full", fmt.Errorf("the cell's Docker disk has %d MiB free, under its floor of %d MiB: the cell stopped its claims before the disk filled", free>>20, w.MinFreeBytes>>20))
	a.log.Error("disk.low", "alarm", true, "freeBytes", free, "minFreeBytes", w.MinFreeBytes)
	for _, c := range a.claims.All() {
		a.stopForDisk(c, why, free)
	}
	return true
}

// diskUsageTimeout bounds one measure of every claim's disk.
const diskUsageTimeout = time.Minute

// diskLooks is what the watchdog read of each claim's disk at its last look
// under the margin; busy keeps one look at a time (a look measures every
// volume, and may outlast a tick).
type diskLooks struct {
	busy atomic.Bool
	mu   sync.Mutex
	last map[string]int64
}

func (l *diskLooks) forget() {
	l.mu.Lock()
	l.last = nil
	l.mu.Unlock()
}

// grownMost records now and returns the claim whose disk grew the most since
// the last look, and by how much; "" when none grew or there was no look.
func (l *diskLooks) grownMost(now map[string]int64) (string, int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	last := l.last
	l.last = now
	top, grew := "", int64(0)
	for id, n := range now {
		before, seen := last[id]
		if seen && n-before > grew {
			top, grew = id, n-before
		}
	}
	return top, grew
}

// relieveDisk, with the disk under the margin, stops the claim whose disk
// grew the most since the last look, off the watchdog's loop.
func (a *Agent) relieveDisk(free, floor uint64) {
	users := a.cfg.Parts.DiskUsers
	if users == nil || !a.disk.busy.CompareAndSwap(false, true) {
		return
	}
	a.goTracked(func(ctx context.Context) {
		defer a.disk.busy.Store(false)
		mctx, cancel := context.WithTimeout(ctx, diskUsageTimeout)
		usage, err := users.ClaimDiskUsage(mctx)
		cancel()
		if err != nil {
			a.log.Warn("disk.usage_failed", "err", err)
			return
		}
		id, grew := a.disk.grownMost(usage)
		c, ok := a.claims.Get(id)
		if !ok {
			return
		}
		why := blockerErr(protocol.BlockerKindResources, "disk_top_writer", fmt.Errorf("the cell's Docker disk has %d MiB free, under the margin above its floor of %d MiB, and this claim's disk grew the most (%d MiB since the last look): the cell stopped it before the floor stops every claim", free>>20, floor>>20, grew>>20))
		a.stopForDisk(c, why, free)
	})
}

// stopForDisk stops one claim for the disk with blocker (resources/
// cell_disk_full at the floor, resources/disk_top_writer under the margin):
// a booting one fails with it (bringUp reports it as claim.failed and tears
// it down), a ready or held one has its machines torn down (the hub hears
// no blocker for a ready claim outside a security violation: its next step
// finds the claim gone). A failed or released one is torn down already.
func (a *Agent) stopForDisk(c *claims.Claim, blocker error, free uint64) {
	signature := failedBody(blocker).Signature
	switch c.State() {
	case claims.Acquiring:
		if c.Halt(blocker) {
			c.Log.Error("claim.disk_stopped", "alarm", true, "state", "acquiring", "signature", signature, "freeBytes", free)
		}
	case claims.Ready, claims.Held:
		c.Log.Error("claim.disk_stopped", "alarm", true, "state", c.State().String(), "signature", signature, "freeBytes", free)
		a.goTracked(func(ctx context.Context) { a.cleanup(ctx, c, signature) })
	case claims.Failed, claims.Released:
	}
}
