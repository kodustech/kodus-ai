package awsec2

import (
	"fmt"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
)

func TestConformance(t *testing.T) {
	drivertest.Run(t, func(t *testing.T) drivertest.Subject {
		m := &mockEC2{}
		n := 0
		d := newDriver(t, m)
		return drivertest.Subject{
			Driver: d, CellID: "cell-1", Lifecycle: true,
			Spec: func(claimID string, n driver.ClaimNetwork) driver.MachineSpec {
				s := drivertest.BaseSpec("cell-1", claimID, n)
				s.KMSKeyRef = keys["org-a"]
				return s
			},
			// Another cell's instance in the same account.
			ForeignMachine: func(*testing.T) driver.MachineRef {
				m.plant(types.Instance{
					InstanceId: aws.String("i-foreign"), State: &types.InstanceState{Name: types.InstanceStateNameRunning},
					Tags: []types.Tag{{Key: aws.String(driver.TagCell), Value: aws.String("cell-2")}, {Key: aws.String(driver.TagClaim), Value: aws.String("claim-9")}},
				})
				return driver.MachineRef{
					MachineID: "i-foreign", DriverRef: "i-foreign",
					Tags: map[string]string{driver.TagCell: "cell-2", driver.TagClaim: "claim-9"},
				}
			},
			ForeignNetwork: func(*testing.T) driver.ClaimNetwork {
				m.group("sg-foreign", "cell-2", "claim-9")
				return driver.ClaimNetwork{WorkloadGroupID: "sg-foreign", ObserverGroupID: "sg-foreign"}
			},
			// An instance of this cell with no or a bad ceiling: the
			// reaper's to end (the driver has no sweep of its own).
			UndatedMachine: func(_ *testing.T, ceiling string) string {
				n++
				id := fmt.Sprintf("i-undated-%d", n)
				tags := []types.Tag{{Key: aws.String(driver.TagCell), Value: aws.String("cell-1")}, {Key: aws.String(driver.TagClaim), Value: aws.String("undated")}}
				if ceiling != "" {
					tags = append(tags, types.Tag{Key: aws.String(driver.TagHardExpires), Value: aws.String(ceiling)})
				}
				m.plant(types.Instance{InstanceId: aws.String(id), State: &types.InstanceState{Name: types.InstanceStateNameRunning}, Tags: tags})
				return id
			},
		}
	})
}
