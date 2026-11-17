package dockergvisor

import (
	"context"
	"fmt"
	"regexp"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// coverageFlushSignal is what the coverage preload listens for
// (compose.PreloadSource).
const coverageFlushSignal = "SIGUSR2"

// composeServiceName is a compose service name as compose accepts one.
var composeServiceName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)

// FlushCoverage sends the coverage preload's signal to the instrumented
// services of a workload's project: each writes what it ran so far into
// the claim's coverage directory and runs on.
func (d *Driver) FlushCoverage(ctx context.Context, ref driver.MachineRef, services []string) error {
	if driver.Role(ref.Tags[driver.TagRole]) != driver.RoleWorkload {
		return fmt.Errorf("dockergvisor: %s is not a workload", ref.MachineID)
	}
	if len(services) == 0 {
		return nil
	}
	for _, s := range services {
		if !composeServiceName.MatchString(s) {
			return fmt.Errorf("dockergvisor: %q is not a service name", s)
		}
	}
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return err
	}
	if err := d.d.ComposeKill(ctx, ref.MachineID, coverageFlushSignal, services...); err != nil {
		return fmt.Errorf("dockergvisor: flush coverage: %w", err)
	}
	return nil
}

var _ driver.CoverageFlusher = (*Driver)(nil)
