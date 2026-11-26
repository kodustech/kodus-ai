package dockergvisor

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// gatedBuilds is a Docker whose builds can be held and failed per service,
// outside memDocker's lock (which would make every build in it one at a time).
type gatedBuilds struct {
	*memDocker
	mu      sync.Mutex
	running int
	most    int
	runs    []dockercli.BuildRun
	// barrier, when above 1, holds each build until that many are running at
	// once (or a second passes: the build then goes on, and the test fails on
	// how many it saw).
	barrier int
	// fail maps a service (its tag's name) to what its build fails with after
	// delay[service]; a build with no entry succeeds.
	fail  map[string]error
	delay map[string]time.Duration
	// hang makes the services in it wait for their context to end.
	hang map[string]bool
	// canceled counts the builds that ended with their context.
	canceled atomic.Int32
}

// serviceOf is the service a build is for, from its tag (builtTag).
func serviceOf(b dockercli.BuildRun) string {
	name := strings.TrimSuffix(strings.TrimPrefix(b.Tag, "kodus-build/"), ":claim")
	return name[strings.LastIndex(name, "-workload-")+len("-workload-"):]
}

func (g *gatedBuilds) RunBuild(ctx context.Context, b dockercli.BuildRun) error {
	svc := serviceOf(b)
	g.mu.Lock()
	g.running++
	g.most = max(g.most, g.running)
	g.runs = append(g.runs, b)
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		g.running--
		g.mu.Unlock()
	}()
	if g.barrier > 1 {
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			g.mu.Lock()
			n := g.running
			g.mu.Unlock()
			if n >= g.barrier {
				break
			}
			time.Sleep(2 * time.Millisecond)
		}
	}
	if g.hang[svc] {
		<-ctx.Done()
		g.canceled.Add(1)
		return ctx.Err()
	}
	if d := g.delay[svc]; d > 0 {
		select {
		case <-time.After(d):
		case <-ctx.Done():
			g.canceled.Add(1)
			return ctx.Err()
		}
	}
	if err := g.fail[svc]; err != nil {
		return err
	}
	return g.memDocker.RunBuild(ctx, b)
}

func (g *gatedBuilds) peak() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.most
}

// parallelDriver is a driver whose claim asked for a large machine, over a
// gated Docker.
func parallelDriver(t *testing.T) (*Driver, *gatedBuilds, driver.MachineRef) {
	t.Helper()
	d, docker := bakeDriver(t)
	d.cfg.MaxBuilds = 8
	g := &gatedBuilds{memDocker: docker}
	d.d = g
	ref := machine("claim-pr", bakeEnv)
	d.mu.Lock()
	d.machineLocked(ref.MachineID).size = driver.ClaimSize{MemoryMB: 32768, CPUs: 8}
	d.mu.Unlock()
	return d, g, ref
}

func distinctBuilds(t *testing.T, services ...string) []sandbox.Build {
	var out []sandbox.Build
	for _, s := range services {
		out = append(out, sandbox.Build{Service: s, Context: project(t), Dockerfile: "Dockerfile", Target: s})
	}
	return out
}

// A claim's services build side by side, not one after the other: on a cold
// boot the builds' pulls and compiles overlap in time.
func TestIndependentBuildsOfAClaimRunAtTheSameTime(t *testing.T) {
	d, g, ref := parallelDriver(t)
	g.barrier = 3
	built, _, err := d.build(context.Background(), ref, distinctBuilds(t, "api", "app", "e2e"), "net", "resolv", bakeSubnet, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(built) != 3 {
		t.Fatalf("built %v", built)
	}
	if got := g.peak(); got != 3 {
		t.Fatalf("%d builds ran at once, want 3", got)
	}
}

func addresses(runs []dockercli.BuildRun) map[string]bool {
	out := map[string]bool{}
	for _, r := range runs {
		out[r.Address] = true
	}
	return out
}

// Builders that run together on one claim network cannot share the fixed
// address of a single builder: each takes one of its own, which the claim's
// policy names from the start, and an equal part of the claim's memory.
func TestBuildersOfAClaimTakeAddressesAndMemoryOfTheirOwn(t *testing.T) {
	d, g, ref := parallelDriver(t)
	g.barrier = 4
	if _, _, err := d.build(context.Background(), ref, distinctBuilds(t, "api", "app", "e2e", "firebase"), "net", "resolv", bakeSubnet, nil, nil); err != nil {
		t.Fatal(err)
	}
	if got := addresses(g.runs); len(got) != 4 {
		t.Fatalf("4 builders at %v, want 4 addresses", got)
	}
	n, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-x"})
	if err != nil {
		t.Fatal(err)
	}
	// The policy's addresses are on the claim's own subnet, the builds' on the
	// test's: the host part is what must match.
	hostPart := func(a string) string { return a[strings.LastIndex(a, "."):] }
	named := map[string]bool{}
	for _, a := range n.Sources {
		named[hostPart(a)] = true
	}
	for _, r := range g.runs {
		if !named[hostPart(r.Address)] {
			t.Fatalf("builder at %s is not a source of the claim's policy %v", r.Address, n.Sources)
		}
		if r.MemLimit != "8192m" {
			t.Fatalf("builder memory %s, want a quarter of the claim's 32 GB", r.MemLimit)
		}
	}
}

// The claim's bound, and the cell's slots under it, are both held.
func TestBuildsOfAClaimAreBoundedByTheClaimAndByTheCell(t *testing.T) {
	for name, tc := range map[string]struct{ claim, cell, want int }{
		"the claim's bound": {2, 8, 2},
		"the cell's slots":  {4, 1, 1},
		"all four":          {0, 8, 4},
	} {
		t.Run(name, func(t *testing.T) {
			d, g, ref := parallelDriver(t)
			d.cfg.ClaimBuilds, d.cfg.MaxBuilds = tc.claim, tc.cell
			g.barrier = tc.want
			if _, _, err := d.build(context.Background(), ref, distinctBuilds(t, "api", "app", "e2e", "firebase", "worker"), "net", "resolv", bakeSubnet, nil, nil); err != nil {
				t.Fatal(err)
			}
			if got := g.peak(); got != tc.want {
				t.Fatalf("%d builds ran at once, want %d", got, tc.want)
			}
		})
	}
}

// A claim that asks for little runs fewer builds at once, not smaller
// builders.
func TestAClaimSmallerThanItsBuildsRunsFewerAtOnce(t *testing.T) {
	d, g, ref := parallelDriver(t)
	d.mu.Lock()
	d.machineLocked(ref.MachineID).size = driver.ClaimSize{MemoryMB: 4096, CPUs: 2}
	d.mu.Unlock()
	g.barrier = 2
	if _, _, err := d.build(context.Background(), ref, distinctBuilds(t, "api", "app", "e2e", "firebase"), "net", "resolv", bakeSubnet, nil, nil); err != nil {
		t.Fatal(err)
	}
	if got := g.peak(); got != 2 {
		t.Fatalf("%d builds ran at once on 4 GB, want 2", got)
	}
	for _, r := range g.runs {
		if r.MemLimit != "2048m" {
			t.Fatalf("builder memory %s, want 2048m", r.MemLimit)
		}
	}
}

// The seeding setup writes the environment's one BuildKit state: its
// builds run one at a time.
func TestASetupThatSeedsBuildsOneAtATime(t *testing.T) {
	d, g, _ := parallelDriver(t)
	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, true)
	if _, _, err := d.build(context.Background(), setup, distinctBuilds(t, "api", "app", "e2e"), "net", "resolv", bakeSubnet, nil, nil); err != nil {
		t.Fatal(err)
	}
	if got := g.peak(); got != 1 {
		t.Fatalf("%d seeding builds ran at once, want 1", got)
	}
}

// Two services that name the same build (an api and a seed tool) make one
// image, while the others build beside it.
func TestServicesThatShareABuildBuildItOnce(t *testing.T) {
	d, g, ref := parallelDriver(t)
	dir := project(t)
	builds := []sandbox.Build{
		{Service: "api", Context: dir, Dockerfile: "Dockerfile", Target: "run"},
		{Service: "app", Context: project(t), Dockerfile: "Dockerfile", Target: "web"},
		{Service: "seed", Context: dir, Dockerfile: "Dockerfile", Target: "run"},
	}
	g.barrier = 2
	built, _, err := d.build(context.Background(), ref, builds, "net", "resolv", bakeSubnet, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.runs) != 2 {
		t.Fatalf("%d builds ran for 2 different ones", len(g.runs))
	}
	for _, s := range []string{"api", "app", "seed"} {
		if !g.images[built[s]] {
			t.Fatalf("service %s has no image: %v", s, built)
		}
	}
	if g.peak() != 2 {
		t.Fatalf("the two different builds did not overlap: %d", g.peak())
	}
}

// A build that fails ends the ones after it in the project's order at once,
// and the claim reports that service.
func TestAFailedBuildEndsTheLaterOnesAndIsReported(t *testing.T) {
	d, g, ref := parallelDriver(t)
	g.barrier = 3
	g.fail = map[string]error{"app": &dockercli.ExitError{Command: "docker run", Code: 1}}
	g.hang = map[string]bool{"e2e": true, "firebase": true}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	at := time.Now()
	_, _, err := d.build(ctx, ref, distinctBuilds(t, "api", "app", "e2e", "firebase"), "net", "resolv", bakeSubnet, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "build app:") {
		t.Fatalf("the failing service was not reported: %v", err)
	}
	if time.Since(at) > 5*time.Second {
		t.Fatal("the build call waited for the builds after the failure")
	}
	if g.canceled.Load() != 2 {
		t.Fatalf("%d builds ended with their context, want the 2 after the failure", g.canceled.Load())
	}
}

// Whichever of two failing builds ends first, the error is the first of them
// in the project's order, as when they ran one after the other.
func TestTheFirstFailingServiceInOrderIsReportedWhateverTheTiming(t *testing.T) {
	for name, delay := range map[string]map[string]time.Duration{
		"later one fails first": {"api": 120 * time.Millisecond},
		"earlier one first":     {"app": 120 * time.Millisecond},
	} {
		t.Run(name, func(t *testing.T) {
			d, g, ref := parallelDriver(t)
			g.fail = map[string]error{
				"api": &dockercli.ExitError{Command: "docker run", Code: 1},
				"app": &dockercli.ExitError{Command: "docker run", Code: 1},
			}
			g.delay = delay
			_, _, err := d.build(context.Background(), ref, distinctBuilds(t, "api", "app", "e2e"), "net", "resolv", bakeSubnet, nil, nil)
			if err == nil || !strings.Contains(err.Error(), "build api:") {
				t.Fatalf("got %v, want the first service's failure", err)
			}
		})
	}
}

// The builds before a failed one are not stopped: they would have finished
// before it was reached.
func TestABuildBeforeAFailedOneRunsToTheEnd(t *testing.T) {
	d, g, ref := parallelDriver(t)
	g.fail = map[string]error{"app": &dockercli.ExitError{Command: "docker run", Code: 1}}
	g.delay = map[string]time.Duration{"api": 150 * time.Millisecond}
	_, _, err := d.build(context.Background(), ref, distinctBuilds(t, "api", "app"), "net", "resolv", bakeSubnet, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "build app:") {
		t.Fatalf("err %v", err)
	}
	if g.canceled.Load() != 0 {
		t.Fatal("the earlier build was stopped by the later one's failure")
	}
	if !g.images[builtTag(ref.MachineID, "api")] {
		t.Fatal("the earlier build did not finish")
	}
}

// The claim's own end stops every build.
func TestCancelingTheBootStopsEveryBuild(t *testing.T) {
	d, g, ref := parallelDriver(t)
	g.hang = map[string]bool{"api": true, "app": true}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		for g.peak() < 2 {
			time.Sleep(time.Millisecond)
		}
		cancel()
	}()
	_, _, err := d.build(ctx, ref, distinctBuilds(t, "api", "app"), "net", "resolv", bakeSubnet, nil, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err %v", err)
	}
	if g.canceled.Load() != 2 {
		t.Fatalf("%d builds ended with the context", g.canceled.Load())
	}
}

// Builds that push to a registry each use the one beside their own builder.
func TestBuildsRunningTogetherPushToRegistriesOfTheirOwn(t *testing.T) {
	d, docker := registryDriver(t)
	seedRegistry(t, d)
	d.cfg.MaxBuilds = 8
	g := &gatedBuilds{memDocker: docker, barrier: 2}
	d.d = g
	ref := machine("claim-pr", bakeEnv)
	d.mu.Lock()
	d.machineLocked(ref.MachineID).size = driver.ClaimSize{MemoryMB: 32768, CPUs: 8}
	d.mu.Unlock()
	if _, _, err := d.build(context.Background(), ref, distinctBuilds(t, "api", "app"), "net", "resolv", bakeSubnet, nil, nil); err != nil {
		t.Fatal(err)
	}
	if g.peak() != 2 || len(docker.registries) != 2 {
		t.Fatalf("peak %d, registries %d", g.peak(), len(docker.registries))
	}
	ips := map[string]bool{}
	for _, r := range docker.registries {
		ips[r.ClaimIP] = true
	}
	if len(ips) != 2 {
		t.Fatalf("registries at %v", ips)
	}
	for _, b := range g.runs {
		host := strings.TrimSuffix(b.Push.Registry, ":5000")
		if !ips[host] {
			t.Fatalf("build pushed to %s, registries are at %v", b.Push.Registry, ips)
		}
	}
}
