package dockergvisor

import (
	"context"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildstate"
)

// stateStore is what a build needs of the environments' BuildKit states.
type stateStore interface {
	// Acquire picks the state the build mounts as BuildKit's root; false:
	// the build runs on a throwaway state of its own. It does no work
	// proportional to a state's size: it runs on the build's path. A seed
	// may wait, bounded and until ctx ends, for the state's readers to go.
	Acquire(ctx context.Context, req buildstate.Request) (buildstate.State, bool)
	// Release gives back what Acquire handed out.
	Release(st buildstate.State)
	// Evict removes the least recently used states nobody holds while the
	// disk is below its floor. It may remove gigabytes, so the cell's
	// periodic sweep runs it, never a build.
	Evict() error
	// EvictOlderThan removes the states nobody holds that were not used for
	// olderThan or longer (zero: every state nobody holds), the least recently
	// used first, and returns the bytes it removed: the watchdog's build cache
	// rung, which keeps what a live build holds.
	EvictOlderThan(olderThan time.Duration) (int64, error)
	// Evicted lists the environments whose state eviction removed and no
	// seed made again, newest first; EvictedAt says it of one.
	Evicted() []buildstate.Evicted
	EvictedAt(org, env string) (time.Time, bool)
	// Settle returns once the store's own background work has ended (a
	// spare's clone, a released view's removal): Shutdown waits for it.
	Settle()
}

// noStates is the store of a cell that keeps no state (PersistBuildState
// off): every build runs on its own throwaway state.
type noStates struct{}

func (noStates) Acquire(context.Context, buildstate.Request) (buildstate.State, bool) {
	return buildstate.State{}, false
}
func (noStates) Release(buildstate.State)                    {}
func (noStates) Settle()                                     {}
func (noStates) Evict() error                                { return nil }
func (noStates) EvictOlderThan(time.Duration) (int64, error) { return 0, nil }
func (noStates) Evicted() []buildstate.Evicted               { return nil }
func (noStates) EvictedAt(string, string) (time.Time, bool) {
	return time.Time{}, false
}

// EvictedBuildStates is driver.BuildStateReporter: the environments whose
// build state this cell's disk floor removed and no seed made again.
func (d *Driver) EvictedBuildStates() []driver.EvictedBuildState {
	ev := d.states.Evicted()
	out := make([]driver.EvictedBuildState, 0, len(ev))
	for _, e := range ev {
		out = append(out, driver.EvictedBuildState{Org: e.Org, Env: e.Env, At: e.At, Rebuild: e.Rebuild, FreeBytes: e.FreeBytes, FloorBytes: e.FloorBytes})
	}
	return out
}
