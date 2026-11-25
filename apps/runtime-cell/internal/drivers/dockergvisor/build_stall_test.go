package dockergvisor

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// On dev a PR's builder froze between two of BuildKit's own steps (the host's
// lazily restored disk stalled under it) and the build waited for the
// worker's 30 minute boot limit, which read as the PR's boot_timeout and a
// regression. A builder that prints nothing for the stall limit while no step
// of the project runs is stopped as the platform's failure (builder_failed).
func TestABuilderSilentOutsideTheProjectsStepsIsStoppedAsTheCells(t *testing.T) {
	d, docker := bakeDriver(t)
	docker.buildOutput = []string{
		"#1 [internal] load build definition from Dockerfile",
		"#1 DONE 0.0s",
		"#3 docker-image://docker.io/docker/dockerfile:1@sha256:572cebbc",
		"#3 CACHED",
	}
	docker.stallBuild = true
	h := d.hooksForTest()
	h.buildStallAfter, h.buildStallEvery = 50*time.Millisecond, 5*time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := d.build(ctx, machine("claim-pr", bakeEnv), []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
	if !errors.Is(err, driver.ErrBuilderFailed) || !strings.Contains(err.Error(), "printed nothing") {
		t.Fatalf("a builder that went silent between BuildKit's steps was not stopped as the cell's: %v", err)
	}
}

// Silence inside a step of the project is the project's: a RUN that prints
// nothing for a long time (a quiet compiler) is never stopped by the cell.
func TestABuilderSilentInsideAProjectStepIsLeftRunning(t *testing.T) {
	d, docker := bakeDriver(t)
	docker.buildOutput = []string{
		"#1 [internal] load build definition from Dockerfile",
		"#1 DONE 0.0s",
		"#8 [api 2/5] RUN npm run build",
	}
	docker.stallBuild = true
	h := d.hooksForTest()
	h.buildStallAfter, h.buildStallEvery = 50*time.Millisecond, 5*time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	_, _, err := d.build(ctx, machine("claim-pr", bakeEnv), []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
	if errors.Is(err, driver.ErrBuilderFailed) {
		t.Fatalf("a quiet project step was stopped as the cell's failure: %v", err)
	}
	if err == nil {
		t.Fatal("the hung build returned no error")
	}
}
