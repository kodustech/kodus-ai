package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// overlayPR is a pull request's machine whose builds read the environment's
// state through an overlay: a setup seeded it first.
func overlayPR(t *testing.T) (*Driver, *memDocker, sandbox.Build, driver.MachineRef) {
	t.Helper()
	d, docker, _ := statefulDriver(t)
	build := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, true)
	boot(t, d, setup, build)
	return d, docker, build, machine("claim-pr", bakeEnv)
}

const npmFailure = `#6 [deps 3/5] RUN npm ci
#6 12.101 npm ERR! code ENOTFOUND
#6 12.104 npm ERR! network request to https://registry.npmjs.org/x failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org
#6 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1
error: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1`

// Any failure on the overlay used to build again from cold, doubling the
// time of a genuine failure past the claim's readiness deadline. A step that
// mounts no cache and exits with an error is the code's: built once.
func TestAStepThatFailsOnTheOverlayIsNotBuiltTwice(t *testing.T) {
	d, docker, build, pr := overlayPR(t)
	before := len(docker.builds)
	docker.buildOutput = strings.Split(npmFailure, "\n")
	docker.buildErr = &dockercli.ExitError{Command: "docker run", Code: 1, Stderr: "error: failed to solve"}
	err := bootErr(d, pr, build)
	if err == nil || errors.Is(err, driver.ErrBuilderFailed) {
		t.Fatalf("a failed step: %v", err)
	}
	if n := len(docker.builds) - before; n != 1 {
		t.Fatalf("built %d times, want once", n)
	}
	// The step's own lines come first, ahead of the docker command.
	msg := err.Error()
	if !strings.Contains(msg, "step [deps 3/5] RUN npm ci failed:\n  npm ERR! code ENOTFOUND") || strings.Index(msg, "ENOTFOUND") > strings.Index(msg, "docker run") {
		t.Fatalf("message: %s", msg)
	}
}

// A step that mounts a build cache can fail on what the overlay gave it: it
// runs again without the state.
func TestAStepWithACacheMountRunsAgainWithoutTheOverlay(t *testing.T) {
	d, docker, build, pr := overlayPR(t)
	before := len(docker.builds)
	docker.buildOutput = strings.Split(strings.ReplaceAll(npmFailure, "RUN npm ci\n", "RUN --mount=type=cache,target=/root/.npm npm ci\n"), "\n")
	docker.buildErr = &dockercli.ExitError{Command: "docker run", Code: 1}
	if err := bootErr(d, pr, build); err == nil {
		t.Fatal("a build that fails both times was taken")
	}
	if n := len(docker.builds) - before; n != 2 {
		t.Fatalf("built %d times, want twice", n)
	}
}

// A second, cold build is only started when the claim has the time the
// first one took left.
func TestNoSecondBuildPastTheClaimsDeadline(t *testing.T) {
	d, docker, build, pr := overlayPR(t)
	clk := clock.NewFake(time.Now())
	d.clock = clk
	ctx, cancel := context.WithDeadline(context.Background(), clk.Now().Add(10*time.Minute))
	defer cancel()
	docker.duringBuild = func(dockercli.BuildRun) { clk.Advance(6 * time.Minute) }
	docker.buildErr = errors.New("failed to solve: failed to prepare snapshot: no such file or directory")
	before := len(docker.builds)
	if _, _, err := d.build(ctx, pr, []sandbox.Build{build}, "net", "resolv", bakeSubnet, nil); err == nil {
		t.Fatal("a failed build was taken")
	}
	if n := len(docker.builds) - before; n != 1 {
		t.Fatalf("built %d times with 4 minutes left after a 6 minute build", n)
	}
}

// The observed case: the builder exited 2 during apt-get install with steps
// still running and none failed. It used to be the recipe's toolchain
// failure; it is the platform's now, as is docker failing to run the builder.
func TestABuilderThatDiesIsThePlatforms(t *testing.T) {
	for name, tc := range map[string]struct {
		output []string
		err    error
	}{
		"died during a step": {
			[]string{"#7 [base 3/9] RUN apt-get update && apt-get install -y build-essential", "#7 4.200 Get:1 http://deb.debian.org/debian bookworm InRelease"},
			&dockercli.ExitError{Command: "docker run", Code: 2, Stderr: "Get:1 http://deb.debian.org/debian bookworm InRelease"},
		},
		"docker could not run it": {nil, &dockercli.ExitError{Command: "docker run", Code: 125, Stderr: "docker: Error response from daemon: unknown runtime"}},
	} {
		t.Run(name, func(t *testing.T) {
			d, docker := bakeDriver(t)
			docker.buildOutput, docker.buildErr = tc.output, tc.err
			_, _, err := d.runBuild(context.Background(), machine("claim-died", bakeEnv), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}, "t:claim", "net", "resolv", bakeSubnet, nil)
			if !errors.Is(err, driver.ErrBuilderFailed) {
				t.Fatalf("err %v", err)
			}
		})
	}
	// A step that failed is not the builder's.
	d, docker := bakeDriver(t)
	docker.buildOutput = strings.Split(npmFailure, "\n")
	docker.buildErr = &dockercli.ExitError{Command: "docker run", Code: 1}
	_, _, err := d.runBuild(context.Background(), machine("claim-step", bakeEnv), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}, "t:claim", "net", "resolv", bakeSubnet, nil)
	if err == nil || errors.Is(err, driver.ErrBuilderFailed) {
		t.Fatalf("a failed step: %v", err)
	}
}

// A builder that dies with no step failed says why through buildkitd's own
// log: the platform's error ends with its last lines, redacted.
func TestABuilderThatDiesCarriesBuildkitdsLastLines(t *testing.T) {
	d, docker := bakeDriver(t)
	docker.buildErr = &dockercli.ExitError{Command: "docker run", Code: 1}
	docker.duringBuild = func(b dockercli.BuildRun) {
		log := "time=\"2026-11-12T10:00:00Z\" level=info msg=\"running server\"\n" +
			"time=\"2026-11-12T10:00:01Z\" level=error msg=\"failed to mount overlay\" NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz0123456789\n"
		if err := os.WriteFile(filepath.Join(b.Out, dockercli.BuilderLog), []byte(log), 0o600); err != nil {
			t.Error(err)
		}
	}
	_, _, err := d.runBuild(context.Background(), machine("claim-died", bakeEnv), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}, "t:claim", "net", "resolv", bakeSubnet, nil)
	if !errors.Is(err, driver.ErrBuilderFailed) {
		t.Fatalf("err %v", err)
	}
	if msg := err.Error(); !strings.Contains(msg, "failed to mount overlay") || strings.Contains(msg, "npm_abcdefghijklmnopqrstuvwxyz0123456789") {
		t.Fatalf("message: %s", msg)
	}
}

// What the builder leaves is bounded before the cell loads it, and the load
// is told the one name the image may carry.
func TestTheBuildOutputIsBoundedAndTheLoadKnowsItsTag(t *testing.T) {
	d, docker := bakeDriver(t)
	var asked dockercli.ImageLoad
	wrapped := &recordingLoad{memDocker: docker, asked: &asked}
	d.d = wrapped
	ref := machine("claim-load", bakeEnv)
	b := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
	if _, _, err := d.runBuild(context.Background(), ref, b, "kodus-build/m-api:claim", "net", "resolv", bakeSubnet, nil); err != nil {
		t.Fatal(err)
	}
	if asked.Tag != "kodus-build/m-api:claim" || asked.MaxBytes != d.maxImageBytes() || filepath.Base(asked.Tarball) != dockercli.BuildTarball {
		t.Fatalf("load asked %+v", asked)
	}
	d.cfg.MaxImageBytes = 1 << 10
	docker.duringBuild = func(r dockercli.BuildRun) {
		_ = os.WriteFile(filepath.Join(r.Out, "filler"), make([]byte, 2<<10), 0o600)
	}
	asked = dockercli.ImageLoad{}
	if _, _, err := d.runBuild(context.Background(), ref, b, "kodus-build/m-api:claim", "net", "resolv", bakeSubnet, nil); !errors.Is(err, driver.ErrImageTooLarge) || asked.Tarball != "" {
		t.Fatalf("an output past the bound: %v, loaded %+v", err, asked)
	}
}

type recordingLoad struct {
	*memDocker
	asked *dockercli.ImageLoad
}

func (r *recordingLoad) LoadImage(ctx context.Context, l dockercli.ImageLoad) error {
	*r.asked = l
	return r.memDocker.LoadImage(ctx, l)
}

func TestCheckBuildOutputRefusesAManyFileOutput(t *testing.T) {
	out := t.TempDir()
	for i := range maxBuildOutputEntries + 1 {
		if err := os.WriteFile(filepath.Join(out, fmt.Sprintf("f%03d", i)), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := checkBuildOutput(out, 1<<20); !errors.Is(err, driver.ErrImageLoad) {
		t.Fatalf("err %v", err)
	}
}

// fillingBuilder is a build that writes past the cell's image bound and then
// keeps running, as a pull request filling the host's disk does, until it is
// stopped or a while passes. stopped: its context ended first.
type fillingBuilder struct {
	*memDocker
	fill    func(dockercli.BuildRun) string
	stopped bool
}

func (f *fillingBuilder) RunBuild(ctx context.Context, b dockercli.BuildRun) error {
	if err := f.memDocker.RunBuild(ctx, b); err != nil {
		return err
	}
	if err := os.WriteFile(f.fill(b), make([]byte, 64<<10), 0o600); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		f.stopped = true
		return ctx.Err()
	case <-time.After(5 * time.Second):
		return nil
	}
}

// A build that writes its output past the cell's image bound is stopped while
// it runs, before it fills the host's disk, and ends as an image too large.
func TestABuildWritingPastTheImageBoundIsStoppedWhileItRuns(t *testing.T) {
	d, docker := bakeDriver(t)
	d.cfg.MaxImageBytes = 1 << 10
	d.hooksForTest().buildDiskEvery = 10 * time.Millisecond
	f := &fillingBuilder{memDocker: docker, fill: func(b dockercli.BuildRun) string { return filepath.Join(b.Out, dockercli.BuildTarball) }}
	d.d = f
	_, _, err := d.runBuild(context.Background(), machine("claim-fill", bakeEnv), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}, "kodus-build/m-api:claim", "net", "resolv", bakeSubnet, nil)
	if !errors.Is(err, driver.ErrImageTooLarge) || !f.stopped {
		t.Fatalf("err %v, stopped while it ran %v", err, f.stopped)
	}
}
