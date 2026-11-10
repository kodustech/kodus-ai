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
	Up(ctx context.Context, ref MachineRef, compose []byte, projectDir string) (sources []string, err error)
}

// RecipeRunner is a ComposeBooter that also runs the recipe's own boot steps
// (setup, data.migrate, data.seed: recipe.HasBootSteps) in the project it
// brought up. The agent calls it after every Up, once the claim's egress
// policy names the project's containers (a setup command may fetch), and
// before the claim is ready or the reset's step answers.
type RecipeRunner interface {
	RunRecipe(ctx context.Context, ref MachineRef, projectDir string) error
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
