package dockergvisor

import (
	"context"
	"fmt"
	"sync"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// A claim's builds run side by side, each in a lane: the pair of addresses
// (its registry's and its builder's, builderAddress and registryAddress) a
// build holds on the claim network while it runs, and a share of the
// claim's memory. The lanes are the claim's own bound; the cell's build
// slots (MaxBuilds) still bound every claim together, so a claim with
// four lanes on a host with two slots builds two at a time.
//
// What must stay one at a time:
//   - A seeding build (a setup of the default branch, MachineSpec.Setup and
//     Seeds) writes the environment's BuildKit state and its registry seed,
//     which one writer holds at a time (buildstate.Acquire, registry.Start):
//     its claim has one lane.
//   - Services that name the same build make one image (build's leader).
//
// Everything else a build holds is its own: its output directory, its
// registry's storage, its state view and its exported cache, each named by
// the service.

// defaultClaimBuilds is the lanes a claim gets when Config.ClaimBuilds is
// unset: all the addresses below the services hold.
const defaultClaimBuilds = maxClaimBuilds

// minBuilderMB is the least memory a builder gets when builds share the
// claim's: a claim with less runs fewer at once instead of smaller ones.
const minBuilderMB = 2048

// claimBuilds is the most builds of one claim that run at once.
func (d *Driver) claimBuilds() int {
	n := d.cfg.ClaimBuilds
	if n <= 0 {
		n = defaultClaimBuilds
	}
	return min(n, maxClaimBuilds)
}

// buildLanes are a build call's lanes: size of them, handed out one by one.
type buildLanes struct {
	size int
	free chan int
	// exclusive serializes the builds that ask for the claim to themselves
	// (takeAll): two of them taking lanes one by one would each hold some
	// and wait for the rest.
	exclusive sync.Mutex
}

// newBuildLanes is the lanes for a call that runs builds builds: no more
// than the claim's bound, than the builders its memory holds at minBuilderMB
// each, or than there are builds; one for a build that seeds.
func (d *Driver) newBuildLanes(ref driver.MachineRef, builds int) *buildLanes {
	n := min(builds, d.claimBuilds())
	if m := d.peek(ref.MachineID); m.setup && m.seeds {
		n = 1
	}
	if mem, _ := d.limits(ref.MachineID); n > 1 {
		if mb, err := parseMemMB(mem); err == nil {
			n = min(n, mb/minBuilderMB)
		}
	}
	n = max(n, 1)
	l := &buildLanes{size: n, free: make(chan int, n)}
	for i := range n {
		l.free <- i
	}
	return l
}

// take waits for a free lane; the wait ends with ctx.
func (l *buildLanes) take(ctx context.Context) (int, func(), error) {
	select {
	case i := <-l.free:
		return i, func() { l.free <- i }, nil
	case <-ctx.Done():
		return 0, nil, fmt.Errorf("dockergvisor: waiting for a build lane of the claim: %w", context.Cause(ctx))
	}
}

// takeAll waits until no other build of the claim runs and holds every lane
// until the returned func is called: a build killed for memory beside others
// runs again with the claim's whole memory. The caller holds no lane. The wait
// ends with ctx.
func (l *buildLanes) takeAll(ctx context.Context) (func(), error) {
	l.exclusive.Lock()
	taken := 0
	give := func() {
		for range taken {
			l.free <- 0
		}
		l.exclusive.Unlock()
	}
	for taken < l.size {
		select {
		case <-l.free:
			taken++
		case <-ctx.Done():
			give()
			return nil, fmt.Errorf("dockergvisor: waiting to build alone in the claim: %w", context.Cause(ctx))
		}
	}
	return give, nil
}

type laneKey struct{}

type laneOf struct{ index, size int }

// withBuildLane says, to the build that runs under ctx, which lane it holds
// and how many lanes its claim builds in.
func withBuildLane(ctx context.Context, index, size int) context.Context {
	return context.WithValue(ctx, laneKey{}, laneOf{index, size})
}

// buildLane is the lane of the build running under ctx: the first of one
// when it was given none.
func buildLane(ctx context.Context) (index, size int) {
	l, ok := ctx.Value(laneKey{}).(laneOf)
	if !ok {
		return 0, 1
	}
	return l.index, l.size
}

// laneMemory is a builder's memory limit when size builds share the claim's:
// an equal part of it, as docker takes it ("4g" among two is "2048m").
func laneMemory(mem string, size int) string {
	if size <= 1 {
		return mem
	}
	mb, err := parseMemMB(mem)
	if err != nil {
		return mem
	}
	return fmt.Sprintf("%dm", mb/size)
}

// prefixedOutput names the service on every line a build prints when builds
// run side by side: their lines come to one sink, and BuildKit numbers its
// steps from #1 in each (the agent's live phases read one build's steps
// after the other's, so a prefixed line is left out of them).
func prefixedOutput(ctx context.Context, lanes int, service string) context.Context {
	sink := dockercli.OutputFrom(ctx)
	if lanes <= 1 || sink == nil {
		return ctx
	}
	return dockercli.WithOutput(ctx, func(line string) { sink("[" + service + "] " + line) })
}
