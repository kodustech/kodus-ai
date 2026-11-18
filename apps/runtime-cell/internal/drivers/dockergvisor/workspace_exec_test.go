package dockergvisor

import (
	"context"
	"errors"
	"maps"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

// The service a command on another repository's code runs in is the one
// built from that repository's directory of the workspace.
func TestRepositoryServicesMapsEachMemberToTheServiceBuiltFromIt(t *testing.T) {
	canonical := []byte(`{"services":{
		"app":{"build":{"context":"/claims/c1/ws/shop"}},
		"billing-worker":{"build":{"context":"/claims/c1/ws/billing/worker"}},
		"billing":{"build":{"context":"/claims/c1/ws/billing"}},
		"ledger":{"build":{"context":"/claims/c1/ws/ledger/"}},
		"db":{"image":"postgres:16"},
		"escape":{"build":{"context":"/claims/c1/other"}},
		"relative":{"build":{"context":"ws/web"}}
	}}`)
	got := repositoryServices(canonical, "/claims/c1/ws", "/claims/c1/ws/shop")
	want := map[string]string{"billing": "billing", "ledger": "ledger"}
	if !maps.Equal(got, want) {
		t.Fatalf("services %v, want %v", got, want)
	}
	if got := repositoryServices(canonical, "", "/claims/c1/ws/shop"); got != nil {
		t.Fatalf("a claim of one repository maps %v", got)
	}
	if got := repositoryServices([]byte("not json"), "/claims/c1/ws", "/claims/c1/ws/shop"); got != nil {
		t.Fatalf("unreadable config maps %v", got)
	}
}

func TestAnExecOnAMemberRunsInTheContainerBuiltFromIt(t *testing.T) {
	d, docker := withEgress(t)
	ctx := context.Background()
	ref := driver.MachineRef{MachineID: "kodus-claim-1-workload"}
	m := d.machineLocked(ref.MachineID)
	m.exec = &execTarget{container: "capp", dir: "/app"}
	m.repoExec = map[string]execTarget{"billing": {container: "cbilling", dir: "/srv"}}
	docker.execAnswer = kodyexec.Result{Stdout: "ok"}
	if _, err := d.Exec(ctx, ref, kodyexec.Request{Command: "go test ./...", Cwd: "pkg", Repository: "billing", TimeoutMs: 1000}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(ctx, ref, kodyexec.Request{Command: "npm test", TimeoutMs: 1000}); err != nil {
		t.Fatal(err)
	}
	if e := docker.execs[0]; e.spec.Container != "cbilling" || e.spec.Dir != "/srv/pkg" {
		t.Fatalf("member exec ran as %+v", e.spec)
	}
	if e := docker.execs[1]; e.spec.Container != "capp" || e.spec.Dir != "/app" {
		t.Fatalf("own exec ran as %+v", e.spec)
	}
	if _, err := d.Exec(ctx, ref, kodyexec.Request{Command: "id", Repository: "ledger"}); !errors.Is(err, ErrNoRepositoryService) {
		t.Fatalf("exec on a repository no service is built from: %v", err)
	}
	if _, err := d.Exec(ctx, ref, kodyexec.Request{Command: "id", Repository: "billing", Cwd: "../app"}); err == nil {
		t.Fatal("a member exec left its container's workspace")
	}
}
