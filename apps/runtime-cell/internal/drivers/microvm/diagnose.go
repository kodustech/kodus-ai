package microvm

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// Diagnose is driver.Diagnoser for a claim's microVMs: one entry per VM of
// the claim, live or already destroyed (the backend keeps a destroyed VM's
// log past its jail, isolation.MachineLogReader), named "vm <machine>", in
// its last state, its log the states it went through with their times and
// then the tail of its VMM's log. The agent redacts and caps it before it
// leaves the cell. A backend that keeps no logs gives an empty answer.
func (d *Driver) Diagnose(_ context.Context, claimID string, ref driver.MachineRef, _ []driver.ExposePort) (driver.Diagnostics, error) {
	out := driver.Diagnostics{}
	org := ref.Tags[driver.TagOrg]
	if org == "" || claimID == "" {
		return out, errors.New("microvm: diagnose needs the claim and its org")
	}
	keeper, ok := d.cfg.Backend.(isolation.MachineLogReader)
	if !ok {
		return out, nil
	}
	logs, err := keeper.MachineLogs(org, claimID)
	if err != nil {
		return out, fmt.Errorf("microvm: diagnose: %w", err)
	}
	for i := range logs {
		out.Services = append(out.Services, vmDiagnostics(&logs[i]))
	}
	return out, nil
}

func vmDiagnostics(l *isolation.MachineLog) driver.ServiceDiagnostics {
	s := driver.ServiceDiagnostics{Name: "vm " + l.Name, State: "unknown"}
	if n := len(l.Transitions); n > 0 {
		s.State = l.Transitions[n-1].State
	}
	for _, t := range l.Transitions {
		line := t.At.UTC().Format(time.RFC3339Nano) + " state " + t.State
		if t.Detail != "" {
			line += ": " + t.Detail
		}
		s.Log = append(s.Log, line)
	}
	if l.Truncated {
		s.Log = append(s.Log, "(vmm log: earlier lines dropped)")
	}
	for _, line := range strings.Split(strings.TrimRight(l.VMMLog, "\n"), "\n") {
		if line != "" {
			s.Log = append(s.Log, "vmm: "+line)
		}
	}
	return s
}

var _ driver.Diagnoser = (*Driver)(nil)
