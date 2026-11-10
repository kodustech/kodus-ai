package dockergvisor

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

func TestExecRunsInTheRecipesPublicServiceOrTheOnlyOne(t *testing.T) {
	dir := t.TempDir()
	two := map[string]dockercli.Container{"app": {ID: "capp", WorkingDir: "/app"}, "db": {ID: "cdb"}}
	if _, ok := execService(dir, two); ok {
		t.Fatal("two services and no public one: exec picked one")
	}
	if at, ok := execService(dir, map[string]dockercli.Container{"db": {ID: "cdb"}}); !ok || at.container != "cdb" || at.dir != "/" {
		t.Fatalf("the only service: %+v %v", at, ok)
	}
	writeFile(t, filepath.Join(dir, recipe.Path), "version: 1\nservices:\n  compose:\n    files: [docker-compose.yml]\n    public: app\n")
	if at, ok := execService(dir, two); !ok || at.container != "capp" || at.dir != "/app" {
		t.Fatalf("the public service: %+v %v", at, ok)
	}
}

func TestExecStaysInTheSandboxAndItsWorkspace(t *testing.T) {
	d, docker := withEgress(t)
	ctx := context.Background()
	ref := driver.MachineRef{MachineID: "kodus-claim-1-workload"}
	if _, err := d.Exec(ctx, ref, kodyexec.Request{Command: "id"}); !errors.Is(err, ErrNoExecService) {
		t.Fatalf("exec before the project is up: %v", err)
	}
	d.machineLocked(ref.MachineID).exec = &execTarget{container: "capp", dir: "/app"}
	docker.execAnswer = kodyexec.Result{ExitCode: 0, Stdout: "ok"}
	res, err := d.Exec(ctx, ref, kodyexec.Request{Command: "npm test", Cwd: "packages/api", TimeoutMs: 30_000, Env: []string{"CI=1"}})
	if err != nil || res.Stdout != "ok" {
		t.Fatalf("exec: %+v %v", res, err)
	}
	e := docker.execs[0]
	if e.spec.Container != "capp" || e.spec.Dir != "/app/packages/api" || e.req.TimeoutMs != 30_000 || e.host.TimeoutMs != 30_000+execGrace || e.spec.Env[0] != "CI=1" {
		t.Fatalf("exec ran as %+v", e)
	}
	for _, cwd := range []string{"../etc", "/etc", "a/../../x"} {
		if _, err := d.Exec(ctx, ref, kodyexec.Request{Command: "id", Cwd: cwd}); err == nil {
			t.Errorf("cwd %q left the workspace", cwd)
		}
	}
	if _, err := d.Exec(ctx, ref, kodyexec.Request{Command: "id", Env: []string{"--privileged"}}); err == nil {
		t.Error("an env entry that is not KEY=VALUE reached docker")
	}
	// timeout(1) in the sandbox killed it at the deadline.
	docker.execAnswer = kodyexec.Result{ExitCode: 137, DurationMs: 30_001}
	if res, _ := d.Exec(ctx, ref, kodyexec.Request{Command: "sleep 99", TimeoutMs: 30_000}); !res.TimedOut || res.ExitCode != kodyexec.TimeoutExitCode {
		t.Fatalf("a command killed at its deadline: %+v", res)
	}
	if err := d.Destroy(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(ctx, ref, kodyexec.Request{Command: "id"}); !errors.Is(err, ErrNoExecService) {
		t.Fatalf("exec on a destroyed machine: %v", err)
	}
}
