package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
)

// The unit `cell-host.sh install --fleet-bootstrap` installs: a oneshot that
// runs `cell-host.sh seal`. Its presence is what says this cell is a fleet
// host; a cell installed any other way has no such unit and refuses cell.seal.
const (
	hostSealUnit     = "kodus-cell-seal.service"
	hostSealUnitFile = "/etc/systemd/system/" + hostSealUnit
)

// systemdSealer starts the seal unit with --no-block: the seal stops this
// cell, so it runs under systemd, outliving this process.
type systemdSealer struct {
	unitFile string
	run      func(ctx context.Context, name string, args ...string) error
}

func (s systemdSealer) Seal(ctx context.Context) error {
	return s.run(ctx, "systemctl", "start", "--no-block", hostSealUnit)
}

// hostSealer is the cell's HostSealer, or nil when the seal unit is not
// installed (not a fleet host).
func hostSealer(unitFile string, run func(ctx context.Context, name string, args ...string) error) agent.HostSealer {
	if _, err := os.Stat(unitFile); err != nil {
		return nil
	}
	return systemdSealer{unitFile: unitFile, run: run}
}

func runCommand(ctx context.Context, name string, args ...string) error {
	//nolint:gosec // G204: name and args come from systemdSealer (fixed verbs and the seal unit path), never from a request
	if out, err := exec.CommandContext(ctx, name, args...).CombinedOutput(); err != nil {
		return fmt.Errorf("%s %v: %w: %s", name, args, err, out)
	}
	return nil
}
