package cellupdate

import (
	"context"
	"io"
	"os/exec"
	"time"
)

// preflightTimeout bounds the staged release's preflight: Docker's answers
// and a microVM kit's digests.
const preflightTimeout = 5 * time.Minute

// StagedPreflight is Options.Preflight for the cell's config file: the
// staged cell's `cell preflight -config <config>`, its report on out and
// errOut; a non-zero exit is the error. The staged cell matched the signed
// manifest before it runs, and the environment is the update's own, as the
// cell's unit gives it to the cell.
func StagedPreflight(config string, out, errOut io.Writer) func(cell string) error {
	return func(cell string) error {
		ctx, cancel := context.WithTimeout(context.Background(), preflightTimeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, cell, "preflight", "-config", config) //nolint:gosec // G204: the staged cell, verified against the signed manifest
		cmd.Stdout, cmd.Stderr = out, errOut
		return cmd.Run()
	}
}
