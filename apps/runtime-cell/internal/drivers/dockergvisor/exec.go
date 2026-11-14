package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// An exec step (setup commands, the agent's look around, the repository's
// tests) runs inside the workload's public service container: the sandbox
// the PR's code already runs in, under runsc on the claim network, with the
// app's toolchain and dependencies and its services by name. Nothing of the
// request reaches a shell on the cell host. Like any exec output it is
// evidence, never a verdict (ADR-053).

type execTarget struct {
	container string
	dir       string
}

// execService is the container exec steps run in: the recipe's public
// service, or the project's only service.
func execService(projectDir string, containers map[string]dockercli.Container) (execTarget, bool) {
	name := ""
	if rec, err := recipe.Load(projectDir); err == nil && rec != nil {
		name = rec.Services.Compose.Primary()
	}
	if name == "" && len(containers) == 1 {
		for n := range containers {
			name = n
		}
	}
	c, ok := containers[name]
	if !ok {
		return execTarget{}, false
	}
	return targetOf(c), true
}

// targetOf runs commands in c, from its image's working directory.
func targetOf(c dockercli.Container) execTarget {
	dir := c.WorkingDir
	if dir == "" || !path.IsAbs(dir) {
		dir = "/"
	}
	return execTarget{container: c.ID, dir: dir}
}

// ErrNoExecService: the project names no service exec steps could run in.
var ErrNoExecService = errors.New("dockergvisor: no service to run commands in (the recipe names no public service and the project has more than one)")

// execGrace is how much longer the docker client may run than the command:
// timeout(1) in the sandbox stops the command first.
const execGrace = 5_000

var envKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)

// Exec runs the request in the workload's public service container. cwd is
// relative to the container's working directory and stays inside it.
func (d *Driver) Exec(ctx context.Context, ref driver.MachineRef, req kodyexec.Request) (kodyexec.Result, error) {
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return kodyexec.Result{}, err
	}
	at := d.peek(ref.MachineID).exec
	if at == nil {
		return kodyexec.Result{}, ErrNoExecService
	}
	dir, err := inside(at.dir, req.Cwd)
	if err != nil {
		return kodyexec.Result{}, err
	}
	for _, kv := range req.Env {
		if !envKey.MatchString(kv) {
			return kodyexec.Result{}, fmt.Errorf("dockergvisor: env %q is not KEY=VALUE", strings.SplitN(kv, "=", 2)[0])
		}
	}
	return d.execIn(ctx, execTarget{container: at.container, dir: dir}, req), nil
}

// execIn runs req in the container at, from at.dir, under its timeout in
// the sandbox and a little longer on the docker client.
func (d *Driver) execIn(ctx context.Context, at execTarget, req kodyexec.Request) kodyexec.Result {
	timeout := req.TimeoutMs
	if timeout <= 0 {
		timeout = 60_000
	}
	host := req
	host.TimeoutMs = timeout + execGrace
	inSandbox := req
	inSandbox.TimeoutMs = timeout
	res := d.d.Exec(ctx, dockercli.ExecSpec{Container: at.container, Dir: at.dir, Env: req.Env}, inSandbox, host)
	// timeout -s KILL in the sandbox: the command ran out its time.
	if !res.TimedOut && res.ExitCode == 137 && res.DurationMs >= timeout {
		res.TimedOut, res.ExitCode = true, kodyexec.TimeoutExitCode
	}
	return res
}

// inside joins rel to base, refusing anything that leaves base.
func inside(base, rel string) (string, error) {
	if rel == "" {
		return base, nil
	}
	if path.IsAbs(rel) {
		return "", fmt.Errorf("dockergvisor: cwd %q is not relative to the workspace", rel)
	}
	p := path.Join(base, rel)
	if p != base && !strings.HasPrefix(p, strings.TrimSuffix(base, "/")+"/") {
		return "", fmt.Errorf("dockergvisor: cwd %q leaves the workspace", rel)
	}
	return p, nil
}
