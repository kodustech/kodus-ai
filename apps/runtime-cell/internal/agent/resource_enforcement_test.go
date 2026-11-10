package agent

import (
	"context"
	"fmt"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// A missing host resource boundary used to be relabelled compose_up or
// recipe_setup: the product could blame the PR for the cell's failed guard.
type enforcementFailureDriver struct {
	driver.MachineDriver
	role    driver.Role
	network bool
}

func (d enforcementFailureDriver) PrepareClaim(ctx context.Context, s driver.ClaimNetworkSpec) (driver.ClaimNetwork, error) {
	if d.network {
		return driver.ClaimNetwork{}, fmt.Errorf("parent unavailable: %w", driver.ErrResourceEnforcement)
	}
	return d.MachineDriver.PrepareClaim(ctx, s)
}
func (d enforcementFailureDriver) Create(ctx context.Context, s driver.MachineSpec) (driver.MachineRef, error) {
	if s.Role == d.role {
		return driver.MachineRef{}, fmt.Errorf("parent unavailable: %w", driver.ErrResourceEnforcement)
	}
	return d.MachineDriver.Create(ctx, s)
}

type enforcementFailureComposer struct{ up, recipe error }

func (c enforcementFailureComposer) Up(context.Context, driver.MachineRef, []byte, string) ([]string, error) {
	return []string{"172.30.0.2"}, c.up
}
func (c enforcementFailureComposer) RunRecipe(context.Context, driver.MachineRef, string) error {
	return c.recipe
}

func TestResourceEnforcementFailureRemainsAPlatformBlockerOnEveryBootPath(t *testing.T) {
	for _, kind := range []string{"network", "workload", "observer", "upload", "compose", "recipe-setup", "recipe-migrate"} {
		t.Run(kind, func(t *testing.T) {
			fault := fmt.Errorf("delegated controller unavailable: %w", driver.ErrResourceEnforcement)
			h := newHarness(t, func(c *Config) {
				switch kind {
				case "network":
					c.Driver = enforcementFailureDriver{MachineDriver: c.Driver, network: true}
				case "workload":
					c.Driver = enforcementFailureDriver{MachineDriver: c.Driver, role: driver.RoleWorkload}
				case "observer":
					c.Driver = enforcementFailureDriver{MachineDriver: c.Driver, role: driver.RoleObserver}
				case "upload":
					c.Transport = stubTransport{upload: driver.WorkloadBootFailed(fault)}
				case "compose":
					c.Composer = enforcementFailureComposer{up: driver.WorkloadBootFailed(fault)}
				case "recipe-setup":
					c.Composer = enforcementFailureComposer{recipe: &driver.RecipeStepError{Step: "setup", Field: "setup[0]", Err: fault}}
				case "recipe-migrate":
					c.Composer = enforcementFailureComposer{recipe: &driver.RecipeStepError{Step: "migrate", Field: "data.migrate", Err: fault}}
				}
			})
			b := h.acquireBody()
			// Exercise the PR side, where a mistaken toolchain label can become
			// a finding. This failure must instead preserve infrastructure scope.
			b.Side = protocol.SidePr
			if kind == "recipe-setup" || kind == "recipe-migrate" {
				withRecipe(b, migrateRecipe)
			}
			if err := h.handle("claim-resource-guard", protocol.MessageTypeClaimAcquire, b); err != nil {
				t.Fatal(err)
			}
			failed := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
			if failed.Kind != protocol.BlockerKindPlatform || failed.Signature != "resource_enforcement_unavailable" {
				t.Fatalf("%s host enforcement failure blamed on workload: %+v", kind, failed)
			}
			if len(h.drv.Machines()) != 0 {
				t.Fatalf("%s left claim machines after failure: %v", kind, h.drv.Machines())
			}
		})
	}
}
