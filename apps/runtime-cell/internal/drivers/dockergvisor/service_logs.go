package dockergvisor

import (
	"context"
	"fmt"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/composecmd"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

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
	project, _ := d.projectOf(ref.MachineID)
	out, err := composecmd.ServiceLogs(ctx, d.d, project, since, until, maxLines)
	if err != nil {
		return nil, fmt.Errorf("dockergvisor: %w", err)
	}
	return out, nil
}

var _ driver.ServiceLogReader = (*Driver)(nil)

// ExitedServices is driver.ExitedServiceReader: the services of the claim's
// compose project that have exited, with their exit code and the tail of their log.
func (d *Driver) ExitedServices(ctx context.Context, ref driver.MachineRef, tail int) ([]driver.ExitedService, error) {
	if driver.Role(ref.Tags[driver.TagRole]) != driver.RoleWorkload {
		return nil, fmt.Errorf("dockergvisor: %s is not a workload", ref.MachineID)
	}
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return nil, err
	}
	project, _ := d.projectOf(ref.MachineID)
	return composecmd.ExitedServices(ctx, d.d, project, tail)
}

var _ driver.ExitedServiceReader = (*Driver)(nil)
