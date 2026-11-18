package microvm

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/composecmd"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

// vmstatPath is the guest kernel's counters; oom_kill counts every process
// it killed for memory, a container's or the VM's own (tests point it at a
// file of their own).
const vmstatPath = "/proc/vmstat"

// MachineHealth is driver.HealthReader for a microVM: Running while the
// backend holds the machine and its guest agent answers; OOMKills is the
// guest kernel's oom_kill counter, read through the guest agent.
func (d *Driver) MachineHealth(ctx context.Context, ref driver.MachineRef) (driver.MachineHealth, error) {
	if _, ok, err := d.find(ctx, ref.MachineID); err != nil {
		return driver.MachineHealth{}, err
	} else if !ok {
		return driver.MachineHealth{}, nil
	}
	r, err := d.Exec(ctx, ref, kodyexec.Request{Command: "cat " + composecmd.ShellQuote(d.vmstat()), TimeoutMs: 10_000})
	if err != nil {
		// The machine is there but its guest agent no longer answers: that is
		// the answer (not running), not a failure to read it.
		return driver.MachineHealth{}, nil //nolint:nilerr // an agent that does not answer is a machine that does not run
	}
	if r.ExitCode != 0 {
		return driver.MachineHealth{}, errors.New("microvm: health: " + tailOf(r.Stderr, 200))
	}
	h := driver.MachineHealth{Running: true}
	for _, l := range strings.Split(r.Stdout, "\n") {
		if k, v, ok := strings.Cut(l, " "); ok && k == "oom_kill" {
			h.OOMKills, _ = strconv.ParseUint(strings.TrimSpace(v), 10, 64)
		}
	}
	return h, nil
}

func (d *Driver) vmstat() string {
	if d.vmstatFile != "" {
		return d.vmstatFile
	}
	return vmstatPath
}

var _ driver.HealthReader = (*Driver)(nil)
