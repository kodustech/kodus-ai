package agent

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// dataResetter answers each ResetData with the same outcome.
type dataResetter struct {
	mu    sync.Mutex
	calls int
	res   driver.DataReset
	err   error
}

func (r *dataResetter) ResetData(context.Context, driver.MachineRef) (driver.DataReset, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	return r.res, r.err
}

const dataOnlyRecipe = "version: 1\nservices: { compose: { public: api } }\ndata: { migrate: npm run migrate, reset: data-only }\n"

// A machine.reset of a data-only claim whose driver restored the data
// services (in either mode) resets and brings nothing up again, runs no
// recipe step, and names the driver's addresses in the egress policy; when
// the driver says recreate, or fails, or the recipe is not data-only, the
// reset is today's: the machine reset, the project up, the recipe run again.
func TestADataOnlyResetKeepsTheAppUnlessTheDriverRecreates(t *testing.T) {
	for _, tc := range []struct {
		name        string
		recipe      string
		res         driver.DataReset
		err         error
		asked       int
		driverReset int
		recipeRuns  int
		sources     []string
	}{
		{name: "data mode", recipe: dataOnlyRecipe, res: driver.DataReset{Mode: driver.ResetModeData, Sources: []string{"172.30.0.10"}}, asked: 1, driverReset: 0, recipeRuns: 1, sources: []string{"172.30.0.10"}},
		{name: "restart-app mode", recipe: dataOnlyRecipe, res: driver.DataReset{Mode: driver.ResetModeRestartApp, Sources: []string{"172.30.0.10"}}, asked: 1, driverReset: 0, recipeRuns: 1, sources: []string{"172.30.0.10"}},
		{name: "the driver says recreate", recipe: dataOnlyRecipe, res: driver.DataReset{Mode: driver.ResetModeRecreate, Why: "restore failed"}, asked: 1, driverReset: 1, recipeRuns: 2, sources: []string{"172.30.0.11"}},
		{name: "the driver fails", recipe: dataOnlyRecipe, err: errors.New("not owned"), asked: 1, driverReset: 1, recipeRuns: 2, sources: []string{"172.30.0.11"}},
		{name: "a recipe that is not data-only never asks", recipe: migrateRecipe, asked: 0, driverReset: 1, recipeRuns: 2, sources: []string{"172.30.0.11"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rc := &recipeComposer{composer: composer{ips: [][]string{{"172.30.0.10"}, {"172.30.0.11"}}}}
			dr := &dataResetter{res: tc.res, err: tc.err}
			h := newHarness(t, func(c *Config) { c.Parts.Composer, c.Parts.Recipes, c.Parts.DataResetter = rc, rc, dr })
			rc.egress = h.egress
			b := h.acquireBody()
			withRecipe(b, tc.recipe)
			if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
				t.Fatal(err)
			}
			h.conn.next(t, isReady)
			if r := h.resetStep("step-1"); r.VMHealth != protocol.VMHealthOk || r.Exec != nil {
				t.Fatalf("reset %+v", r)
			}
			rc.mu.Lock()
			runs := len(rc.runs)
			rc.mu.Unlock()
			if dr.calls != tc.asked || h.driverResets() != tc.driverReset || runs != tc.recipeRuns {
				t.Fatalf("asked %d, driver resets %d, recipe runs %d; want %d, %d, %d", dr.calls, h.driverResets(), runs, tc.asked, tc.driverReset, tc.recipeRuns)
			}
			if got := h.egress.lastSources(); !slices.Equal(got, tc.sources) {
				t.Fatalf("the policy names %v, want %v", got, tc.sources)
			}
		})
	}
}

// A data-only recipe with no boot steps of its own still runs the driver's
// steps once, since the driver keeps the first boot's data there.
func TestADataOnlyRecipeWithNoStepsStillRunsTheDriversSteps(t *testing.T) {
	rc := &recipeComposer{composer: composer{ips: [][]string{{"172.30.0.10"}}}}
	h := newHarness(t, func(c *Config) { c.Parts.Composer, c.Parts.Recipes, c.Parts.DataResetter = rc, rc, &dataResetter{} })
	rc.egress = h.egress
	b := h.acquireBody()
	withRecipe(b, "version: 1\nservices: { compose: { public: api } }\ndata: { reset: data-only }\n")
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if len(rc.runs) != 1 {
		t.Fatalf("the driver's steps ran %d times", len(rc.runs))
	}
}
