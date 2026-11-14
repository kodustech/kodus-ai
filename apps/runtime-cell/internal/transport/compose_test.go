package transport

import (
	"context"
	"errors"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

// The compose transport never runs exec on the cell host: without the
// driver's exec it refuses, with it the driver gets the request.
func TestComposeRunsExecOnlyThroughTheDriver(t *testing.T) {
	if _, err := (Compose{}).Exec(context.Background(), driver.MachineRef{}, kodyexec.Request{Command: "id"}); !errors.Is(err, ErrNoExec) {
		t.Fatalf("exec without the driver: %v", err)
	}
	var got kodyexec.Request
	tr := Compose{Run: func(_ context.Context, _ driver.MachineRef, r kodyexec.Request) (kodyexec.Result, error) {
		got = r
		return kodyexec.Result{Stdout: "uid=0"}, nil
	}}
	if res, err := tr.Exec(context.Background(), driver.MachineRef{}, kodyexec.Request{Command: "id"}); err != nil || res.Stdout != "uid=0" || got.Command != "id" {
		t.Fatalf("driver exec: %+v %v %+v", res, err, got)
	}
}

// It used to hand the driver the agent's "workspace/<rel>" as is: the
// docker-gvisor driver joined it to the container's WORKDIR, and every
// command of a Run ran in /grafana/workspace, a directory the image does not
// have (exit 127 for all five of the agent's look-around commands).
func TestComposeHandsTheDriverACwdRelativeToTheContainersWorkdir(t *testing.T) {
	var got string
	tr := Compose{Run: func(_ context.Context, _ driver.MachineRef, r kodyexec.Request) (kodyexec.Result, error) {
		got = r.Cwd
		return kodyexec.Result{}, nil
	}}
	for in, want := range map[string]string{"": "", Workspace: "", Workspace + "/pkg/api": "pkg/api"} {
		if _, err := tr.Exec(context.Background(), driver.MachineRef{}, kodyexec.Request{Command: "ls", Cwd: in}); err != nil || got != want {
			t.Errorf("cwd %q reached the driver as %q (%v), want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"src", "workspacex", Workspace + "/", "/workspace", "../workspace"} {
		got = "untouched"
		if _, err := tr.Exec(context.Background(), driver.MachineRef{}, kodyexec.Request{Command: "ls", Cwd: in}); err == nil || got != "untouched" {
			t.Errorf("cwd %q outside the workspace reached the driver as %q", in, got)
		}
	}
}
