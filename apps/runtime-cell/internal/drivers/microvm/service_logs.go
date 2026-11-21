package microvm

import (
	"context"
	"fmt"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/composecmd"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

const serviceLogsTimeout = 60_000

// ServiceLogs is driver.ServiceLogReader for an environment VM: every
// service of the claim's compose project, what it logged in [since, until]
// by the VM's dockerd timestamps, oldest first, at most maxLines in all
// (the newest kept). Read through the guest agent, as the gVisor driver
// reads the host's Docker; the lines are untrusted and the agent redacts
// and caps them.
func (d *Driver) ServiceLogs(ctx context.Context, _ string, ref driver.MachineRef, since, until time.Time, maxLines int) ([]driver.ServiceLogLine, error) {
	if driver.Role(ref.Tags[driver.TagRole]) != driver.RoleWorkload {
		return nil, fmt.Errorf("microvm: %s is not a workload", ref.MachineID)
	}
	out, err := composecmd.ServiceLogs(ctx, guestCompose{d: d, ref: ref}, projectName(ref), since, until, maxLines)
	if err != nil {
		return nil, fmt.Errorf("microvm: %w", err)
	}
	return out, nil
}

// guestCompose runs a compose command in the machine's VM through its guest
// agent; a non-zero exit is an error carrying the tail of stderr.
type guestCompose struct {
	d   *Driver
	ref driver.MachineRef
}

func (g guestCompose) run(ctx context.Context, argv []string) ([]byte, error) {
	r, err := g.d.Exec(ctx, g.ref, kodyexec.Request{Command: composecmd.DockerLine(argv), TimeoutMs: serviceLogsTimeout})
	if err == nil && r.ExitCode != 0 {
		err = fmt.Errorf("exit %d: %s", r.ExitCode, tailOf(r.Stderr, 500))
	}
	if err != nil {
		return nil, err
	}
	return []byte(r.Stdout), nil
}

func (g guestCompose) ComposePs(ctx context.Context, project string) ([]byte, error) {
	return g.run(ctx, composecmd.Ps(project))
}

func (g guestCompose) ComposeLogsWindow(ctx context.Context, project, service string, since, until time.Time, lines int) ([]byte, error) {
	return g.run(ctx, composecmd.LogsWindow(project, service, since, until, lines))
}

var _ driver.ServiceLogReader = (*Driver)(nil)
