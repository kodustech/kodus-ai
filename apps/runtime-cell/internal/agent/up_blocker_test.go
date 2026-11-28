package agent

import (
	"errors"
	"fmt"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Every Up error that was not out of memory or the seed's used to be the
// repository's toolchain/compose_up, a builder that died while BuildKit
// still had steps running included. The driver's own failures are the
// platform's now, and a refused compose file has its own signature.
func TestUpBlockerTellsThePlatformFromTheProject(t *testing.T) {
	for _, tc := range []struct {
		err       error
		kind      protocol.BlockerKind
		signature string
	}{
		{fmt.Errorf("dockergvisor: build api: %w: the builder ended with no step failed: exit status 2", driver.ErrBuilderFailed), protocol.BlockerKindPlatform, "builder_failed"},
		{fmt.Errorf("dockergvisor: build api: %w: image tarball: manifest.json: names \"postgres:16\"", driver.ErrImageLoad), protocol.BlockerKindPlatform, "image_load"},
		{fmt.Errorf("dockergvisor: build api: %w", driver.ErrImageTooLarge), protocol.BlockerKindResources, "image_too_large"},
		{&sandbox.RefusedError{Violations: []sandbox.Violation{{Path: "services.a.privileged", Reason: "privileged containers reach the host"}}}, protocol.BlockerKindToolchain, "compose_refused"},
		{fmt.Errorf("%w: build api passed 4g", driver.ErrOutOfMemory), protocol.BlockerKindResources, "out_of_memory"},
		{&driver.RecipeStepError{Step: "seed", Err: errors.New("exit 1")}, protocol.BlockerKindSeedData, "recipe_seed"},
		{errors.New("dockergvisor: build api: step [deps 3/5] RUN npm ci failed:\n  npm ERR! code ENOTFOUND"), protocol.BlockerKindToolchain, "compose_up"},
	} {
		var be *blockerError
		if !errors.As(upBlocker(tc.err), &be) || be.kind != tc.kind || be.signature != tc.signature {
			t.Errorf("%v: %+v, want %s/%s", tc.err, be, tc.kind, tc.signature)
		}
	}
}
