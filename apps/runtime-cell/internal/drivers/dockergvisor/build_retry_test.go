package dockergvisor

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

func failedRun(code string) []string {
	return []string{
		"#7 [stage 2/4] RUN apt-get update",
		"#7 ERROR: process \"/bin/sh -c apt-get update\" did not complete successfully: exit code: " + code,
	}
}

func buildWithLogs(t *testing.T, d *Driver, claim string) (error, string) {
	t.Helper()
	var logs bytes.Buffer
	d.cfg.Log = slog.New(slog.NewJSONHandler(&logs, nil))
	_, _, err := d.build(context.Background(), machine(claim, bakeEnv), []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
	return err, logs.String()
}

// A RUN step that dies with SIGSEGV (exit 139) under gVisor builds again
// once, and the second try is the build's result.
func TestABuildWhoseRunStepSegfaultsRunsAgainOnce(t *testing.T) {
	d, docker := bakeDriver(t)
	docker.buildOutput = failedRun("139")
	n := 0
	docker.duringBuild = func(dockercli.BuildRun) {
		n++
		docker.buildErr = nil
		if n == 1 {
			docker.buildErr = errors.New("failed to solve: process did not complete successfully: exit code: 139")
		}
	}
	err, logs := buildWithLogs(t, d, "claim-1")
	if err != nil {
		t.Fatalf("a build that passed on its second try failed: %v", err)
	}
	if n != 2 {
		t.Fatalf("built %d times, want 2", n)
	}
	if !strings.Contains(logs, `"msg":"build.retry"`) || !strings.Contains(logs, `"reason":"segfault"`) {
		t.Fatalf("no build.retry reason=segfault in the log: %s", logs)
	}
}

// dev, 2026-11-26: update-ca-certificates segfaulted under gVisor inside an
// apt-get install; dpkg turned the 139 into its own failure and the RUN exited
// 100. The step's output names the segfault, so it builds once more too.
func TestARunStepWhoseCommandSaysItSegfaultedRunsAgainOnce(t *testing.T) {
	d, docker := bakeDriver(t)
	docker.buildOutput = []string{
		"#8 [deps 2/15] RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates",
		"#8 19.92 Updating certificates in /etc/ssl/certs...",
		"#8 21.32 Segmentation fault",
		"#8 21.41 dpkg: error processing package ca-certificates (--configure):",
		"#8 21.41  installed ca-certificates package post-installation script subprocess returned error exit status 139",
		"#8 21.75 E: Sub-process /usr/bin/dpkg returned an error code (1)",
		"#8 ERROR: process \"/bin/sh -c apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates\" did not complete successfully: exit code: 100",
	}
	n := 0
	docker.duringBuild = func(dockercli.BuildRun) {
		n++
		docker.buildErr = nil
		if n == 1 {
			docker.buildErr = errors.New("failed to solve: process did not complete successfully: exit code: 100")
		}
	}
	err, logs := buildWithLogs(t, d, "claim-1")
	if err != nil {
		t.Fatalf("a build that passed on its second try failed: %v", err)
	}
	if n != 2 || !strings.Contains(logs, `"reason":"segfault"`) {
		t.Fatalf("built %d times (want 2), log %s", n, logs)
	}
}

// A segfault that stays is the build's failure after one more try, never a loop.
func TestASegfaultThatRepeatsFailsAfterOneRetry(t *testing.T) {
	d, docker := bakeDriver(t)
	docker.buildOutput = failedRun("139")
	docker.buildErr = errors.New("failed to solve: process did not complete successfully: exit code: 139")
	err, _ := buildWithLogs(t, d, "claim-1")
	if err == nil {
		t.Fatal("a build that segfaulted twice was accepted")
	}
	if len(docker.builds) != 2 {
		t.Fatalf("built %d times, want 2", len(docker.builds))
	}
}

// A real failing command is the code's: any other status runs once.
func TestAFailingRunStepOtherThanASegfaultIsNotRetried(t *testing.T) {
	for _, code := range []string{"1", "2", "137", "138", "140"} {
		d, docker := bakeDriver(t)
		docker.buildOutput = failedRun(code)
		docker.buildErr = errors.New("failed to solve: process did not complete successfully: exit code: " + code)
		err, logs := buildWithLogs(t, d, "claim-1")
		if err == nil || len(docker.builds) != 1 || strings.Contains(logs, "build.retry") {
			t.Fatalf("exit %s: err %v, %d builds, log %s; want one build and no retry", code, err, len(docker.builds), logs)
		}
	}
}

// aloneProbe is a Docker whose build of the service "app" is killed at its
// memory limit while another build runs beside it, and succeeds alone.
type aloneProbe struct {
	*memDocker
	mu       sync.Mutex
	running  int
	started  int
	runsOf   map[string][]int // service -> builds running (itself included) at each try
	memories map[string][]string
}

func (p *aloneProbe) RunBuild(ctx context.Context, b dockercli.BuildRun) error {
	svc := serviceOf(b)
	p.mu.Lock()
	p.running++
	first := len(p.runsOf[svc]) == 0
	p.runsOf[svc] = append(p.runsOf[svc], 0)
	if first {
		p.started++
	}
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.running--
		p.mu.Unlock()
	}()
	// Hold every first try until both have started: they then ran together,
	// whatever the order they end in.
	for range 5000 {
		p.mu.Lock()
		ready := !first || p.started >= 2
		p.mu.Unlock()
		if ready {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	p.mu.Lock()
	seen := p.running
	if first {
		seen = 2
	}
	p.runsOf[svc][len(p.runsOf[svc])-1] = seen
	p.memories[svc] = append(p.memories[svc], b.MemLimit)
	p.mu.Unlock()
	if svc == "app" && seen > 1 {
		return &dockercli.ExitError{Command: "docker run --rm", Code: dockercli.ExitKilled}
	}
	return p.memDocker.RunBuild(ctx, b)
}

// A build killed for memory in a lane beside others runs once more with the
// claim to itself; if that passes the claim passes.
func TestABuildKilledForMemoryBesideOthersRunsOnceMoreAlone(t *testing.T) {
	d, docker := bakeDriver(t)
	d.cfg.MaxBuilds = 8
	p := &aloneProbe{memDocker: docker, runsOf: map[string][]int{}, memories: map[string][]string{}}
	d.d = p
	ref := machine("claim-pr", bakeEnv)
	d.mu.Lock()
	d.machineLocked(ref.MachineID).size = driver.ClaimSize{MemoryMB: 32768, CPUs: 8}
	d.mu.Unlock()
	var logs bytes.Buffer
	d.cfg.Log = slog.New(slog.NewJSONHandler(&logs, nil))
	built, _, err := d.build(context.Background(), ref, distinctBuilds(t, "api", "app"), "net", "resolv", bakeSubnet, nil, nil)
	if err != nil {
		t.Fatalf("a build that passed alone failed: %v", err)
	}
	if len(built) != 2 {
		t.Fatalf("built %v", built)
	}
	app := p.runsOf["app"]
	if len(app) != 2 || app[0] != 2 || app[1] != 1 {
		t.Fatalf("app's builds saw %v running (itself included), want [2 1]: beside another, then alone", app)
	}
	if len(p.runsOf["api"]) != 1 {
		t.Fatalf("api built %d times, want 1", len(p.runsOf["api"]))
	}
	mem := p.memories["app"]
	if len(mem) != 2 || mem[0] == mem[1] {
		t.Fatalf("app's memory %v: the retry alone should get the claim's whole share, not a lane's", mem)
	}
	if !strings.Contains(logs.String(), `"reason":"oom_in_lane"`) {
		t.Fatalf("no build.retry reason=oom_in_lane in the log: %s", logs.String())
	}
}

// A build killed for memory with no other build beside it already had the
// whole claim: it fails as out of memory, without a second try.
func TestABuildKilledForMemoryAloneIsNotRetried(t *testing.T) {
	d, docker := bakeDriver(t)
	docker.buildErr = &dockercli.ExitError{Command: "docker run --rm", Code: dockercli.ExitKilled}
	_, _, err := d.build(context.Background(), machine("claim-1", bakeEnv), []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
	if !errors.Is(err, driver.ErrOutOfMemory) || len(docker.builds) != 1 {
		t.Fatalf("err %v after %d builds, want out of memory after one", err, len(docker.builds))
	}
}

// Still out of memory when alone is the claim's failure, after exactly one retry.
func TestABuildThatIsKilledForMemoryAloneAsWellFailsOutOfMemory(t *testing.T) {
	d, g, ref := parallelDriver(t)
	g.fail = map[string]error{"app": &dockercli.ExitError{Command: "docker run --rm", Code: dockercli.ExitKilled}}
	_, _, err := d.build(context.Background(), ref, distinctBuilds(t, "api", "app"), "net", "resolv", bakeSubnet, nil, nil)
	if !errors.Is(err, driver.ErrOutOfMemory) {
		t.Fatalf("err %v, want out of memory", err)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	apps := 0
	for _, r := range g.runs {
		if serviceOf(r) == "app" {
			apps++
		}
	}
	if apps != 2 || len(g.runs) != 3 {
		t.Fatalf("%d builds of app in %d, want 2 (its try and one retry) in 3", apps, len(g.runs))
	}
}
