package awsec2

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

var keys = map[string]string{"org-a": "arn:aws:kms:us-east-1:000000000000:key/a", "org-b": "arn:aws:kms:us-east-1:000000000000:key/b"}

func newDriver(t *testing.T, m *mockEC2) *Driver {
	t.Helper()
	m.group("sg-claim", "cell-1", "claim-1")
	d, err := New(m, Config{
		CellID: "cell-1", VPCID: "vpc-1", LaunchTemplateID: "lt-1",
		WorkloadSubnetID: "subnet-vm", ObserverSubnetID: "subnet-obs",
		CellAgentGroupID: "sg-agent", EgressGroupID: "sg-egress", ObserverImageRef: "ami-observer",
		OrgKey: func(org string) (string, error) {
			if k, ok := keys[org]; ok {
				return k, nil
			}
			return "", errors.New("no key")
		},
		Hibernate: true, Clock: clock.NewFake(time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func spec(role driver.Role) driver.MachineSpec {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	return driver.MachineSpec{
		CellID: "cell-1", EnvironmentID: "env-1", Role: role, OrgID: "org-a", ClaimID: "claim-1",
		ImageID: "img-1", ImageRef: "ami-workload", Size: driver.MachineSize{CPU: 2, MemoryGB: 4, DiskGB: 40},
		ClaimGroupID: "sg-claim", KMSKeyRef: keys["org-a"],
		ExpiresAt: now.Add(5 * time.Minute), HardExpiresAt: now.Add(60 * time.Minute),
	}
}

func tagMap(ts []types.Tag) map[string]string {
	out := map[string]string{}
	for _, t := range ts {
		out[aws.ToString(t.Key)] = aws.ToString(t.Value)
	}
	return out
}

func TestCreateUsesLaunchTemplateTagsAndOrgKey(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	ref, err := d.Create(context.Background(), spec(driver.RoleWorkload))
	if err != nil {
		t.Fatal(err)
	}
	in := m.run[0]
	if aws.ToString(in.LaunchTemplate.LaunchTemplateId) != "lt-1" {
		t.Fatal("no launch template")
	}
	if in.MetadataOptions.HttpEndpoint != types.InstanceMetadataEndpointStateDisabled {
		t.Fatal("metadata not disabled (S-01)")
	}
	if in.IamInstanceProfile != nil {
		t.Fatal("machine got an instance profile")
	}
	ebs := in.BlockDeviceMappings[0].Ebs
	if !aws.ToBool(ebs.Encrypted) || aws.ToString(ebs.KmsKeyId) != keys["org-a"] {
		t.Fatal("disk not encrypted with the org key (ADR-055)")
	}
	if len(in.SecurityGroupIds) != 1 || in.SecurityGroupIds[0] != "sg-claim" || aws.ToString(in.SubnetId) != "subnet-vm" {
		t.Fatalf("wrong network: %v %v", in.SecurityGroupIds, aws.ToString(in.SubnetId))
	}
	for _, ts := range in.TagSpecifications {
		tags := tagMap(ts.Tags)
		for _, k := range []string{driver.TagCell, driver.TagEnv, driver.TagOrg, driver.TagClaim, driver.TagRole, driver.TagExpires, driver.TagHardExpires} {
			if tags[k] == "" {
				t.Fatalf("%s missing on %s", k, ts.ResourceType)
			}
		}
		if tags[driver.TagHardExpires] != "2026-10-29T13:00:00Z" {
			t.Fatalf("hard-expires %s", tags[driver.TagHardExpires])
		}
	}
	if ref.ImageID != "ami-workload" || ref.PrivateAddress == "" {
		t.Fatalf("ref %+v", ref)
	}
}

func TestObserverUsesItsOwnImageAndSubnet(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	if _, err := d.Create(context.Background(), spec(driver.RoleObserver)); err != nil {
		t.Fatal(err)
	}
	if aws.ToString(m.run[0].ImageId) != "ami-observer" || aws.ToString(m.run[0].SubnetId) != "subnet-obs" {
		t.Fatal("observer on the workload image or subnet")
	}
	if m.run[0].HibernationOptions != nil {
		t.Fatal("observer configured for hibernation")
	}
}

// S-11: a spec carrying another org's key never reaches RunInstances.
func TestCreateRefusesAnotherOrgsKey(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	s := spec(driver.RoleWorkload)
	s.KMSKeyRef = keys["org-b"]
	if _, err := d.Create(context.Background(), s); !errors.Is(err, ErrWrongOrgKey) {
		t.Fatalf("err %v", err)
	}
	if len(m.run) != 0 {
		t.Fatal("RunInstances called")
	}
}

func TestCreateRefusesSpecWithoutCeiling(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	s := spec(driver.RoleWorkload)
	s.HardExpiresAt = time.Time{}
	if _, err := d.Create(context.Background(), s); err == nil {
		t.Fatal("created a machine without kodus:hard-expires")
	}
	s = spec(driver.RoleWorkload)
	s.Tags = map[string]string{driver.TagHardExpires: "2099-01-01T00:00:00Z"}
	if _, err := d.Create(context.Background(), s); err == nil {
		t.Fatal("caller overrode a reserved tag")
	}
}

// S-08: renewing moves kodus:expires, never the ceiling, and never past it.
func TestSetExpiryNeverTouchesHardExpires(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	ref, _ := d.Create(context.Background(), spec(driver.RoleWorkload))
	if err := d.SetExpiry(context.Background(), ref, time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	tags := tagMap(m.tags[len(m.tags)-1].Tags)
	if _, ok := tags[driver.TagHardExpires]; ok || len(tags) != 1 {
		t.Fatalf("tags %v", tags)
	}
	if tags[driver.TagExpires] != "2026-10-29T13:00:00Z" {
		t.Fatalf("expires not capped at the ceiling: %s", tags[driver.TagExpires])
	}
	if err := d.tag(context.Background(), "i-1", map[string]string{driver.TagHardExpires: "x"}); !errors.Is(err, driver.ErrHardExpiresImmutable) {
		t.Fatalf("err %v", err)
	}
}

// S-02: per-claim groups, no self reference, no default egress.
func TestPrepareClaimGroups(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	net, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{
		CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1",
		Expose: []driver.ExposePort{{Service: "api", Port: 3000, Kind: "http"}, {Service: "db", Port: 5432, Kind: "postgres"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.groups) != 2 || len(m.revoked) != 2 {
		t.Fatalf("groups %d, revoked default egress %d", len(m.groups), len(m.revoked))
	}
	check := func(group string, perms []types.IpPermission) {
		for _, p := range perms {
			if len(p.IpRanges) > 0 || len(p.Ipv6Ranges) > 0 {
				t.Fatalf("%s opens a CIDR", group)
			}
			for _, pair := range p.UserIdGroupPairs {
				if aws.ToString(pair.GroupId) == group {
					t.Fatalf("%s references itself", group)
				}
			}
		}
	}
	ports := map[int32]string{}
	for _, in := range m.ingress {
		check(aws.ToString(in.GroupId), in.IpPermissions)
		if aws.ToString(in.GroupId) == net.WorkloadGroupID {
			for _, p := range in.IpPermissions {
				ports[aws.ToInt32(p.FromPort)] = aws.ToString(p.UserIdGroupPairs[0].GroupId)
			}
		}
	}
	for _, e := range m.egress {
		check(aws.ToString(e.GroupId), e.IpPermissions)
	}
	if ports[22] != "sg-agent" || ports[3000] != net.ObserverGroupID || ports[5432] != net.ObserverGroupID {
		t.Fatalf("workload ingress %v", ports)
	}
}

func TestListPaginatesAndRechecksSelector(t *testing.T) {
	m := &mockEC2{pages: []*ec2.DescribeInstancesOutput{
		{NextToken: aws.String("p2"), Reservations: []types.Reservation{{Instances: []types.Instance{
			{InstanceId: aws.String("i-1"), Tags: []types.Tag{{Key: aws.String(driver.TagCell), Value: aws.String("cell-1")}}},
			{InstanceId: aws.String("i-x"), Tags: []types.Tag{{Key: aws.String(driver.TagCell), Value: aws.String("other")}}},
		}}}},
		{Reservations: []types.Reservation{{Instances: []types.Instance{
			{InstanceId: aws.String("i-2"), Tags: []types.Tag{{Key: aws.String(driver.TagCell), Value: aws.String("cell-1")}}},
		}}}},
	}}
	d := newDriver(t, m)
	refs, err := d.List(context.Background(), map[string]string{driver.TagCell: "cell-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 2 || refs[0].MachineID != "i-1" || refs[1].MachineID != "i-2" {
		t.Fatalf("refs %+v", refs)
	}
	if aws.ToString(m.describe[1].NextToken) != "p2" {
		t.Fatal("second page not requested")
	}
}

func TestResetAndDestroy(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	ref := plantResetMachine(m, "i-1")
	m.snapshots = map[string]types.Snapshot{"snap-1": resetSnapshot("snap-1", "vol-original", "cell-1", "org-a")}
	if err := d.Reset(context.Background(), ref, driver.SnapshotRef{Kind: "compose_volumes", Ref: "x"}); !errors.Is(err, ErrComposeResetInCell) {
		t.Fatal(err)
	}
	if err := d.Reset(context.Background(), ref, driver.SnapshotRef{Kind: "disk", Ref: "snap-1"}); err != nil {
		t.Fatal(err)
	}
	if err := d.Destroy(context.Background(), ref); err != nil || m.terminate[0].InstanceIds[0] != "i-1" {
		t.Fatal("terminate")
	}
}

// A spec naming another claim's (or another cell's) group would put the VM
// where that claim's observer reaches it.
func TestCreateRefusesAGroupThatIsNotTheClaims(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	m.group("sg-other", "cell-1", "claim-2")
	m.group("sg-foreign", "cell-9", "claim-1")
	for _, sg := range []string{"sg-other", "sg-foreign", "sg-missing"} {
		s := spec(driver.RoleWorkload)
		s.ClaimGroupID = sg
		if _, err := d.Create(context.Background(), s); !errors.Is(err, driver.ErrNotOwned) {
			t.Fatalf("%s: %v", sg, err)
		}
	}
	if len(m.run) != 0 {
		t.Fatal("an instance was launched")
	}
}

// Before, a failure after the first group left it behind (and its quota).
func TestPrepareClaimRemovesWhatItMadeWhenItFails(t *testing.T) {
	m := &mockEC2{failOn: map[string]error{"AuthorizeSecurityGroupEgress": errors.New("throttled")}}
	d := newDriver(t, m)
	if _, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1",
		Expose: []driver.ExposePort{{Service: "api", Port: 3000}}}); err == nil {
		t.Fatal("no error")
	}
	for id := range m.sgs {
		if id != "sg-claim" {
			t.Fatalf("group %s left behind (deleted %v)", id, m.deleted)
		}
	}
}

// The groups reference each other; EC2 refuses to delete a referenced
// group, so the release revokes the rules first.
func TestReleaseClaimDeletesGroupsThatReferenceEachOther(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	net, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1",
		Expose: []driver.ExposePort{{Service: "api", Port: 3000}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.ReleaseClaim(context.Background(), net); err != nil {
		t.Fatal(err)
	}
	if _, ok := m.sgs[net.WorkloadGroupID]; ok {
		t.Fatal("workload group still there")
	}
}

// The workload reaches the egress hosts on the proxy and resolver ports
// only, not their control ports or the injector's listener.
func TestClaimEgressIsOnlyTheProxyAndResolverPorts(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	net, _ := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	for _, e := range m.egress {
		if aws.ToString(e.GroupId) != net.WorkloadGroupID {
			continue
		}
		for _, p := range e.IpPermissions {
			port := aws.ToInt32(p.FromPort)
			if aws.ToString(p.IpProtocol) == "-1" || (port != 80 && port != 443 && port != 53) || port != aws.ToInt32(p.ToPort) {
				t.Fatalf("workload egress %s %d-%d", aws.ToString(p.IpProtocol), port, aws.ToInt32(p.ToPort))
			}
		}
	}
}

func TestResetRefusesAnotherOrgsSnapshot(t *testing.T) {
	m := &mockEC2{snapshots: map[string]types.Snapshot{
		"snap-b": {SnapshotId: aws.String("snap-b"), Tags: []types.Tag{{Key: aws.String(driver.TagOrg), Value: aws.String("org-b")}, {Key: aws.String(driver.TagCell), Value: aws.String("cell-1")}}},
	}}
	d := newDriver(t, m)
	ref := driver.MachineRef{MachineID: "i-1", DriverRef: "i-1", Tags: map[string]string{driver.TagOrg: "org-a"}}
	for _, snap := range []string{"snap-b", "snap-missing"} {
		if err := d.Reset(context.Background(), ref, driver.SnapshotRef{Kind: "disk", Ref: snap}); !errors.Is(err, driver.ErrNotOwned) {
			t.Fatalf("%s: %v", snap, err)
		}
	}
}

// A snapshot needs cell and org scope AND the original root volume, not
// merely a bake label that could refer to another claim's disk.
func TestResetTakesOnlyThisMachinesOriginalSnapshot(t *testing.T) {
	m := &mockEC2{snapshots: map[string]types.Snapshot{
		"snap-own":   resetSnapshot("snap-own", "vol-original", "cell-1", "org-a"),
		"snap-other": resetSnapshot("snap-other", "vol-original", "cell-2", "org-a"),
	}}
	d := newDriver(t, m)
	ref := plantResetMachine(m, "i-1")
	if err := d.Reset(context.Background(), ref, driver.SnapshotRef{Kind: "disk", Ref: "snap-own"}); err != nil {
		t.Fatal(err)
	}
	if err := d.Reset(context.Background(), ref, driver.SnapshotRef{Kind: "disk", Ref: "snap-other"}); !errors.Is(err, driver.ErrNotOwned) {
		t.Fatal(err)
	}
}
