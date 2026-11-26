package dockergvisor

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
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
