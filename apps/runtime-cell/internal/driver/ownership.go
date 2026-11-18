package driver

import (
	"context"
	"errors"
	"fmt"
	"regexp"
)

// claimIDPattern is what every driver can put in a name: a Docker network
// and compose project, a Kubernetes namespace (lowercased, 63 bytes with
// the "kodus-" prefix), a security group name, a path segment.
var claimIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,47}$`)

// ValidateClaimID refuses a claim id a driver could not use as a name.
func ValidateClaimID(id string) error {
	if !claimIDPattern.MatchString(id) {
		return fmt.Errorf("claim id %q: letters, digits and '-', at most 48", id)
	}
	return nil
}

// ErrNotOwned is a driver refusing to touch a machine or a network that is
// not this cell's.
var ErrNotOwned = errors.New("driver: not this cell's")

// ComposeBooter is a driver that brings the claim's compose project up
// itself (docker-gvisor) instead of through the transport. Sources are the
// addresses the project's containers have on the claim network: the claim's
// egress policy must list them, or the proxy and the resolver refuse them as
// unknown sources.
type ComposeBooter interface {
	Up(ctx context.Context, req UpRequest) (sources []string, err error)
}

// SpareKeeper keeps a warm spare of a compose machine's project: a second
// copy booted beside it, on its claim network, from what every boot of the
// machine starts from (its images, the environment's baked data, its golden
// data), never from the copy its rounds used. A machine.reset then swaps
// the spare in instead of bringing the project down and up again
// (docker-gvisor's warm fork reset, docs/runtime/gvisor-warm-fork-reset.md).
//
// BootSpare boots it from req, the Up the claim's project got, and runs the
// recipe's boot steps in it; before gets the addresses the spare's
// containers will take once the driver knows them and before any starts,
// for the claim's egress policy (they differ from the project's). It
// returns once the spare is ready, or fails, and a failed spare turns the
// machine's spares off.
//
// TakeSpare makes a ready spare the machine's project and ends the copy
// its rounds used: sources are the project's addresses from now on. ok
// false: no spare is ready, nothing changed, and the caller resets as
// before. An error turns the machine's spares off; the project is then as
// it was, and the caller resets as before.
//
// DropSpare ends the machine's spare, booting or ready (a claim needs its
// memory); dropped false: it had none.
type SpareKeeper interface {
	BootSpare(ctx context.Context, req UpRequest, before func(sources []string) error) error
	TakeSpare(ctx context.Context, ref MachineRef) (sources []string, ok bool, err error)
	DropSpare(ctx context.Context, ref MachineRef) (dropped bool, err error)
}

// RecipeRunner runs the recipe's own boot steps (setup, data.migrate,
// data.seed: recipe.HasBootSteps) in the compose project the driver's
// ComposeBooter brought up; Parts carries the two on separate fields. The
// agent calls it after every Up, once the claim's egress policy names the
// project's containers (a setup command may fetch), and before the claim is
// ready or the reset's step answers. Output takes the steps' lines as
// UpRequest.Output does; nil: nobody listens.
type RecipeRunner interface {
	RunRecipe(ctx context.Context, ref MachineRef, projectDir string, output func(line string)) error
}

// RecipeStepError is a recipe boot step that failed in the workload: the
// repository's (errors.Is ErrWorkloadBoot), with the step it was so the
// blocker names it.
type RecipeStepError struct {
	// Step is setup, migrate or seed.
	Step string
	// Field is the recipe key: setup[1], data.migrate, data.seed.
	Field string
	Err   error
}

func (e *RecipeStepError) Error() string        { return e.Field + ": " + e.Err.Error() }
func (e *RecipeStepError) Unwrap() error        { return e.Err }
func (e *RecipeStepError) Is(target error) bool { return target == ErrWorkloadBoot }
