package k8ssandbox

import (
	"context"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
)

// isolatedCluster is a cluster that has what New requires: the RuntimeClass,
// the admission policy and a CNI that enforces NetworkPolicy.
func isolatedCluster() *memKube {
	return newMemKube(
		Object{"kind": "RuntimeClass", "metadata": map[string]any{"name": "gvisor"}},
		Object{"kind": "ValidatingAdmissionPolicy", "metadata": map[string]any{"name": "kodus-runtime-cell-sandbox"}},
		Object{"kind": "CustomResourceDefinition", "metadata": map[string]any{"name": "ciliumnetworkpolicies.cilium.io"}},
	)
}

func TestConformance(t *testing.T) {
	drivertest.Run(t, func(t *testing.T) drivertest.Subject {
		k := isolatedCluster()
		c := cfg()
		c.Now = func() time.Time { return drivertest.Now }
		d, err := New(context.Background(), k, c)
		if err != nil {
			t.Fatal(err)
		}
		return drivertest.Subject{
			Driver: d, CellID: c.CellID, Lifecycle: true,
			ForeignMachine: func(t *testing.T) driver.MachineRef {
				ns := namespaceOf("claim-9")
				pod := Object{"kind": "Pod", "metadata": map[string]any{"name": "workload-claim-9", "namespace": ns, "labels": map[string]any{
					label(driver.TagCell): "cell-2", label(driver.TagClaim): "claim-9", label(driver.TagRole): "workload"}}}
				if err := k.Apply(context.Background(), pod); err != nil {
					t.Fatal(err)
				}
				return driver.MachineRef{MachineID: ns + "/workload-claim-9", DriverRef: ns + "/workload-claim-9",
					Tags: map[string]string{driver.TagCell: "cell-2", driver.TagClaim: "claim-9"}}
			},
			ForeignNetwork: func(t *testing.T) driver.ClaimNetwork {
				ns := namespaceOf("claim-9")
				if err := k.Apply(context.Background(), Object{"kind": "Namespace", "metadata": map[string]any{"name": ns,
					"labels": map[string]any{label(driver.TagCell): "cell-2"}}}); err != nil {
					t.Fatal(err)
				}
				return driver.ClaimNetwork{WorkloadGroupID: ns, ObserverGroupID: ns}
			},
		}
	})
}
