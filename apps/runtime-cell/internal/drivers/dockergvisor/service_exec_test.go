package dockergvisor

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

// exec.service: the command runs in the named compose service's container,
// from that container's own working directory, public or not.
func TestAnExecOnAServiceRunsInThatServicesContainer(t *testing.T) {
	d, docker := withEgress(t)
	ctx := context.Background()
	ref := driver.MachineRef{MachineID: "kodus-claim-1-workload"}
	m := d.machineLocked(ref.MachineID)
	m.exec = &execTarget{container: "capp", dir: "/app"}
	m.targets = map[string]execTarget{"app": {container: "capp", dir: "/app"}, "e2e": {container: "ce2e", dir: "/e2e"}}
	docker.execAnswer = kodyexec.Result{Stdout: "ok"}
	if _, err := d.Exec(ctx, ref, kodyexec.Request{Command: "npx cypress run", Cwd: "apps/dashboard", Service: "e2e", TimeoutMs: 1000}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(ctx, ref, kodyexec.Request{Command: "ls", TimeoutMs: 1000}); err != nil {
		t.Fatal(err)
	}
	if e := docker.execs[0]; e.spec.Container != "ce2e" || e.spec.Dir != "/e2e/apps/dashboard" {
		t.Fatalf("service exec ran as %+v", e.spec)
	}
	if e := docker.execs[1]; e.spec.Container != "capp" || e.spec.Dir != "/app" {
		t.Fatalf("a request with no service left the public service: %+v", e.spec)
	}
}

// A service the project does not have is an error: never the public service's container.
func TestAnExecOnAnUnknownServiceFailsAndRunsNothing(t *testing.T) {
	d, docker := withEgress(t)
	ref := driver.MachineRef{MachineID: "kodus-claim-1-workload"}
	m := d.machineLocked(ref.MachineID)
	m.exec = &execTarget{container: "capp", dir: "/app"}
	m.targets = map[string]execTarget{"app": {container: "capp", dir: "/app"}}
	_, err := d.Exec(context.Background(), ref, kodyexec.Request{Command: "id", Service: "e2e", TimeoutMs: 1000})
	if !errors.Is(err, ErrNoServiceTarget) || !strings.Contains(err.Error(), "e2e") {
		t.Fatalf("exec on a service the project lacks: %v", err)
	}
	if len(docker.execs) != 0 {
		t.Fatalf("an exec on an unknown service ran in %+v", docker.execs[0].spec)
	}
}

// cwd stays inside the service container's workdir, as it does in the public one.
func TestAServiceExecStaysInsideItsContainersWorkdir(t *testing.T) {
	d, docker := withEgress(t)
	ref := driver.MachineRef{MachineID: "kodus-claim-1-workload"}
	m := d.machineLocked(ref.MachineID)
	m.targets = map[string]execTarget{"e2e": {container: "ce2e", dir: "/e2e"}}
	for _, cwd := range []string{"../app", "/etc", "a/../../x"} {
		if _, err := d.Exec(context.Background(), ref, kodyexec.Request{Command: "id", Service: "e2e", Cwd: cwd, TimeoutMs: 1000}); err == nil {
			t.Fatalf("cwd %q left the service container's workspace", cwd)
		}
	}
	if len(docker.execs) != 0 {
		t.Fatal("a refused cwd ran")
	}
}
