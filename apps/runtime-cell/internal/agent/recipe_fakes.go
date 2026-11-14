package agent

import (
	"errors"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// loadClaimCompose validates declarative changes before transports can build,
// then produces the same project used by the gVisor execution path.
func loadClaimCompose(c *claims.Claim, repo string, rec *recipe.Recipe) (*compose.Project, error) {
	// Other repositories booted beside this one: a cell does not, and what
	// would run without them is not the app.
	if rec != nil && !rec.Services.Needs.IsZero() {
		return nil, blockerErr(protocol.BlockerKindOtherRepo, "recipe_needs", errors.New("services.needs (other repositories booted beside this one) is not supported by this cell yet"))
	}
	var files []string
	if rec != nil {
		files = rec.Services.Compose.Files
	}
	proj, err := compose.Load(repo, files)
	if errors.Is(err, compose.ErrNoComposeFile) {
		// No compose file: one service that builds the checkout's
		// Dockerfile, named after the claim's first exposed service.
		name := "app"
		if len(c.Acquire.Expose) > 0 {
			name = c.Acquire.Expose[0].Service
		}
		proj, err = compose.SingleService(name), nil
	}
	if err != nil {
		return nil, blockerErr(protocol.BlockerKindRecipeOutdated, "compose_load", err)
	}
	// The file says which services start (the driver passes no --profile),
	// and the recipe's env goes into the containers themselves: the driver
	// runs compose with no interpolation file, so a "${NAME}" never reaches
	// them.
	if rec != nil {
		if err := proj.ActivateProfiles(rec.Services.Compose.Profiles); err != nil {
			return nil, blockerErr(protocol.BlockerKindRecipeOutdated, "compose_load", err)
		}
		if err := proj.AddEnvironment(rec.Services.Compose.Env); err != nil {
			return nil, blockerErr(protocol.BlockerKindRecipeOutdated, "compose_load", err)
		}
	}
	if rec != nil {
		if err := proj.AddRecipeFakes(rec); err != nil {
			return nil, blockerErr(protocol.BlockerKindRecipeOutdated, "recipe_fakes", err)
		}
	}
	return proj, nil
}
