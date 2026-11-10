package agent

import (
	"context"
	"errors"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// recipeSteps is true when the claim's driver runs the recipe's boot steps
// and the recipe it booted has some.
func (a *Agent) recipeSteps(c *claims.Claim) bool {
	if a.cfg.Recipes == nil {
		return false
	}
	file, dir := c.Compose()
	if file == nil {
		return false
	}
	rec, err := recipe.Load(dir)
	return err == nil && rec != nil && rec.HasBootSteps()
}

// runRecipe runs the recipe's boot steps through the driver; a failed step
// is the repository's blocker, named after it.
func (a *Agent) runRecipe(ctx context.Context, c *claims.Claim, workload driver.MachineRef) error {
	_, dir := c.Compose()
	err := a.cfg.Recipes.RunRecipe(ctx, workload, dir)
	var step *driver.RecipeStepError
	switch {
	case err == nil:
		return nil
	case errors.Is(err, driver.ErrOutOfMemory):
		return blockerErr(protocol.BlockerKindResources, "out_of_memory", err)
	case errors.As(err, &step) && step.Step == "setup":
		return blockerErr(protocol.BlockerKindToolchain, "recipe_setup", err)
	case errors.As(err, &step):
		return blockerErr(protocol.BlockerKindSeedData, "recipe_"+step.Step, err)
	case errors.Is(err, driver.ErrWorkloadRecipe):
		return blockerErr(protocol.BlockerKindRecipeOutdated, "recipe_load", err)
	}
	return blockerErr(protocol.BlockerKindPlatform, "recipe_steps", err)
}

// bootCompose brings the claim's compose project up through the driver
// (Config.Composer) from the checkout's recipe and compose files, and keeps
// the containers' addresses as the claim's egress Sources.
func (a *Agent) bootCompose(ctx context.Context, c *claims.Claim, workload driver.MachineRef, repo string) error {
	rec, err := recipe.Load(repo)
	if err != nil {
		return blockerErr(protocol.BlockerKindRecipeOutdated, "recipe_load", err)
	}
	proj, err := loadClaimCompose(c, repo, rec)
	if err != nil {
		return err
	}
	// The Run's decoys (ADR-043): the config slot in every service's env,
	// after the recipe's so no recipe can hide it; the driver plants the
	// rest (the credentials file) at Up.
	canaries := claimCanaries(c.Acquire)
	if err := proj.AddEnvironment(driver.CanaryEnvOf(canaries)); err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "compose_load", err)
	}
	file, err := proj.Marshal()
	if err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "compose_load", err)
	}
	c.SetCompose(file, repo)
	sources, err := a.cfg.Composer.Up(driver.WithCanaries(ctx, canaries), workload, file, repo)
	if errors.Is(err, driver.ErrOutOfMemory) {
		return blockerErr(protocol.BlockerKindResources, "out_of_memory", err)
	}
	// A driver may run the recipe's seed inside Up, before the app starts
	// (docker-gvisor's golden data): its failure is the seed's.
	var step *driver.RecipeStepError
	if errors.As(err, &step) {
		return blockerErr(protocol.BlockerKindSeedData, "recipe_"+step.Step, err)
	}
	if err != nil {
		return blockerErr(protocol.BlockerKindToolchain, "compose_up", err)
	}
	c.SetSources(sources)
	c.Log.Info("compose.up", "containers", len(sources))
	return nil
}
