package dockergvisor

import (
	"context"
	"fmt"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/composecmd"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// diagnoseLines is how far back each service's log goes in a failure
// bundle; the agent keeps the tail and redacts it before it leaves.
const diagnoseLines = 500

// Diagnose is driver.Diagnoser: what each service of the claim's compose
// project is doing and the last lines it logged, so a setup that did not
// boot says why (the app's "Missing required environment variable") and
// the product's catalog can name the fix. Only this cell's machines.
func (d *Driver) Diagnose(ctx context.Context, _ string, ref driver.MachineRef, _ []driver.ExposePort) (driver.Diagnostics, error) {
	out := driver.Diagnostics{}
	if driver.Role(ref.Tags[driver.TagRole]) != driver.RoleWorkload {
		return out, fmt.Errorf("dockergvisor: %s is not a workload", ref.MachineID)
	}
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return out, err
	}
	project, _ := d.projectOf(ref.MachineID)
	raw, err := d.d.ComposePs(ctx, project)
	if err != nil {
		return out, fmt.Errorf("dockergvisor: diagnose: ps: %w", err)
	}
	states, err := composecmd.ParseComposePs(raw)
	if err != nil {
		return out, fmt.Errorf("dockergvisor: diagnose: ps: %w", err)
	}
	for _, s := range states {
		lines := []string{}
		if b, err := d.d.ComposeLogs(ctx, project, s.Service, diagnoseLines); err != nil {
			lines = append(lines, "kodus: logs unavailable: "+err.Error())
		} else if text := strings.TrimRight(string(b), "\n"); text != "" {
			lines = strings.Split(text, "\n")
		}
		out.Services = append(out.Services, driver.ServiceDiagnostics{Name: s.Service, State: s.State, Log: lines})
	}
	return out, nil
}

var _ driver.Diagnoser = (*Driver)(nil)
