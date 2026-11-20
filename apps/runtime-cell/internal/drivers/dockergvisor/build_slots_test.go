package dockergvisor

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
)

// The cell runs at most MaxBuilds builds at once, whichever claims they
// are for (G5): each builder takes two CPUs, and memory admission alone
// lets more boot together than the cores hold, which skews the base and PR
// timings the gate compares. A build past the limit waits for a slot.
func TestTheCellRunsAtMostMaxBuildsAtOnce(t *testing.T) {
	for _, slots := range []int{1, 2} {
		d, docker := bakeDriver(t)
		d.cfg.MaxBuilds = slots
		builds := &concurrentBuilds{memDocker: docker}
		d.d = builds
		most := &builds.most
		var wg sync.WaitGroup
		for _, claim := range []string{"claim-a", "claim-b", "claim-c"} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				b := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
				if _, _, err := d.runBuild(context.Background(), machine(claim, bakeEnv), b, "kodus-build/"+claim+":t", "net", "resolv", bakeSubnet, nil); err != nil {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
		if got := most.Load(); int(got) != slots {
			t.Fatalf("MaxBuilds %d: %d builds ran at once", slots, got)
		}
	}
}

// concurrentBuilds counts the builds running at once, outside memDocker's
// lock, and makes each take a while.
type concurrentBuilds struct {
	*memDocker
	running, most atomic.Int32
}

func (c *concurrentBuilds) RunBuild(ctx context.Context, b dockercli.BuildRun) error {
	n := c.running.Add(1)
	defer c.running.Add(-1)
	for {
		m := c.most.Load()
		if n <= m || c.most.CompareAndSwap(m, n) {
			break
		}
	}
	time.Sleep(50 * time.Millisecond)
	return c.memDocker.RunBuild(ctx, b)
}

// A build waiting for a slot ends with its context.
func TestABuildWaitingForASlotEndsWithItsContext(t *testing.T) {
	d, _ := bakeDriver(t)
	d.cfg.MaxBuilds = 1
	release := d.buildSlot()
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	b := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
	if _, _, err := d.runBuild(ctx, machine("claim-w", bakeEnv), b, "kodus-build/w:t", "net", "resolv", bakeSubnet, nil); err == nil {
		t.Fatal("a build ran without a slot")
	}
}
