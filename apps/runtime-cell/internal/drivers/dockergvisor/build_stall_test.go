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

// A big image's export writes its layers for many minutes and prints nothing
// meanwhile: that is the exporter working, not a hung builder, so it gets the
// longer export limit and is never stopped at the short one.
func TestABuilderSilentInsideTheExportIsLeftRunningPastTheShortLimit(t *testing.T) {
	d, docker := bakeDriver(t)
	docker.buildOutput = []string{
		"#8 [api 5/5] COPY . .",
		"#8 DONE 3.0s",
		"#9 exporting to image",
		"#9 exporting layers",
	}
	docker.stallBuild = true
	h := d.hooksForTest()
	h.buildStallAfter, h.buildStallEvery = 50*time.Millisecond, 5*time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	_, _, err := d.build(ctx, machine("claim-pr", bakeEnv), []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
	if errors.Is(err, driver.ErrBuilderFailed) {
		t.Fatalf("a long silent export was stopped as the cell's failure: %v", err)
	}
	if err == nil {
		t.Fatal("the hung build returned no error")
	}
}

// An export that stays silent past the export limit is hung all the same.
func TestABuilderSilentInTheExportPastItsLimitIsStoppedAsTheCells(t *testing.T) {
	d, docker := bakeDriver(t)
	docker.buildOutput = []string{
		"#9 exporting to image",
		"#9 exporting layers",
	}
	docker.stallBuild = true
	h := d.hooksForTest()
	h.buildStallAfter, h.buildExportStallAfter, h.buildStallEvery = 50*time.Millisecond, 150*time.Millisecond, 5*time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := d.build(ctx, machine("claim-pr", bakeEnv), []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
	if !errors.Is(err, driver.ErrBuilderFailed) || !strings.Contains(err.Error(), "printed nothing") {
		t.Fatalf("a builder silent in its export past the limit was not stopped: %v", err)
	}
}

// An `npm install` of a Dockerfile whose stage has no name is numbered
// "[2/5] RUN ..." and prints nothing while it resolves: that is the project's
// step, never a builder that hung between BuildKit's own steps.
func TestABuilderSilentInAStepOfAnUnnamedStageIsLeftRunning(t *testing.T) {
	d, docker := bakeDriver(t)
	docker.buildOutput = []string{
		"#1 [internal] load build definition from Dockerfile",
		"#1 DONE 0.0s",
		"#8 [2/5] RUN npm install",
	}
	docker.stallBuild = true
	h := d.hooksForTest()
	h.buildStallAfter, h.buildStallEvery = 50*time.Millisecond, 5*time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	_, _, err := d.build(ctx, machine("claim-pr", bakeEnv), []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
	if errors.Is(err, driver.ErrBuilderFailed) {
		t.Fatalf("a quiet step of an unnamed stage was stopped as the cell's failure: %v", err)
	}
}

// The same for a Dockerfile of ten or more steps, whose first nine BuildKit
// pads with a second space ("[stage-0  2/13] RUN apt-get ..."): live, an
// apt-get install of that form was stopped as the cell's after 5m of silence.
func TestABuilderSilentInAPaddedProjectStepIsLeftRunning(t *testing.T) {
	d, docker := bakeDriver(t)
	docker.buildOutput = []string{
		"#1 [internal] load build definition from Dockerfile",
		"#1 DONE 0.0s",
		"#6 [stage-0  2/13] RUN apt-get update  && apt-get install -y xvfb",
		"#6 581.6 Preparing to unpack .../90-xvfb_amd64.deb ...",
	}
	docker.stallBuild = true
	h := d.hooksForTest()
	h.buildStallAfter, h.buildStallEvery = 50*time.Millisecond, 5*time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	_, _, err := d.build(ctx, machine("claim-pr", bakeEnv), []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
	if errors.Is(err, driver.ErrBuilderFailed) {
		t.Fatalf("a quiet padded project step was stopped as the cell's failure: %v", err)
	}
}

// No phase is silent forever: a project's step that prints nothing past the
// hard ceiling is stopped as the cell's failure all the same.
func TestABuilderSilentInAProjectStepPastTheHardCeilingIsStopped(t *testing.T) {
	d, docker := bakeDriver(t)
	docker.buildOutput = []string{"#8 [api 2/5] RUN npm run build"}
	docker.stallBuild = true
	h := d.hooksForTest()
	h.buildStallAfter, h.buildStallEvery, h.buildHardStallAfter = 50*time.Millisecond, 5*time.Millisecond, 150*time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := d.build(ctx, machine("claim-pr", bakeEnv), []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
	if !errors.Is(err, driver.ErrBuilderFailed) || !strings.Contains(err.Error(), "ceiling") {
		t.Fatalf("a project step silent past the ceiling was not stopped: %v", err)
	}
}
