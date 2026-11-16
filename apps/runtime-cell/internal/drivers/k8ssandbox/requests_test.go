package k8ssandbox

import (
	"fmt"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

// The k8s-sandbox driver honors its sandbox requests, as the API server
// shows the pods: no trust files reach a pod, so one asked them is refused.
func TestTheK8sSandboxDriverHonorsItsRequests(t *testing.T) {
	drivertest.RunRequests(t, func(t *testing.T) drivertest.RequestSubject {
		api := newAPIServer()
		d := newDriver(t, api)
		n := 0
		return drivertest.RequestSubject{
			Capabilities: d.Capabilities(),
			Sandboxer:    d,
			SandboxSpec: func(*testing.T) driver.MachineSpec {
				n++
				return sandboxSpec(fmt.Sprintf("claim-%d", n))
			},
			SandboxTrusted: func(_ *testing.T, ref driver.MachineRef) bool {
				ns, name, _ := strings.Cut(ref.MachineID, "/")
				return strings.Contains(fmt.Sprint(api.pod(ns, name)), machinetrust.BundleTarget)
			},
		}
	})
}
