package agent

import (
	"context"
	"fmt"
	"sort"
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

// The relief ladder. Before the watchdog stops anybody it gives room back,
// one rung at a time, measuring free space again after each and stopping at
// the first that clears the line it works for (the floor, or the margin):
// fstrim of the build-state filesystem (a sparse file that only grows until
// discarded), the cell's own BuildKit state and the host's build cache
// oldest first, then the driver's ReclaimDisk (exported caches, then build
// states: docs/runtime/persistent-state.md D7). Only then does it pick a
// victim, and a claim that turned ready less than ReadyGrace ago is never
// one unless nothing else is left, which is logged as an alarm and written
// into the stop's reason. Free space is the smaller of the inner filesystem
// and the outer one that holds its sparse file: the file can be full while
// the inner filesystem still shows room.

// DiskWatch is what the watchdog reads and its floor.
type DiskWatch struct {
	// Free is the free bytes of the filesystem Docker writes to (statfs of
	// its data root).
	Free func() (uint64, error)
	// Outer is the free bytes of the filesystem under the build-state
	// volume's sparse file; nil: none. The watchdog works with the smaller
	// of Free and Outer.
	Outer func() (uint64, error)
	// Trim discards the unused blocks of the build-state filesystem
	// (fstrim) and returns the bytes the host got back; nil: no trim.
	Trim func(ctx context.Context) (uint64, error)
	// MinFreeBytes is the floor: under it the cell stops its claims.
	MinFreeBytes uint64
	// PerRunBytes is the room one more Run needs above the floor: under
	// MinFreeBytes+PerRunBytes the ladder runs and a victim may be picked
	// (MinFreeBytes when zero, the margin of twice the floor).
	PerRunBytes uint64
	// ReadyGrace is how long after turning ready a claim is spared as a
	// victim (DefaultReadyGrace when zero).
	ReadyGrace time.Duration
	// Every is how often it looks (DefaultDiskWatchEvery when zero).
	Every time.Duration
}

// DefaultReadyGrace is how long a claim that just turned ready is spared.
const DefaultReadyGrace = 2 * time.Minute

func (w *DiskWatch) margin() uint64 {
	if w.PerRunBytes == 0 {
		return 2 * w.MinFreeBytes
	}
	return w.MinFreeBytes + w.PerRunBytes
}

func (w *DiskWatch) grace() time.Duration {
	if w.ReadyGrace <= 0 {
		return DefaultReadyGrace
	}
	return w.ReadyGrace
}

// diskFree is the smaller of the inner and the outer free space. An outer
// disk it cannot read is logged and left out; the inner one is required.
func (a *Agent) diskFree() (uint64, error) {
	w := a.cfg.DiskWatch
	free, err := w.Free()
	if err != nil {
		return 0, err
	}
	if w.Outer != nil {
		outer, oerr := w.Outer()
		if oerr != nil {
			a.log.Warn("disk.outer_unreadable", "err", oerr)
		} else if outer < free {
			free = outer
		}
	}
	return free, nil
}

// inReadyGrace is a claim that turned ready less than the grace window ago.
func (a *Agent) inReadyGrace(c *claims.Claim) bool {
	return c.State() == claims.Ready && a.clock.Now().Sub(c.BoundAt()) < a.cfg.DiskWatch.grace()
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
	free, err := a.diskFree()
	if err != nil {
		a.log.Warn("disk.watch_failed", "err", err)
		return false
	}
	if free >= w.MinFreeBytes {
		if free < w.margin() {
			a.relieveDisk(free, w.MinFreeBytes)
		} else {
			a.disk.forget()
		}
		return false
	}
	if free = a.relieveLadder(context.Background(), free, w.MinFreeBytes); free >= w.MinFreeBytes {
		return false
	}
	why := blockerErr(protocol.BlockerKindResources, "cell_disk_full", fmt.Errorf("the cell's Docker disk has %d MiB free, under its floor of %d MiB: the cell stopped its claims before the disk filled", free>>20, w.MinFreeBytes>>20))
	a.log.Error("disk.low", "alarm", true, "freeBytes", free, "minFreeBytes", w.MinFreeBytes)
	// A claim still in its ready grace is stopped only when no other claim
	// was left to stop: the next look finds the disk again if it is still low.
	var spared []*claims.Claim
	stopped := false
	for _, c := range a.claims.All() {
		if a.inReadyGrace(c) {
			spared = append(spared, c)
			continue
		}
		stopped = a.stopForDisk(c, why, free) || stopped
	}
	if !stopped {
		for _, c := range spared {
			a.stopInGrace(c, "cell_disk_full", why, free)
		}
	}
	return true
}

// stopInGrace stops a claim that turned ready within the grace window
// because nothing else was left to stop, loudly, and records why.
func (a *Agent) stopInGrace(c *claims.Claim, signature string, blocker error, free uint64) {
	ago := a.clock.Now().Sub(c.BoundAt())
	a.log.Error("disk.victim_in_grace", "alarm", true, "claim", c.ID, "readyAgo", ago.String(), "graceWindow", a.cfg.DiskWatch.grace().String(), "signature", signature, "freeBytes", free, "reason", "no other claim was left to stop")
	a.stopForDisk(c, fmt.Errorf("%w (the claim turned ready %s ago, inside its %s grace window, and no other claim was left to stop)", blocker, ago.Round(time.Second), a.cfg.DiskWatch.grace()), free)
}

// pruneTiers are the ages of build cache the watchdog drops, oldest first: the
// cache nobody used for a week, then a day, then an hour, then all that no live
// build holds. It stops at the first that gives the room back.
var pruneTiers = []time.Duration{7 * 24 * time.Hour, 24 * time.Hour, time.Hour, 0}

// relieveLadder gives disk back before anybody is stopped: fstrim, the
// build cache (the cell's BuildKit state, oldest first, the live builds' kept),
// then the driver's ReclaimDisk. Each rung measures free space again and the
// ladder stops at the first that reaches want. It returns the free space last
// measured; a disk it cannot read, or a rung with nothing to do, leaves it as it
// was. One ladder runs at a time.
func (a *Agent) relieveLadder(ctx context.Context, free, want uint64) uint64 {
	w := a.cfg.DiskWatch
	if w == nil || w.Free == nil || free >= want {
		return free
	}
	a.disk.ladder.Lock()
	defer a.disk.ladder.Unlock()
	if now, err := a.diskFree(); err == nil {
		if free = now; free >= want {
			return free
		}
	}
	if w.Trim != nil {
		var done bool
		if free, done = a.rung(ctx, "fstrim", "", free, want, func(c context.Context) (int64, error) {
			n, err := w.Trim(c)
			return int64(n), err //nolint:gosec // G115: bytes of a disk
		}); done {
			return free
		}
	}
	if p := a.cfg.Parts.BuildCache; p != nil {
		for _, age := range pruneTiers {
			var done bool
			if free, done = a.rung(ctx, "build_cache", age.String(), free, want, func(c context.Context) (int64, error) {
				return p.PruneBuildCache(c, age)
			}); done {
				return free
			}
		}
	}
	if r := a.cfg.Parts.DiskReclaim; r != nil {
		free, _ = a.rung(ctx, "reclaim", "", free, want, func(context.Context) (int64, error) {
			return 0, r.ReclaimDisk() // no byte count: the gain is what the disk shows
		})
	}
	return free
}

// rung runs one rung of the ladder under diskUsageTimeout (reclaim may take
// minutes, so it has its own bound), measures free space again, records what
// it freed in the log and in cell_disk_relief_freed_bytes_total, and says
// whether want was reached.
func (a *Agent) rung(ctx context.Context, name, detail string, free, want uint64, run func(context.Context) (int64, error)) (uint64, bool) {
	timeout := diskUsageTimeout
	if name == "reclaim" {
		timeout = 10 * time.Minute
	}
	rctx, cancel := context.WithTimeout(ctx, timeout)
	freed, err := run(rctx)
	cancel()
	if err != nil {
		a.log.Warn("disk.rung_failed", "rung", name, "olderThan", detail, "err", err)
	}
	now, merr := a.diskFree()
	if merr != nil {
		return free, false
	}
	if freed <= 0 && now > free {
		freed = int64(now - free) //nolint:gosec // G115: bytes of a disk
	}
	if freed > 0 {
		a.m.diskFreed.Add(float64(freed), name)
	}
	a.log.Warn("disk.rung", "rung", name, "olderThan", detail, "freedBytes", freed, "freeBytes", now, "wantBytes", want)
	return now, now >= want
}

// diskUsageTimeout bounds one measure of every claim's disk.
const diskUsageTimeout = time.Minute

// diskLooks is what the watchdog read of each claim's disk at its last look
// under the margin; busy keeps one look at a time (a look measures every
// volume, and may outlast a tick).
type diskLooks struct {
	busy   atomic.Bool
	ladder sync.Mutex // one relief ladder at a time
	mu     sync.Mutex
	last   map[string]int64
}

func (l *diskLooks) forget() {
	l.mu.Lock()
	l.last = nil
	l.mu.Unlock()
}

// grower is one claim whose disk grew since the last look.
type grower struct {
	id   string
	grew int64
}

// growers records now and returns the claims whose disk grew since the last
// look, the one that grew most first; none when there was no look.
func (l *diskLooks) growers(now map[string]int64) []grower {
	l.mu.Lock()
	defer l.mu.Unlock()
	last := l.last
	l.last = now
	var out []grower
	for id, n := range now {
		if before, seen := last[id]; seen && n > before {
			out = append(out, grower{id, n - before})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].grew != out[j].grew {
			return out[i].grew > out[j].grew
		}
		return out[i].id < out[j].id
	})
	return out
}

// relieveDisk, with the disk under the margin, runs the relief ladder and,
// when that was not enough, stops the claim whose disk grew the most since the
// last look, off the watchdog's loop. A claim in its ready grace window is
// passed over for the next grower, and stopped only when it is the only one.
func (a *Agent) relieveDisk(free, floor uint64) {
	users := a.cfg.Parts.DiskUsers
	if users == nil || !a.disk.busy.CompareAndSwap(false, true) {
		return
	}
	a.goTracked(func(ctx context.Context) {
		defer a.disk.busy.Store(false)
		margin := a.cfg.DiskWatch.margin()
		if free = a.relieveLadder(ctx, free, margin); free >= margin {
			return
		}
		mctx, cancel := context.WithTimeout(ctx, diskUsageTimeout)
		usage, err := users.ClaimDiskUsage(mctx)
		cancel()
		if err != nil {
			a.log.Warn("disk.usage_failed", "err", err)
			return
		}
		var pick, spared *claims.Claim
		var pickGrew, sparedGrew int64
		for _, g := range a.disk.growers(usage) {
			c, ok := a.claims.Get(g.id)
			if !ok {
				continue
			}
			if a.inReadyGrace(c) {
				if spared == nil {
					spared, sparedGrew = c, g.grew
				}
				continue
			}
			pick, pickGrew = c, g.grew
			break
		}
		reason := func(grew int64) error {
			return blockerErr(protocol.BlockerKindResources, "disk_top_writer", fmt.Errorf("the cell's Docker disk has %d MiB free, under the margin above its floor of %d MiB, and this claim's disk grew the most (%d MiB since the last look): the cell stopped it before the floor stops every claim", free>>20, floor>>20, grew>>20))
		}
		switch {
		case pick != nil:
			a.stopForDisk(pick, reason(pickGrew), free)
		case spared != nil:
			a.stopInGrace(spared, "disk_top_writer", reason(sparedGrew), free)
		}
	})
}

// stopForDisk stops one claim for the disk with blocker (resources/
// cell_disk_full at the floor, resources/disk_top_writer under the margin):
// a booting one fails with it (bringUp reports it as claim.failed and tears
// it down), a ready or held one has its machines torn down (the hub hears
// no blocker for a ready claim outside a security violation: its next step
// finds the claim gone). A failed or released one is torn down already.
func (a *Agent) stopForDisk(c *claims.Claim, blocker error, free uint64) bool {
	signature := failedBody(blocker).Signature
	switch c.State() {
	case claims.Acquiring:
		if c.Halt(blocker) {
			c.Log.Error("claim.disk_stopped", "alarm", true, "state", "acquiring", "signature", signature, "freeBytes", free)
			return true
		}
	case claims.Ready, claims.Held:
		c.Log.Error("claim.disk_stopped", "alarm", true, "state", c.State().String(), "signature", signature, "freeBytes", free)
		a.goTracked(func(ctx context.Context) { a.cleanup(ctx, c, signature) })
		return true
	case claims.Failed, claims.Released:
	}
	return false
}
