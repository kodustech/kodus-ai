package awsec2

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

// mockEC2 records every call; no request ever leaves the process.
type mockEC2 struct {
	mu        sync.Mutex
	calls     []string
	run       []*ec2.RunInstancesInput
	tags      []*ec2.CreateTagsInput
	groups    []*ec2.CreateSecurityGroupInput
	ingress   []*ec2.AuthorizeSecurityGroupIngressInput
	egress    []*ec2.AuthorizeSecurityGroupEgressInput
	revoked   []*ec2.RevokeSecurityGroupEgressInput
	replace   []*ec2.CreateReplaceRootVolumeTaskInput
	tasks     map[string]types.ReplaceRootVolumeTask
	taskPages []*ec2.DescribeReplaceRootVolumeTasksOutput
	terminate []*ec2.TerminateInstancesInput
	describe  []*ec2.DescribeInstancesInput
	pages     []*ec2.DescribeInstancesOutput
	seq       int
	// sgs is the account's security groups, as EC2 would describe them;
	// deleting one another group's rule references fails, as on EC2.
	sgs map[string]*types.SecurityGroup
	// snapshots are the account's snapshots by id.
	snapshots map[string]types.Snapshot
	// instances are the account's instances by id, as RunInstances made
	// them (or a test planted them); pages, when set, answer
	// DescribeInstances instead.
	instances map[string]*types.Instance
	// failOn makes the named call fail.
	failOn  map[string]error
	deleted []string
}

func (m *mockEC2) note(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, name)
	m.seq++
	return m.failOn[name]
}

// group is a security group the cell's claim owns, for specs to name.
func (m *mockEC2) group(id, cell, claim string) {
	if m.sgs == nil {
		m.sgs = map[string]*types.SecurityGroup{}
	}
	m.sgs[id] = &types.SecurityGroup{GroupId: aws.String(id), VpcId: aws.String("vpc-1"), Tags: []types.Tag{
		{Key: aws.String("kodus:org"), Value: aws.String("org-a")}, {Key: aws.String("kodus:cell"), Value: aws.String(cell)}, {Key: aws.String("kodus:claim"), Value: aws.String(claim)}}}
}

func references(g *types.SecurityGroup, id string) bool {
	for _, perms := range [][]types.IpPermission{g.IpPermissions, g.IpPermissionsEgress} {
		for _, p := range perms {
			for _, pair := range p.UserIdGroupPairs {
				if aws.ToString(pair.GroupId) == id {
					return true
				}
			}
		}
	}
	return false
}

func (m *mockEC2) DescribeSecurityGroups(_ context.Context, in *ec2.DescribeSecurityGroupsInput, _ ...func(*ec2.Options)) (*ec2.DescribeSecurityGroupsOutput, error) {
	if err := m.note("DescribeSecurityGroups"); err != nil {
		return nil, err
	}
	out := &ec2.DescribeSecurityGroupsOutput{}
	for _, id := range in.GroupIds {
		if g, ok := m.sgs[id]; ok {
			out.SecurityGroups = append(out.SecurityGroups, *g)
		}
	}
	return out, nil
}

func (m *mockEC2) DescribeSnapshots(_ context.Context, in *ec2.DescribeSnapshotsInput, _ ...func(*ec2.Options)) (*ec2.DescribeSnapshotsOutput, error) {
	if err := m.note("DescribeSnapshots"); err != nil {
		return nil, err
	}
	out := &ec2.DescribeSnapshotsOutput{}
	for _, id := range in.SnapshotIds {
		if s, ok := m.snapshots[id]; ok {
			out.Snapshots = append(out.Snapshots, s)
		}
	}
	return out, nil
}

func (m *mockEC2) RevokeSecurityGroupIngress(_ context.Context, in *ec2.RevokeSecurityGroupIngressInput, _ ...func(*ec2.Options)) (*ec2.RevokeSecurityGroupIngressOutput, error) {
	if err := m.note("RevokeSecurityGroupIngress"); err != nil {
		return nil, err
	}
	if g := m.sgs[aws.ToString(in.GroupId)]; g != nil {
		g.IpPermissions = nil
	}
	return &ec2.RevokeSecurityGroupIngressOutput{}, nil
}

func (m *mockEC2) RunInstances(_ context.Context, in *ec2.RunInstancesInput, _ ...func(*ec2.Options)) (*ec2.RunInstancesOutput, error) {
	if err := m.note("RunInstances"); err != nil {
		return nil, err
	}
	m.run = append(m.run, in)
	for _, existing := range m.instances {
		if token := aws.ToString(in.ClientToken); token != "" && aws.ToString(existing.ClientToken) == token {
			return &ec2.RunInstancesOutput{Instances: []types.Instance{*existing}}, nil
		}
	}
	var tags []types.Tag
	for _, ts := range in.TagSpecifications {
		if ts.ResourceType == types.ResourceTypeInstance {
			tags = ts.Tags
		}
	}
	i := types.Instance{
		InstanceId:       aws.String(fmt.Sprintf("i-%04d", m.seq)),
		ClientToken:      in.ClientToken,
		PrivateIpAddress: aws.String("10.0.3.10"),
		ImageId:          in.ImageId,
		Tags:             append([]types.Tag(nil), tags...),
		State:            &types.InstanceState{Name: types.InstanceStateNameRunning},
		RootDeviceName:   aws.String("/dev/xvda"), BlockDeviceMappings: []types.InstanceBlockDeviceMapping{{DeviceName: aws.String("/dev/xvda"), Ebs: &types.EbsInstanceBlockDevice{VolumeId: aws.String(fmt.Sprintf("vol-%04d", m.seq))}}},
	}
	m.plant(i)
	return &ec2.RunInstancesOutput{Instances: []types.Instance{i}}, nil
}

// plant puts an instance in the account.
func (m *mockEC2) plant(i types.Instance) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.instances == nil {
		m.instances = map[string]*types.Instance{}
	}
	m.instances[aws.ToString(i.InstanceId)] = &i
}

// matches applies DescribeInstances' filters the way EC2 does: every
// filter must hold, any of its values.
func matches(i *types.Instance, ids []string, filters []types.Filter) bool {
	if len(ids) > 0 && !slices.Contains(ids, aws.ToString(i.InstanceId)) {
		return false
	}
	tags := map[string]string{}
	for _, t := range i.Tags {
		tags[aws.ToString(t.Key)] = aws.ToString(t.Value)
	}
	for _, f := range filters {
		var have string
		switch name := aws.ToString(f.Name); {
		case name == "client-token":
			have = aws.ToString(i.ClientToken)
		case name == "instance-state-name":
			have = string(i.State.Name)
		case strings.HasPrefix(name, "tag:"):
			v, ok := tags[strings.TrimPrefix(name, "tag:")]
			if !ok {
				return false
			}
			have = v
		default:
			continue
		}
		if !slices.Contains(f.Values, have) {
			return false
		}
	}
	return true
}

func (m *mockEC2) StartInstances(_ context.Context, in *ec2.StartInstancesInput, _ ...func(*ec2.Options)) (*ec2.StartInstancesOutput, error) {
	if err := m.note("StartInstances"); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, id := range in.InstanceIds {
		if i := m.instances[id]; i != nil {
			i.State = &types.InstanceState{Name: types.InstanceStateNameRunning}
		}
	}
	return &ec2.StartInstancesOutput{}, nil
}

func (m *mockEC2) StopInstances(_ context.Context, in *ec2.StopInstancesInput, _ ...func(*ec2.Options)) (*ec2.StopInstancesOutput, error) {
	if err := m.note("StopInstances"); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, id := range in.InstanceIds {
		if i := m.instances[id]; i != nil {
			i.State = &types.InstanceState{Name: types.InstanceStateNameStopped}
		}
	}
	return &ec2.StopInstancesOutput{}, nil
}

func (m *mockEC2) TerminateInstances(_ context.Context, in *ec2.TerminateInstancesInput, _ ...func(*ec2.Options)) (*ec2.TerminateInstancesOutput, error) {
	if err := m.note("TerminateInstances"); err != nil {
		return nil, err
	}
	m.terminate = append(m.terminate, in)
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, id := range in.InstanceIds {
		if i, ok := m.instances[id]; ok {
			i.State = &types.InstanceState{Name: types.InstanceStateNameTerminated}
		}
	}
	return &ec2.TerminateInstancesOutput{}, nil
}

func (m *mockEC2) DescribeInstances(_ context.Context, in *ec2.DescribeInstancesInput, _ ...func(*ec2.Options)) (*ec2.DescribeInstancesOutput, error) {
	if err := m.note("DescribeInstances"); err != nil {
		return nil, err
	}
	m.describe = append(m.describe, in)
	if len(m.pages) == 0 {
		m.mu.Lock()
		defer m.mu.Unlock()
		var found []types.Instance
		for _, i := range m.instances {
			if matches(i, in.InstanceIds, in.Filters) {
				found = append(found, *i)
			}
		}
		return &ec2.DescribeInstancesOutput{Reservations: []types.Reservation{{Instances: found}}}, nil
	}
	p := m.pages[0]
	m.pages = m.pages[1:]
	return p, nil
}

func (m *mockEC2) CreateTags(_ context.Context, in *ec2.CreateTagsInput, _ ...func(*ec2.Options)) (*ec2.CreateTagsOutput, error) {
	if err := m.note("CreateTags"); err != nil {
		return nil, err
	}
	m.tags = append(m.tags, in)
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, id := range in.Resources {
		i, ok := m.instances[id]
		if !ok {
			continue
		}
		for _, nt := range in.Tags {
			idx := slices.IndexFunc(i.Tags, func(t types.Tag) bool { return aws.ToString(t.Key) == aws.ToString(nt.Key) })
			if idx >= 0 {
				i.Tags[idx] = nt
			} else {
				i.Tags = append(i.Tags, nt)
			}
		}
	}
	return &ec2.CreateTagsOutput{}, nil
}

func (m *mockEC2) CreateSecurityGroup(_ context.Context, in *ec2.CreateSecurityGroupInput, _ ...func(*ec2.Options)) (*ec2.CreateSecurityGroupOutput, error) {
	if err := m.note("CreateSecurityGroup"); err != nil {
		return nil, err
	}
	m.groups = append(m.groups, in)
	id := fmt.Sprintf("sg-%04d", m.seq)
	if m.sgs == nil {
		m.sgs = map[string]*types.SecurityGroup{}
	}
	m.sgs[id] = &types.SecurityGroup{GroupId: aws.String(id), VpcId: in.VpcId, Tags: in.TagSpecifications[0].Tags,
		IpPermissionsEgress: []types.IpPermission{{IpProtocol: aws.String("-1"), IpRanges: []types.IpRange{{CidrIp: aws.String("0.0.0.0/0")}}}}}
	return &ec2.CreateSecurityGroupOutput{GroupId: aws.String(id)}, nil
}

func (m *mockEC2) DeleteSecurityGroup(_ context.Context, in *ec2.DeleteSecurityGroupInput, _ ...func(*ec2.Options)) (*ec2.DeleteSecurityGroupOutput, error) {
	if err := m.note("DeleteSecurityGroup"); err != nil {
		return nil, err
	}
	id := aws.ToString(in.GroupId)
	for other, g := range m.sgs {
		if other != id && references(g, id) {
			return nil, fmt.Errorf("DependencyViolation: %s is referenced by %s", id, other)
		}
	}
	delete(m.sgs, id)
	m.deleted = append(m.deleted, id)
	return &ec2.DeleteSecurityGroupOutput{}, nil
}

func (m *mockEC2) AuthorizeSecurityGroupIngress(_ context.Context, in *ec2.AuthorizeSecurityGroupIngressInput, _ ...func(*ec2.Options)) (*ec2.AuthorizeSecurityGroupIngressOutput, error) {
	if err := m.note("AuthorizeSecurityGroupIngress"); err != nil {
		return nil, err
	}
	m.ingress = append(m.ingress, in)
	if g := m.sgs[aws.ToString(in.GroupId)]; g != nil {
		g.IpPermissions = append(g.IpPermissions, in.IpPermissions...)
	}
	return &ec2.AuthorizeSecurityGroupIngressOutput{}, nil
}

func (m *mockEC2) AuthorizeSecurityGroupEgress(_ context.Context, in *ec2.AuthorizeSecurityGroupEgressInput, _ ...func(*ec2.Options)) (*ec2.AuthorizeSecurityGroupEgressOutput, error) {
	if err := m.note("AuthorizeSecurityGroupEgress"); err != nil {
		return nil, err
	}
	m.egress = append(m.egress, in)
	if g := m.sgs[aws.ToString(in.GroupId)]; g != nil {
		g.IpPermissionsEgress = append(g.IpPermissionsEgress, in.IpPermissions...)
	}
	return &ec2.AuthorizeSecurityGroupEgressOutput{}, nil
}

func (m *mockEC2) RevokeSecurityGroupEgress(_ context.Context, in *ec2.RevokeSecurityGroupEgressInput, _ ...func(*ec2.Options)) (*ec2.RevokeSecurityGroupEgressOutput, error) {
	if err := m.note("RevokeSecurityGroupEgress"); err != nil {
		return nil, err
	}
	m.revoked = append(m.revoked, in)
	if g := m.sgs[aws.ToString(in.GroupId)]; g != nil {
		g.IpPermissionsEgress = nil
	}
	return &ec2.RevokeSecurityGroupEgressOutput{}, nil
}

func (m *mockEC2) CreateReplaceRootVolumeTask(_ context.Context, in *ec2.CreateReplaceRootVolumeTaskInput, _ ...func(*ec2.Options)) (*ec2.CreateReplaceRootVolumeTaskOutput, error) {
	if err := m.note("CreateReplaceRootVolumeTask"); err != nil {
		return nil, err
	}
	m.replace = append(m.replace, in)
	task := types.ReplaceRootVolumeTask{ReplaceRootVolumeTaskId: aws.String(fmt.Sprintf("replace-%04d", m.seq)), InstanceId: in.InstanceId, SnapshotId: in.SnapshotId, DeleteReplacedRootVolume: in.DeleteReplacedRootVolume, TaskState: types.ReplaceRootVolumeTaskStateSucceeded}
	if m.tasks == nil {
		m.tasks = map[string]types.ReplaceRootVolumeTask{}
	}
	m.tasks[aws.ToString(task.ReplaceRootVolumeTaskId)] = task
	return &ec2.CreateReplaceRootVolumeTaskOutput{ReplaceRootVolumeTask: &task}, nil
}
func (m *mockEC2) DescribeReplaceRootVolumeTasks(_ context.Context, in *ec2.DescribeReplaceRootVolumeTasksInput, _ ...func(*ec2.Options)) (*ec2.DescribeReplaceRootVolumeTasksOutput, error) {
	if err := m.note("DescribeReplaceRootVolumeTasks"); err != nil {
		return nil, err
	}
	out := &ec2.DescribeReplaceRootVolumeTasksOutput{}
	if len(m.taskPages) > 0 {
		out = m.taskPages[0]
		m.taskPages = m.taskPages[1:]
	} else {
		for _, id := range in.ReplaceRootVolumeTaskIds {
			if task, ok := m.tasks[id]; ok {
				out.ReplaceRootVolumeTasks = append(out.ReplaceRootVolumeTasks, task)
			}
		}
	}
	for _, task := range out.ReplaceRootVolumeTasks {
		if task.TaskState == types.ReplaceRootVolumeTaskStateSucceeded {
			if i := m.instances[aws.ToString(task.InstanceId)]; i != nil && len(i.BlockDeviceMappings) > 0 {
				i.BlockDeviceMappings = append([]types.InstanceBlockDeviceMapping(nil), i.BlockDeviceMappings...)
				i.BlockDeviceMappings[0].Ebs = &types.EbsInstanceBlockDevice{VolumeId: aws.String("vol-" + aws.ToString(task.ReplaceRootVolumeTaskId))}
			}
		}
	}
	return out, nil
}
