package agent

import (
	"errors"
	"fmt"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// loadClaimCompose validates declarative changes before transports can build,
// then produces the same project used by the gVisor execution path.
func (a *Agent) loadClaimCompose(c *claims.Claim, repo string, rec *recipe.Recipe) (*compose.Project, error) {
	if err := a.checkNeeds(c, rec); err != nil {
		return nil, err
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

// checkNeeds refuses a recipe whose services.needs the claim cannot boot:
// what would run without those repositories is not the app. A cell that
// lays workspaces out boots them when the hub sent every one (claim.acquire
// repos, by alias and repository); the first it lacks is named. Any other
// cell refuses services.needs as before.
func (a *Agent) checkNeeds(c *claims.Claim, rec *recipe.Recipe) error {
	if rec == nil || len(rec.Services.Needs) == 0 {
		return nil
	}
	ws, err := a.claimWorkspace(c)
	if err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "workspace_layout", err)
	}
	if !a.laysOutWorkspaces() {
		return blockerErr(protocol.BlockerKindOtherRepo, "recipe_needs", errors.New("services.needs (other repositories booted beside this one) is not supported by this cell yet"))
	}
	primary := recipe.AliasOf(c.Acquire.Repo.FullName)
	if ws != nil {
		primary = ws.Primary
	}
	if err := rec.NeedsConflict(c.Acquire.Repo.FullName, primary); err != nil {
		return blockerErr(protocol.BlockerKindRecipeOutdated, "recipe_needs_conflict", err)
	}
	for _, n := range rec.Services.Needs {
		if ws == nil || !ws.Has(n.Alias, n.Repo) {
			return blockerErr(protocol.BlockerKindOtherRepo, "recipe_needs", inRepository(n.Alias, fmt.Errorf("services.needs names %s, which this claim did not bring; add it to the environment's repositories", strings.TrimSpace(n.Repo))))
		}
	}
	return nil
}
