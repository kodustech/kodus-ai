package dockergvisor

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

// windowDocker is the part of Docker a probe round's service logs read.
// dockercli.CLI has it; a Docker without it gives no logs.
type windowDocker interface {
	ComposePs(ctx context.Context, project string) ([]byte, error)
	ComposeLogsWindow(ctx context.Context, project, service string, since, until time.Time, lines int) ([]byte, error)
}

// ServiceLogs is driver.ServiceLogReader: every service of the claim's
// compose project, the lines it logged in [since, until] (the daemon's
// timestamps), oldest first, at most maxLines in all (the newest kept).
// Only this cell's workloads.
func (d *Driver) ServiceLogs(ctx context.Context, _ string, ref driver.MachineRef, since, until time.Time, maxLines int) ([]driver.ServiceLogLine, error) {
	if driver.Role(ref.Tags[driver.TagRole]) != driver.RoleWorkload {
		return nil, fmt.Errorf("dockergvisor: %s is not a workload", ref.MachineID)
	}
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return nil, err
	}
	dd, ok := d.d.(windowDocker)
	if !ok || maxLines <= 0 {
		return nil, nil
	}
	raw, err := dd.ComposePs(ctx, ref.MachineID)
	if err != nil {
		return nil, fmt.Errorf("dockergvisor: service logs: ps: %w", err)
	}
	states, err := dockercli.ParseComposePs(raw)
	if err != nil {
		return nil, fmt.Errorf("dockergvisor: service logs: ps: %w", err)
	}
	var out []driver.ServiceLogLine
	var errs []error
	for _, s := range states {
		b, err := dd.ComposeLogsWindow(ctx, ref.MachineID, s.Service, since, until, maxLines)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", s.Service, err))
			continue
		}
		for _, l := range dockercli.ParseTimestampedLogs(b) {
			out = append(out, driver.ServiceLogLine{Service: s.Service, At: l.At, Text: l.Text})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	if len(out) > maxLines {
		out = out[len(out)-maxLines:]
	}
	if len(errs) > 0 && len(out) == 0 {
		return nil, fmt.Errorf("dockergvisor: service logs: %v", errs)
	}
	return out, nil
}

var _ driver.ServiceLogReader = (*Driver)(nil)
