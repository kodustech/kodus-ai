package agent

import (
	"context"
	"errors"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// recipeSteps is true when the claim's driver runs the recipe's boot steps
// and the recipe it booted has some.
func (a *Agent) recipeSteps(c *claims.Claim) bool {
	if a.cfg.Parts.Recipes == nil {
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
func (a *Agent) runRecipe(ctx context.Context, c *claims.Claim, workload driver.MachineRef, output func(line string)) error {
	_, dir := c.Compose()
	return recipeBlockerOf(a.cfg.Parts.Recipes.RunRecipe(ctx, workload, dir, output))
}

// recipeBlockerOf is a recipe run's error as the claim's blocker.
func recipeBlockerOf(err error) error {
	var step *driver.RecipeStepError
	switch {
	case err == nil:
		return nil
	case errors.Is(err, driver.ErrOutOfMemory):
		return blockerErr(protocol.BlockerKindResources, "out_of_memory", err)
	case errors.Is(err, driver.ErrDiskCapacity):
		return blockerErr(protocol.BlockerKindResources, "disk_capacity", err)
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
// (Config.Parts.Composer) from the checkout's recipe and compose files, and keeps
// the containers' addresses as the claim's egress Sources. Output takes the
// boot's lines (claim.progress).
func (a *Agent) bootCompose(ctx context.Context, c *claims.Claim, workload driver.MachineRef, repo string, output func(line string)) error {
	rec, err := recipe.Load(repo)
	if err != nil {
		return blockerErr(protocol.BlockerKindRecipeOutdated, "recipe_load", err)
	}
	proj, err := a.loadClaimCompose(c, repo, rec)
	if err != nil {
		return err
	}
	// The org's secrets as placeholders (org_secrets.go), after the recipe's
	// env: the name an admin bound to a secret carries the secret's.
	if err := proj.AddEnvironment(secretEnv(c)); err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "compose_load", err)
	}
	// The Run's drawn identifiers (S-36): every service's env, after the
	// recipe's so no checkout can pin them, and the hostname of a service
	// that names none.
	idEnv, idHost := claimIdentity(c.Acquire)
	if err := proj.AddEnvironment(idEnv); err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "compose_load", err)
	}
	if err := proj.DefaultHostname(idHost); err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "compose_load", err)
	}
	// The Run's decoys (ADR-043): the config slot in every service's env,
	// after the recipe's so no recipe can hide it; the driver plants the
	// rest (the credentials file) at Up.
	canaries := claimCanaries(c.Acquire)
	if err := proj.AddEnvironment(driver.CanaryEnvOf(canaries)); err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "compose_load", err)
	}
	// A Run's Node services write V8 coverage (exercised.go): their env
	// here, the files mounted by the driver at Up.
	if err := a.instrumentCoverage(c, proj); err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "compose_load", err)
	}
	file, err := proj.Marshal()
	if err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "compose_load", err)
	}
	c.SetCompose(file, repo)
	sources, err := a.cfg.Parts.Composer.Up(ctx, a.upRequest(c, workload, file, repo, canaries, output))
	if err != nil {
		return upBlocker(err)
	}
	c.SetSources(sources)
	a.coveredAfterUp(c, workload)
	c.Log.Info("compose.up", "containers", len(sources))
	return nil
}

// upRequest is what a compose Up of the claim asks the driver: whether its
// machines trust the cell CA, the Run's canaries, the workspace root, a
// Run's coverage files (exercised.go), and
// the org secrets as placeholders for its image builds (G6): the services
// get them in their environment (bootCompose), a build those it asked for as
// BuildKit secrets.
func (a *Agent) upRequest(c *claims.Claim, workload driver.MachineRef, file []byte, dir string, canaries []driver.Canary, output func(line string)) driver.UpRequest {
	return driver.UpRequest{
		Ref: workload, Compose: file, ProjectDir: dir, WorkspaceRoot: a.workspaceRoot(c),
		CellTrust: a.cellTrustFor(c, a.cfg.CellTrust), Canaries: canaries, BuildSecrets: secretEnv(c), Coverage: a.coverageOf(c), Output: output,
		SharedImages: sharedImagesOf(c.Acquire),
	}
}

// sharedImagesOf is a claim's sharedImages for its builds: none for a setup,
// which builds what the environment keeps and never takes another cell's image.
func sharedImagesOf(acq protocol.ClaimAcquireBody) []driver.SharedImage {
	if acq.Consumer == protocol.ConsumerSetup || len(acq.SharedImages) == 0 {
		return nil
	}
	out := make([]driver.SharedImage, 0, len(acq.SharedImages))
	for _, s := range acq.SharedImages {
		out = append(out, driver.SharedImage{Fingerprint: s.Fingerprint, Digest: s.Digest})
	}
	return out
}

// upBlocker names a failed Up. What the driver can tell apart comes first: a
// memory limit, the recipe's seed, a compose file the sandbox refuses, an
// image past the cell's bound, and the platform's own failures (a builder
// that died outside the build's steps, an image the cell could not take). Only
// what is left is the project's compose_up, whose logs say why.
func upBlocker(err error) error {
	// A driver may run the recipe's seed inside Up, before the app starts
	// (docker-gvisor's golden data): its failure is the seed's.
	var step *driver.RecipeStepError
	var refused *sandbox.RefusedError
	switch {
	case errors.Is(err, driver.ErrOutOfMemory):
		return blockerErr(protocol.BlockerKindResources, "out_of_memory", err)
	case errors.Is(err, driver.ErrDiskCapacity):
		return blockerErr(protocol.BlockerKindResources, "disk_capacity", err)
	case errors.As(err, &step):
		return blockerErr(protocol.BlockerKindSeedData, "recipe_"+step.Step, err)
	case errors.As(err, &refused):
		return blockerErr(protocol.BlockerKindToolchain, "compose_refused", err)
	case errors.Is(err, driver.ErrImageTooLarge):
		return blockerErr(protocol.BlockerKindResources, "image_too_large", err)
	case errors.Is(err, driver.ErrBuilderFailed):
		return blockerErr(protocol.BlockerKindPlatform, "builder_failed", err)
	case errors.Is(err, driver.ErrImageLoad):
		return blockerErr(protocol.BlockerKindPlatform, "image_load", err)
	}
	return blockerErr(protocol.BlockerKindToolchain, "compose_up", err)
}
