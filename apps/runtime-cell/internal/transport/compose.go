package transport

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

// Workspace is where the agent puts the checkout on a machine (the dst of
// Upload) and the root every exec.cwd lives under ("workspace/<rel>").
const Workspace = "workspace"

// ErrNoExec: the driver has no way to run a command in the project.
var ErrNoExec = errors.New("transport: this driver runs no commands in the project")

// Compose is the transport of a driver that boots the checkout itself
// (ComposeBooter): nothing to upload, and exec goes to the driver, which runs
// it inside the project's sandbox, never on the cell host. There the
// workspace is the service container's own working directory, so the cwd
// reaches the driver relative to it, without the agent's "workspace" root.
type Compose struct {
	Run func(context.Context, driver.MachineRef, kodyexec.Request) (kodyexec.Result, error)
}

var _ Transport = Compose{}

func (t Compose) Exec(ctx context.Context, ref driver.MachineRef, req kodyexec.Request) (kodyexec.Result, error) {
	if t.Run == nil {
		return kodyexec.Result{}, ErrNoExec
	}
	rel, err := WorkspaceRel(req.Cwd)
	if err != nil {
		return kodyexec.Result{}, err
	}
	req.Cwd = rel
	return t.Run(ctx, ref, req)
}

func (Compose) Upload(context.Context, driver.MachineRef, string, string) error { return nil }

// WorkspaceRel is cwd without its Workspace root: "" for the workspace
// itself, "a/b" for "workspace/a/b". A cwd outside the workspace is refused.
func WorkspaceRel(cwd string) (string, error) {
	if cwd == "" || cwd == Workspace {
		return "", nil
	}
	if rel, ok := strings.CutPrefix(cwd, Workspace+"/"); ok && rel != "" {
		return rel, nil
	}
	return "", fmt.Errorf("transport: cwd %q is not under the workspace", cwd)
}
