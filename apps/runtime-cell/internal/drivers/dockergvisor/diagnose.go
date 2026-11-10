package dockergvisor

import (
	"context"
	"fmt"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

// diagnoseLines is how far back each service's log goes in a failure
// bundle; the agent keeps the tail and redacts it before it leaves.
const diagnoseLines = 500

// diagnosticDocker is the part of Docker the failure bundle reads.
// dockercli.CLI has it; a Docker without it gives an empty bundle.
type diagnosticDocker interface {
	ComposePs(ctx context.Context, project string) ([]byte, error)
	ComposeLogs(ctx context.Context, project, service string, lines int) ([]byte, error)
}

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
	dd, ok := d.d.(diagnosticDocker)
	if !ok {
		return out, nil
	}
	raw, err := dd.ComposePs(ctx, ref.MachineID)
	if err != nil {
		return out, fmt.Errorf("dockergvisor: diagnose: ps: %w", err)
	}
	states, err := dockercli.ParseComposePs(raw)
	if err != nil {
		return out, fmt.Errorf("dockergvisor: diagnose: ps: %w", err)
	}
	for _, s := range states {
		lines := []string{}
		if b, err := dd.ComposeLogs(ctx, ref.MachineID, s.Service, diagnoseLines); err != nil {
			lines = append(lines, "kodus: logs unavailable: "+err.Error())
		} else if text := strings.TrimRight(string(b), "\n"); text != "" {
			lines = strings.Split(text, "\n")
		}
		out.Services = append(out.Services, driver.ServiceDiagnostics{Name: s.Service, State: s.State, Log: lines})
	}
	return out, nil
}

var _ driver.Diagnoser = (*Driver)(nil)
