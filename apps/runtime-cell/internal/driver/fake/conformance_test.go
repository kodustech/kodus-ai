package fake_test

import (
	"fmt"
	"testing"
	"time"

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
			UndatedMachine: func(_ *testing.T, ceiling string) string {
				tags := map[string]string{driver.TagCell: "cell-1", driver.TagClaim: "undated", driver.TagRole: string(driver.RoleWorkload)}
				if ceiling != "" {
					tags[driver.TagHardExpires] = ceiling
				}
				return d.PlantTags(tags).MachineID
			},
		}
	})
}

// The fake's sandboxes honor their requests as a real driver's do: the
// trust it was asked, or a refusal when it is set to give none.
func TestTheFakeHonorsItsRequests(t *testing.T) {
	for _, none := range []bool{false, true} {
		t.Run(fmt.Sprintf("no sandbox trust %v", none), func(t *testing.T) { runFakeRequests(t, none) })
	}
}

func runFakeRequests(t *testing.T, none bool) {
	drivertest.RunRequests(t, func(t *testing.T) drivertest.RequestSubject {
		d := fake.NewForCell("cell-1")
		d.NoSandboxCellTrust = none
		n := 0
		return drivertest.RequestSubject{
			Capabilities: d.Capabilities(),
			Sandboxer:    fake.Sandboxes{Driver: d, Root: t.TempDir()},
			SandboxSpec: func(t *testing.T) driver.MachineSpec {
				n++
				id := fmt.Sprintf("claim-%d", n)
				spec := drivertest.BaseSpec("cell-1", id, driver.ClaimNetwork{WorkloadGroupID: "kodus-" + id})
				spec.ExpiresAt, spec.HardExpiresAt = time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
				return spec
			},
			SandboxTrusted: func(t *testing.T, ref driver.MachineRef) bool {
				for _, m := range d.Machines() {
					if m.Ref.MachineID == ref.MachineID {
						return m.CellTrust
					}
				}
				t.Fatalf("no machine %s", ref.MachineID)
				return false
			},
		}
	})
}
