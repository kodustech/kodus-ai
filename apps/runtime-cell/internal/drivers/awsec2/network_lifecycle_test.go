package awsec2

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

type boundedNetworkAPI struct {
	*mockEC2
	createBounded, cleanupBounded bool
}

func (m *boundedNetworkAPI) CreateSecurityGroup(ctx context.Context, in *ec2.CreateSecurityGroupInput, opts ...func(*ec2.Options)) (*ec2.CreateSecurityGroupOutput, error) {
	_, m.createBounded = ctx.Deadline()
	return m.mockEC2.CreateSecurityGroup(ctx, in, opts...)
}

func (m *boundedNetworkAPI) DescribeSecurityGroups(ctx context.Context, in *ec2.DescribeSecurityGroupsInput, opts ...func(*ec2.Options)) (*ec2.DescribeSecurityGroupsOutput, error) {
	_, m.cleanupBounded = ctx.Deadline()
	return m.mockEC2.DescribeSecurityGroups(ctx, in, opts...)
}

// PrepareClaim previously discarded cancellation for rollback without imposing
// a new deadline, so an AWS networking cleanup could hold the claim forever.
func TestClaimNetworkOperationsAndRollbackHaveDeadlines(t *testing.T) {
	api := &boundedNetworkAPI{mockEC2: &mockEC2{failOn: map[string]error{"RevokeSecurityGroupEgress": errors.New("prepare failed")}}}
	d := newDriver(t, api.mockEC2)
	d.api = api
	if _, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"}); err == nil {
		t.Fatal("expected setup failure")
	}
	if !api.createBounded || !api.cleanupBounded {
		t.Fatalf("unbounded network operation: create=%v rollback=%v", api.createBounded, api.cleanupBounded)
	}
	api.cleanupBounded = false
	if err := d.ReleaseClaim(context.Background(), driver.ClaimNetwork{WorkloadGroupID: "sg-gone"}); err != nil {
		t.Fatal(err)
	}
	if !api.cleanupBounded {
		t.Fatal("standalone release has no deadline")
	}
}

func TestFailedNetworkRollbackRetainsPhysicalResponsibility(t *testing.T) {
	m := &mockEC2{failOn: map[string]error{"RevokeSecurityGroupEgress": errors.New("prepare failed"), "DescribeSecurityGroups": errors.New("cleanup unavailable")}}
	d := newDriver(t, m)
	_, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	if !errors.Is(err, driver.ErrResourceCleanupPending) {
		t.Fatalf("unconfirmed network cleanup reported reusable: %v", err)
	}
}
