package localdocker

import (
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

func TestConformance(t *testing.T) {
	drivertest.Run(t, func(t *testing.T) drivertest.Subject {
		docker := newFake()
		d := newDriver(t, docker, t.TempDir())
		return drivertest.Subject{
			Driver: d, CellID: "cell-1", Lifecycle: true,
			// Another cell's compose project on the same Docker.
			ForeignMachine: func(*testing.T) driver.MachineRef {
				name := machineName("claim-9", driver.RoleWorkload)
				docker.containers = append(docker.containers, Container{Labels: map[string]string{
					dockercli.LabelFromTag(driver.TagCell): "cell-2", labelMachine: name, labelProject: name}})
				return driver.MachineRef{MachineID: name, DriverRef: name,
					Tags: map[string]string{driver.TagCell: "cell-2", driver.TagClaim: "claim-9", driver.TagRole: string(driver.RoleWorkload)}}
			},
		}
	})
}
