package agent

import (
	"context"
	"errors"
	"fmt"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerauth"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

func requiresObserverSQL(rec *recipe.Recipe) bool {
	if rec == nil {
		return false
	}
	for _, target := range rec.Services.Expose {
		if target.ReadonlyUserFromSeed {
			return true
		}
	}
	return false
}

// A provider result is not authority to add an exposed database. Every account
// must match exactly one read-only PostgreSQL target and its explicit seed.
func matchesObserverSQL(rec *recipe.Recipe, credentials []observerauth.Credential) bool {
	if rec == nil {
		return false
	}
	type target struct {
		service string
		port    int
	}
	expected := make(map[target]bool)
	for _, exposed := range rec.Services.Expose {
		if !exposed.ReadonlyUserFromSeed {
			continue
		}
		key := target{exposed.Service, exposed.Port}
		if exposed.Kind != "postgres" || rec.Data.Seed.Service != exposed.Service || rec.Data.Seed.Database == "" || expected[key] {
			return false
		}
		expected[key] = true
	}
	if len(expected) == 0 || len(credentials) != len(expected) {
		return false
	}
	for _, credential := range credentials {
		key := target{credential.Service, credential.Port}
		if credential.Validate() != nil || credential.Database != rec.Data.Seed.Database || !expected[key] {
			return false
		}
		delete(expected, key)
	}
	return len(expected) == 0
}

func observerTargets(c *claims.Claim) []observer.Target {
	m := c.Machines()
	out := make([]observer.Target, 0, len(c.Acquire.Expose))
	for _, e := range c.Acquire.Expose {
		out = append(out, observer.Target{Service: e.Service, Port: int(e.Port), Kind: string(e.Kind), Address: fmt.Sprintf("%s:%d", m.Workload.PrivateAddress, e.Port)})
	}
	return out
}

// provisionObserverSQL completes before readiness and after every seed/reset.
// The provider suppresses guest output; plaintext credentials never enter frames.
func (a *Agent) provisionObserverSQL(ctx context.Context, c *claims.Claim, repo string) (err error) {
	rec, loadErr := recipe.Load(repo)
	if loadErr != nil {
		return blockerErr(protocol.BlockerKindRecipeOutdated, "recipe_load", loadErr)
	}
	if !requiresObserverSQL(rec) {
		return nil
	}
	if a.cfg.SQLObservers == nil {
		return blockerErr(protocol.BlockerKindPlatform, "sql_observer_unsupported", errors.New("the cell cannot provision the declared SQL observer"))
	}
	start := a.clock.Now()
	outcome := "failed"
	a.progress(c, "sql_observer", protocol.ClaimProgressBodyStateStarted, nil, nil)
	defer func() {
		elapsed := max(int64(0), a.clock.Now().Sub(start).Milliseconds())
		a.m.sqlObservers.Inc(outcome)
		a.m.sqlObserverDuration.Add(float64(elapsed))
		c.Log.Info("observer.sql_provision", "outcome", outcome, "durationMs", elapsed)
		a.progress(c, "sql_observer", protocol.ClaimProgressBodyStateDone, &elapsed, nil)
	}()
	credentials, provisionErr := a.cfg.SQLObservers.ProvisionObserverSQL(ctx, c.Machines().Workload, repo)
	if provisionErr != nil {
		var typed *driver.ObserverSQLError
		if errors.As(provisionErr, &typed) {
			signature := "sql_provision_failed"
			switch typed.Reason {
			case "sql_seed_target_unsupported", "sql_schema_unsafe", "sql_machine_unavailable", "sql_credential_failed":
				signature = typed.Reason
			}
			outcome = "refused"
			return blockerErr(protocol.BlockerKindPlatform, signature, typed)
		}
		if ctx.Err() != nil {
			outcome = "cancelled"
			return ctx.Err()
		}
		return blockerErr(protocol.BlockerKindPlatform, "sql_provision_failed", errors.New("the SQL observer account could not be provisioned"))
	}
	if !matchesObserverSQL(rec, credentials) {
		outcome = "refused"
		return blockerErr(protocol.BlockerKindPlatform, "sql_provision_failed", errors.New("the SQL provisioner did not return exactly the declared read-only seed accounts"))
	}
	c.SetRedactor(a.claimRedactor(c))
	c.AdvanceObserverGeneration()
	if _, configureErr := a.cfg.Observers(ctx, info(c), observerTargets(c)); configureErr != nil {
		if ctx.Err() != nil {
			outcome = "cancelled"
			return ctx.Err()
		}
		return blockerErr(protocol.BlockerKindPlatform, "sql_observer_configuration", errors.New("the observer could not bind the provisioned SQL target; check its version and control connection"))
	}
	outcome = "ready"
	return nil
}
