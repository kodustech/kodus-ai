package fake_test

import (
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
)

// The fake stands in for every real driver in the agent's tests, so it
// keeps the same contract.
func TestConformance(t *testing.T) {
	drivertest.Run(t, func(t *testing.T) drivertest.Subject {
		d := fake.NewForCell("cell-1")
		return drivertest.Subject{
			Driver: d, CellID: "cell-1", Lifecycle: true,
			ForeignMachine: func(*testing.T) driver.MachineRef { return d.Plant("cell-2", "claim-9") },
			ForeignNetwork: func(*testing.T) driver.ClaimNetwork { return d.PlantNetwork("cell-2", "claim-9") },
		}
	})
}
