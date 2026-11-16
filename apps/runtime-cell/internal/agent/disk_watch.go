package agent

import (
	"context"
	"fmt"
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
// cannot tell which claim wrote the most (Docker reports no per-claim
// volume size cheaply), so it stops them all: they would all fail on a full
// disk anyway, with no reason given.

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
		return false
	}
	why := fmt.Errorf("the cell's Docker disk has %d MiB free, under its floor of %d MiB: the cell stopped its claims before the disk filled", free>>20, w.MinFreeBytes>>20)
	a.log.Error("disk.low", "alarm", true, "freeBytes", free, "minFreeBytes", w.MinFreeBytes)
	for _, c := range a.claims.All() {
		switch c.State() {
		case claims.Acquiring:
			// bringUp reports it as claim.failed and tears it down.
			if c.Halt(blockerErr(protocol.BlockerKindResources, "cell_disk_full", why)) {
				c.Log.Error("claim.disk_stopped", "alarm", true, "state", "acquiring", "freeBytes", free)
			}
		case claims.Ready, claims.Held:
			// The hub hears no blocker for a ready claim outside a
			// security violation: its next step finds the claim gone.
			c.Log.Error("claim.disk_stopped", "alarm", true, "state", c.State().String(), "freeBytes", free)
			a.goTracked(func(ctx context.Context) { a.cleanup(ctx, c, "cell_disk_full") })
		case claims.Failed, claims.Released:
			// Torn down already, or being.
		}
	}
	return true
}
