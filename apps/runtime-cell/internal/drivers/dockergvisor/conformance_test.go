package dockergvisor

import (
	"context"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

func TestConformance(t *testing.T) {
	drivertest.Run(t, func(t *testing.T) drivertest.Subject {
		docker := newMemDocker()
		d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir()})
		if err != nil {
			t.Fatal(err)
		}
		return drivertest.Subject{
			Driver: d, CellID: "cell-1", Lifecycle: true,
			// Another cell's holder on the same daemon.
			ForeignMachine: func(*testing.T) driver.MachineRef {
				name := "kodus-claim-9-workload"
				docker.plant(dockercli.Container{ID: "cforeign", Name: name, Labels: map[string]string{
					dockercli.LabelFromTag(driver.TagCell): "cell-2", dockercli.LabelFromTag(driver.TagClaim): "claim-9", labelMachine: name}})
				return driver.MachineRef{MachineID: name, DriverRef: "cforeign",
					Tags: map[string]string{driver.TagCell: "cell-2", driver.TagClaim: "claim-9"}}
			},
			ForeignNetwork: func(*testing.T) driver.ClaimNetwork {
				name := networkName("claim-9")
				_ = docker.NetworkCreate(context.Background(), dockercli.NetworkSpec{Name: name, Internal: true, Labels: map[string]string{dockercli.LabelFromTag(driver.TagCell): "cell-2"}})
				return driver.ClaimNetwork{WorkloadGroupID: name, ObserverGroupID: name}
			},
		}
	})
}
