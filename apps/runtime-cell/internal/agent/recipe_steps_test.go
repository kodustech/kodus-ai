package agent

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// recipeComposer is a ComposeBooter that runs the recipe's steps: it records
// the egress sources in place at each RunRecipe, and fails with fail.
type recipeComposer struct {
	composer
	egress *recEgress
	mu     sync.Mutex
	runs   [][]string // the policy's sources at each RunRecipe
	fail   error
}

func (r *recipeComposer) RunRecipe(_ context.Context, _ driver.MachineRef, _ string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.runs = append(r.runs, r.egress.lastSources())
	return r.fail
}

func withRecipe(b *protocol.ClaimAcquireBody, text string) {
	content, _ := json.Marshal(text)
	b.Recipe = &protocol.ClaimAcquireBodyRecipe{Path: ".kodus/workspace.yaml", Content: content}
}

const migrateRecipe = "version: 1\nservices: { compose: { public: api } }\ndata: { migrate: npm run migrate }\n"

// The recipe's steps run once the policy names the project's containers (a
// setup may fetch), before claim.ready, and again after every reset's Up.
func TestRecipeStepsRunAfterTheEgressAndAgainAfterAReset(t *testing.T) {
	rc := &recipeComposer{composer: composer{ips: [][]string{{"172.30.0.2"}, {"172.30.0.7"}}}}
	h := newHarness(t, func(c *Config) { c.Composer, c.Recipes = rc, rc })
	rc.egress = h.egress
	b := h.acquireBody()
	withRecipe(b, migrateRecipe)
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	reset := &protocol.MachineResetBody{StepID: step1, Snapshot: protocol.Snapshot{Kind: protocol.SnapshotKindComposeVolumes, Ref: "v"}}
	if err := h.handle("claim-1", protocol.MessageTypeMachineReset, reset); err != nil {
		t.Fatal(err)
	}
	if r := h.conn.next(t, isResult(step1)).(*protocol.StepResultBody); r.VMHealth != protocol.VMHealthOk {
		t.Fatalf("reset %+v", r)
	}
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if len(rc.runs) != 2 || !slices.Contains(rc.runs[0], "172.30.0.2") || !slices.Contains(rc.runs[1], "172.30.0.7") {
		t.Fatalf("recipe runs saw the policies %v, want the boot's then the reset's containers", rc.runs)
	}
}

// A recipe with no steps does not call the driver for them.
func TestARecipeWithoutStepsRunsNone(t *testing.T) {
	rc := &recipeComposer{composer: composer{ips: [][]string{{"172.30.0.2"}}}}
	h := newHarness(t, func(c *Config) { c.Composer, c.Recipes = rc, rc })
	rc.egress = h.egress
	b := h.acquireBody()
	withRecipe(b, "version: 1\nservices: { compose: { public: api } }\n")
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	if len(rc.runs) != 0 {
		t.Fatalf("steps ran %d times", len(rc.runs))
	}
}

// A failed step is the repository's blocker, named after the step.
func TestAFailedRecipeStepIsATypedBlocker(t *testing.T) {
	for _, tc := range []struct {
		err       error
		kind      protocol.BlockerKind
		signature string
	}{
		{&driver.RecipeStepError{Step: "setup", Field: "setup[0]", Err: errors.New(`"make" exited 2`)}, protocol.BlockerKindToolchain, "recipe_setup"},
		{&driver.RecipeStepError{Step: "migrate", Field: "data.migrate", Err: errors.New(`"npm run migrate" exited 1`)}, protocol.BlockerKindSeedData, "recipe_migrate"},
		{&driver.RecipeStepError{Step: "seed", Field: "data.seed", Err: errors.New("psql: relation does not exist")}, protocol.BlockerKindSeedData, "recipe_seed"},
	} {
		rc := &recipeComposer{composer: composer{ips: [][]string{{"172.30.0.2"}}}, fail: tc.err}
		h := newHarness(t, func(c *Config) { c.Composer, c.Recipes = rc, rc })
		rc.egress = h.egress
		b := h.acquireBody()
		withRecipe(b, migrateRecipe)
		if err := h.handle("claim-"+strings.ReplaceAll(tc.signature, "_", "-"), protocol.MessageTypeClaimAcquire, b); err != nil {
			t.Fatal(err)
		}
		f := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
		if f.Kind != tc.kind || f.Signature != tc.signature || !strings.Contains(f.Reason, tc.err.Error()) {
			t.Fatalf("%s: %+v", tc.signature, f)
		}
	}
}

// services.needs boots other repositories beside this one, which a cell
// does not: the claim fails on it, typed, and the project never comes up.
func TestARecipeThatNeedsOtherReposIsRefusedBeforeUp(t *testing.T) {
	rc := &recipeComposer{composer: composer{ips: [][]string{{"172.30.0.2"}}}}
	h := newHarness(t, func(c *Config) { c.Composer, c.Recipes = rc, rc })
	rc.egress = h.egress
	b := h.acquireBody()
	withRecipe(b, "version: 1\nservices:\n  compose: { public: api }\n  needs: [{ repo: o/billing }]\n")
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	f := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
	if f.Kind != protocol.BlockerKindOtherRepo || f.Signature != "recipe_needs" || !strings.Contains(f.Reason, "services.needs") {
		t.Fatalf("claim.failed %+v", f)
	}
	rc.composer.mu.Lock()
	defer rc.composer.mu.Unlock()
	if len(rc.files) != 0 {
		t.Fatal("the project came up")
	}
}
