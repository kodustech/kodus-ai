package localdocker

import (
	"errors"
	"fmt"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// What local-docker does with a recipe the recipe package accepted.

// refuseWhatLocalDockerCannotRun rejects execution contracts this development
// driver cannot fulfill, before a compose plan can start any workload.
func refuseWhatLocalDockerCannotRun(rec *recipe.Recipe) error {
	if rec != nil {
		for _, exposed := range rec.Services.Expose {
			if exposed.ReadonlyUserFromSeed {
				return driver.WorkloadRecipeRefused(errors.New("localdocker: readonly_user_from_seed requires an isolated cell with SQL observer account provisioning; use HTTP probes on local-docker"))
			}
		}
		if err := rec.RequirePinnedFakes(); err != nil {
			return driver.WorkloadRecipeRefused(err)
		}
		for _, fake := range rec.FakeServices() {
			for _, exposed := range rec.Services.Expose {
				if exposed.Service == fake.Service {
					return driver.WorkloadRecipeRefused(errors.New("localdocker: declared fakes cannot publish host ports; probe the app or use an isolated cell's private observer target"))
				}
			}
		}
	}
	if rec != nil && !rec.Services.Needs.IsZero() {
		return errors.New("localdocker: services.needs (other repos) is not supported by local-docker")
	}
	return nil
}

// recipeKeysIgnored are the keys local-docker reads but does not act on;
// the boot warns about them so nobody believes they took effect.
func recipeKeysIgnored(rec *recipe.Recipe) []string {
	var out []string
	for _, f := range []struct {
		name string
		set  bool
	}{

		{"limits", !rec.Limits.IsZero()},
		{"size", !rec.Size.IsZero()},
		{"flags", !rec.Flags.IsZero()},
		{"llm", !rec.LLM.IsZero()},
		{"egress", !rec.Egress.IsZero()},
		{"ui", !rec.UI.IsZero()},
		{"expose", !rec.Expose.IsZero()},
		{"services.compose.public_port", rec.Services.Compose.PublicPort != 0},
	} {
		if f.set {
			out = append(out, f.name)
		}
	}
	return out
}

// Generated fakes join Compose's default network. This development driver
// preserves application networks, so it refuses an unreachable fake instead of
// broadening those networks or reporting a ready but disconnected environment.
func checkLocalFakeConnectivity(rec *recipe.Recipe, proj *compose.Project) error {
	if rec == nil || len(rec.FakeServices()) == 0 {
		return nil
	}
	for _, name := range proj.ServiceNames() {
		svc := proj.Service(name)
		_, mode := svc["network_mode"]
		if mode || !usesDefaultNetwork(svc["networks"]) {
			return driver.WorkloadRecipeRefused(errors.New("localdocker: declared fakes require application services on the implicit or explicit default network without network_mode; join that network or use an isolated cell"))
		}
	}
	return nil
}

func usesDefaultNetwork(raw any) bool {
	switch networks := raw.(type) {
	case nil:
		return true
	case []any:
		for _, name := range networks {
			if name == "default" {
				return true
			}
		}
	case map[string]any:
		_, present := networks["default"]
		return present
	}
	return false
}

// portsToPublish is the recipe's expose; every port the claim asks for
// must be in it. Without a recipe, what the claim asks for.
func portsToPublish(rec *recipe.Recipe, claimExpose []driver.ExposePort) ([]driver.ExposePort, error) {
	if rec == nil {
		return claimExpose, nil
	}
	out := make([]driver.ExposePort, len(rec.Services.Expose))
	inRecipe := make(map[string]bool, len(out))
	for i, e := range rec.Services.Expose {
		out[i] = driver.ExposePort{Service: e.Service, Port: e.Port, Kind: e.Kind}
		inRecipe[exposeKey(e.Service, e.Port)] = true
	}
	for _, e := range claimExpose {
		if !inRecipe[exposeKey(e.Service, e.Port)] {
			return nil, fmt.Errorf("localdocker: the claim exposes %s/%d and %s does not", e.Service, e.Port, recipe.Path)
		}
	}
	return out, nil
}

// checkRecipeNamesServicesOf: the services the recipe seeds and checks
// health on must be in the compose project.
func checkRecipeNamesServicesOf(rec *recipe.Recipe, proj *compose.Project) error {
	if rec == nil {
		return nil
	}
	if s := rec.Data.Seed.Service; s != "" && !proj.HasService(s) {
		return fmt.Errorf("localdocker: data.seed.service %q is not in the compose project", s)
	}
	if s := rec.Services.Compose.Primary(); s != "" && !proj.HasService(s) {
		return fmt.Errorf("localdocker: services.compose.public %q is not in the compose project", s)
	}
	return nil
}
