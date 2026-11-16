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
	out, err := composecmd.ServiceLogs(ctx, d.d, ref.MachineID, since, until, maxLines)
	if err != nil {
		return nil, fmt.Errorf("dockergvisor: %w", err)
	}
	return out, nil
}

var _ driver.ServiceLogReader = (*Driver)(nil)
