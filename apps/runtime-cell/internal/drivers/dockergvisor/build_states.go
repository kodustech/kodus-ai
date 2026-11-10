package dockergvisor

import (
	"context"

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
}

// noStates is the store of a cell that keeps no state (PersistBuildState
// off): every build runs on its own throwaway state.
type noStates struct{}

func (noStates) Acquire(context.Context, buildstate.Request) (buildstate.State, bool) {
	return buildstate.State{}, false
}
func (noStates) Release(buildstate.State) {}
func (noStates) Evict() error             { return nil }
