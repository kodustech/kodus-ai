package dockergvisor

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildprogress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// tickClock is a clock that moves one second every time it is read: a phase
// that reads it at its start and at its end lasts a second, whatever the
// (instant) fakes in between did, so a phase that is not timed shows as one
// with no duration.
type tickClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *tickClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(time.Second)
	return c.t
}

func (c *tickClock) After(d time.Duration) <-chan time.Time {
	ch := make(chan time.Time, 1)
	ch <- c.Now().Add(d)
	return ch
}

func ticking() *tickClock { return &tickClock{t: time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)} }

// timedPhase is the phase's duration, and whether it is there.
func timedPhase(phases []driver.BootPhase, name string) (int64, bool) {
	for _, p := range phases {
		if p.Name == name {
			return p.Ms, true
		}
	}
	return 0, false
}

func wantTimed(t *testing.T, phases []driver.BootPhase, names ...string) {
	t.Helper()
	for _, n := range names {
		if ms, ok := timedPhase(phases, n); !ok || ms <= 0 {
			t.Errorf("phase %q is %d ms (present %v); phases %+v", n, ms, ok, phases)
		}
	}
}

// A pull request's build, whose state and exported cache the disk floor took,
// spends minutes outside every BuildKit step: waiting for a build slot, the
// state's view, importing the cache from off the cell, and the builder
// starting before it prints a line. Each is a phase of the boot with its own
// duration, so the Run says where the time went instead of leaving it out.
func TestABuildNamesEveryPartOfItsTimeOutsideBuildKitSteps(t *testing.T) {
	d, docker, m := statefulDriver(t)
	d.remote = &fakeRemote{}
	build := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, true)
	boot(t, d, setup, build)
	d.WaitRemotePushes()
	evictStates(t, d, m)
	evictCachesBelowFloor(t, d)

	d.clock = ticking()
	docker.buildOutput = []string{"#1 [internal] load build definition from Dockerfile", "#1 DONE 0.1s"}
	_, steps, err := d.build(context.Background(), machine("claim-pr", bakeEnv), []sandbox.Build{build}, "net", "resolv", bakeSubnet, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	wantTimed(t, steps.Phases, PhaseBuildSlot, PhaseCacheState, PhaseCachePull, PhaseBuilderBoot, PhaseCleanOut, PhaseReleaseHold)
}

// The default branch's setup also promotes the cache it exported.
func TestASeedingBuildNamesItsCachePromotion(t *testing.T) {
	d, _, _ := statefulDriver(t)
	d.clock = ticking()
	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, true)
	_, steps, err := d.build(context.Background(), setup, []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	wantTimed(t, steps.Phases, PhaseCachePromo, PhaseCacheState)
}

// The registry that carries the image is stopped after the pull: its time is
// a phase too (a build's registry of gigabytes takes a while to remove).
func TestARegistryBuildNamesStoppingItsRegistry(t *testing.T) {
	d, _ := registryDriver(t)
	seedRegistry(t, d)
	d.clock = ticking()
	_, ran, err := d.runBuild(context.Background(), machine("claim-pr", bakeEnv), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}, "kodus-build/m-api:claim", "net", "resolv", bakeSubnet, nil)
	if err != nil {
		t.Fatal(err)
	}
	var phases []driver.BootPhase
	for _, p := range ran.Phases {
		phases = append(phases, driver.BootPhase{Name: p.Name, Ms: p.Ms})
	}
	wantTimed(t, phases, PhaseStopReg, "pull image", "start registry")
}

// A build the claim's ceiling stopped while it waited for a slot says so: the
// phase is the one it stopped in.
func TestABuildStoppedWaitingForASlotSaysItWasThere(t *testing.T) {
	d, _ := bakeDriver(t)
	d.clock = ticking()
	d.cfg.MaxBuilds = 1
	free := d.buildSlot()
	defer free()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, ran, err := d.runBuild(ctx, machine("claim-pr", bakeEnv), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}, "t", "net", "resolv", bakeSubnet, nil)
	if err == nil {
		t.Fatal("the build ran with no slot")
	}
	i := slices.IndexFunc(ran.Phases, func(p buildprogress.Phase) bool { return p.Name == PhaseBuildSlot })
	if i < 0 || !ran.Phases[i].Running || ran.Phases[i].Ms <= 0 {
		t.Fatalf("phases %+v", ran.Phases)
	}
}

// Between the claim asking to boot and the app answering, each step of Up
// that is not a build is a phase: the claim's sandbox, the compose render,
// the images the cell pulls.
func TestUpNamesItsOwnSteps(t *testing.T) {
	r := &recorder{answers: map[string]string{"info": `{"runsc":{}}`, "run": "c0ffee\n", "inspect": holderJSON, "network subnet": "10.213.5.0/24 \n", "version": "1.52\n", "compose config": canonicalDBAndApp(), "ps": "s1\ns2\n"}}
	d, err := New(context.Background(), dockercli.CLI{Run: r.run}, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(), Clock: ticking()})
	if err != nil {
		t.Fatal(err)
	}
	ref, err := d.Create(context.Background(), spec())
	if err != nil {
		t.Fatal(err)
	}
	ref.Tags[driver.TagOrg], ref.Tags[driver.TagRole] = "", ""
	if _, err := d.Up(context.Background(), driver.UpRequest{Ref: ref, Compose: []byte(dbAndApp), ProjectDir: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	phases, ok := d.BootPhases(ref.Tags[driver.TagClaim])
	if !ok {
		t.Fatal("no phases kept")
	}
	wantTimed(t, phases, PhaseSandbox, PhaseCoverage, PhaseRender, PhasePull)
}
