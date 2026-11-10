// Package awsec2 is the aws-ec2 MachineDriver (docs §4, ADR-056). It is
// written against EC2API, the subset of the AWS SDK it needs, so tests run
// on a mock and nothing here calls AWS unless a real client is passed in.
package awsec2

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"maps"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/smithy-go"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// EC2API is satisfied by *ec2.Client.
type EC2API interface {
	DescribeReplaceRootVolumeTasks(ctx context.Context, in *ec2.DescribeReplaceRootVolumeTasksInput, opts ...func(*ec2.Options)) (*ec2.DescribeReplaceRootVolumeTasksOutput, error)
	RunInstances(ctx context.Context, in *ec2.RunInstancesInput, opts ...func(*ec2.Options)) (*ec2.RunInstancesOutput, error)
	StartInstances(ctx context.Context, in *ec2.StartInstancesInput, opts ...func(*ec2.Options)) (*ec2.StartInstancesOutput, error)
	StopInstances(ctx context.Context, in *ec2.StopInstancesInput, opts ...func(*ec2.Options)) (*ec2.StopInstancesOutput, error)
	TerminateInstances(ctx context.Context, in *ec2.TerminateInstancesInput, opts ...func(*ec2.Options)) (*ec2.TerminateInstancesOutput, error)
	DescribeInstances(ctx context.Context, in *ec2.DescribeInstancesInput, opts ...func(*ec2.Options)) (*ec2.DescribeInstancesOutput, error)
	CreateTags(ctx context.Context, in *ec2.CreateTagsInput, opts ...func(*ec2.Options)) (*ec2.CreateTagsOutput, error)
	CreateSecurityGroup(ctx context.Context, in *ec2.CreateSecurityGroupInput, opts ...func(*ec2.Options)) (*ec2.CreateSecurityGroupOutput, error)
	DeleteSecurityGroup(ctx context.Context, in *ec2.DeleteSecurityGroupInput, opts ...func(*ec2.Options)) (*ec2.DeleteSecurityGroupOutput, error)
	AuthorizeSecurityGroupIngress(ctx context.Context, in *ec2.AuthorizeSecurityGroupIngressInput, opts ...func(*ec2.Options)) (*ec2.AuthorizeSecurityGroupIngressOutput, error)
	AuthorizeSecurityGroupEgress(ctx context.Context, in *ec2.AuthorizeSecurityGroupEgressInput, opts ...func(*ec2.Options)) (*ec2.AuthorizeSecurityGroupEgressOutput, error)
	RevokeSecurityGroupEgress(ctx context.Context, in *ec2.RevokeSecurityGroupEgressInput, opts ...func(*ec2.Options)) (*ec2.RevokeSecurityGroupEgressOutput, error)
	RevokeSecurityGroupIngress(ctx context.Context, in *ec2.RevokeSecurityGroupIngressInput, opts ...func(*ec2.Options)) (*ec2.RevokeSecurityGroupIngressOutput, error)
	CreateReplaceRootVolumeTask(ctx context.Context, in *ec2.CreateReplaceRootVolumeTaskInput, opts ...func(*ec2.Options)) (*ec2.CreateReplaceRootVolumeTaskOutput, error)
	DescribeSecurityGroups(ctx context.Context, in *ec2.DescribeSecurityGroupsInput, opts ...func(*ec2.Options)) (*ec2.DescribeSecurityGroupsOutput, error)
	DescribeSnapshots(ctx context.Context, in *ec2.DescribeSnapshotsInput, opts ...func(*ec2.Options)) (*ec2.DescribeSnapshotsOutput, error)
}

var _ EC2API = (*ec2.Client)(nil)

// KeyResolver returns the KMS key of an org (ADR-055).
type KeyResolver func(orgID string) (string, error)

type Config struct {
	CellID string
	VPCID  string
	// Machines are born only through this launch template, which has the
	// metadata service off; the cell role cannot launch without it (S-07).
	LaunchTemplateID      string
	LaunchTemplateVersion string
	WorkloadSubnetID      string
	ObserverSubnetID      string
	// Security groups of the fixed pieces of the cell (ADR-056).
	CellAgentGroupID string
	EgressGroupID    string // proxy and resolver
	ObserverImageRef string // signed, immutable Kodus observer AMI
	OrgKey           KeyResolver
	Hibernate        bool
	// Waiters are bounded independently of the caller; Clock makes polling testable.
	Clock            clock.Clock
	PollInterval     time.Duration
	OperationTimeout time.Duration
	CleanupTimeout   time.Duration
}

type Driver struct {
	api EC2API
	cfg Config
}

func New(api EC2API, cfg Config) (*Driver, error) {
	switch {
	case cfg.CellID == "", cfg.VPCID == "":
		return nil, errors.New("awsec2: cellId and vpcId required")
	case cfg.LaunchTemplateID == "":
		return nil, errors.New("awsec2: launch template required")
	case cfg.WorkloadSubnetID == "" || cfg.ObserverSubnetID == "":
		return nil, errors.New("awsec2: workload and observer subnets required")
	case cfg.CellAgentGroupID == "" || cfg.EgressGroupID == "":
		return nil, errors.New("awsec2: cell agent and egress groups required")
	case cfg.OrgKey == nil:
		return nil, errors.New("awsec2: org key resolver required")
	}
	if cfg.LaunchTemplateVersion == "" {
		cfg.LaunchTemplateVersion = "$Default"
	}
	return &Driver{api: api, cfg: cfg}, nil
}

func (d *Driver) Kind() string { return "aws-ec2" }

func (d *Driver) Capabilities() driver.Capabilities {
	s := "stop"
	if d.cfg.Hibernate {
		s = "hibernate"
	}
	return driver.Capabilities{Isolation: driver.IsolationVM, NestedContainers: true, Suspend: s, Arch: []string{"x86_64"}}
}

// ErrBakeOutsideDriver: the bake boots the recipe on a clean machine and
// runs migrate and seed; that orchestration lives in internal/image.
var ErrBakeOutsideDriver = fmt.Errorf("%w: awsec2 bakes through the image builder, which the cell does not have yet", driver.ErrUnsupported)

func (d *Driver) Bake(context.Context, driver.BakeSpec) (driver.ImageRef, error) {
	return driver.ImageRef{}, ErrBakeOutsideDriver
}

func ec2Tags(m map[string]string) []types.Tag {
	out := make([]types.Tag, 0, len(m))
	for _, k := range sortedKeys(m) {
		out = append(out, types.Tag{Key: aws.String(k), Value: aws.String(m[k])})
	}
	return out
}

func (d *Driver) claimTags(spec driver.ClaimNetworkSpec, role string) map[string]string {
	return map[string]string{
		driver.TagCell:  d.cfg.CellID,
		driver.TagOrg:   spec.OrgID,
		driver.TagClaim: spec.ClaimID,
		driver.TagRole:  role,
	}
}

func groupPair(port int32, proto, groupID string) types.IpPermission {
	return types.IpPermission{
		IpProtocol:       aws.String(proto),
		FromPort:         aws.Int32(port),
		ToPort:           aws.Int32(port),
		UserIdGroupPairs: []types.UserIdGroupPair{{GroupId: aws.String(groupID)}},
	}
}

var allEgress = []types.IpPermission{{IpProtocol: aws.String("-1"), IpRanges: []types.IpRange{{CidrIp: aws.String("0.0.0.0/0")}}}}

// toEgressGroup is the only way out of a claim's machines: the proxy's
// redirected ports and the resolver, on the egress group. The control
// ports and the injector's listener on the same hosts stay out of reach.
func toEgressGroup(egress string) []types.IpPermission {
	return []types.IpPermission{
		groupPair(80, "tcp", egress), groupPair(443, "tcp", egress),
		groupPair(53, "udp", egress), groupPair(53, "tcp", egress),
	}
}

// PrepareClaim creates the claim's two groups: the workload accepts 22 only
// from the cell agent and each expose port only from this claim's observer;
// the observer accepts its API port only from the cell agent. Neither group
// references itself, and neither keeps the default open egress (S-02). A
// failure part way removes what was made.
func (d *Driver) PrepareClaim(ctx context.Context, spec driver.ClaimNetworkSpec) (net driver.ClaimNetwork, err error) {
	ctx, cancel := context.WithTimeout(ctx, d.operationTimeout())
	defer cancel()
	if spec.ClaimID == "" || spec.OrgID == "" {
		return driver.ClaimNetwork{}, errors.New("awsec2: claim and org required")
	}
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.ClaimNetwork{}, err
	}
	for _, e := range spec.Expose {
		if e.Port < 1 || e.Port > 65535 || e.Port == 22 {
			return driver.ClaimNetwork{}, fmt.Errorf("awsec2: bad expose port %d", e.Port)
		}
	}
	defer func() {
		if err != nil {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), d.cleanupTimeout())
			defer cancel()
			if rerr := d.ReleaseClaim(cleanup, net); rerr != nil {
				err = errors.Join(err, driver.ErrResourceCleanupPending, fmt.Errorf("awsec2: cleanup: %w", rerr))
			}
			net = driver.ClaimNetwork{}
		}
	}()
	mk := func(role string) (string, error) {
		out, err := d.api.CreateSecurityGroup(ctx, &ec2.CreateSecurityGroupInput{
			GroupName:   aws.String(fmt.Sprintf("kodus-%s-%s", spec.ClaimID, role)),
			Description: aws.String("kodus claim " + spec.ClaimID + " " + role),
			VpcId:       aws.String(d.cfg.VPCID),
			TagSpecifications: []types.TagSpecification{{
				ResourceType: types.ResourceTypeSecurityGroup,
				Tags:         ec2Tags(d.claimTags(spec, role)),
			}},
		})
		if err != nil {
			return "", err
		}
		return aws.ToString(out.GroupId), nil
	}
	revokeDefault := func(id string) error {
		_, err := d.api.RevokeSecurityGroupEgress(ctx, &ec2.RevokeSecurityGroupEgressInput{GroupId: aws.String(id), IpPermissions: allEgress})
		return err
	}
	if net.WorkloadGroupID, err = mk("workload"); err != nil {
		return net, err
	}
	if err = revokeDefault(net.WorkloadGroupID); err != nil {
		return net, err
	}
	if net.ObserverGroupID, err = mk("observer"); err != nil {
		return net, err
	}
	if err = revokeDefault(net.ObserverGroupID); err != nil {
		return net, err
	}

	ingress := []types.IpPermission{groupPair(22, "tcp", d.cfg.CellAgentGroupID)}
	var observerEgress []types.IpPermission
	for _, e := range spec.Expose {
		ingress = append(ingress, groupPair(int32(e.Port), "tcp", net.ObserverGroupID))
		observerEgress = append(observerEgress, groupPair(int32(e.Port), "tcp", net.WorkloadGroupID))
	}
	if _, err = d.api.AuthorizeSecurityGroupIngress(ctx, &ec2.AuthorizeSecurityGroupIngressInput{GroupId: aws.String(net.WorkloadGroupID), IpPermissions: ingress}); err != nil {
		return net, err
	}
	if _, err = d.api.AuthorizeSecurityGroupEgress(ctx, &ec2.AuthorizeSecurityGroupEgressInput{GroupId: aws.String(net.WorkloadGroupID), IpPermissions: toEgressGroup(d.cfg.EgressGroupID)}); err != nil {
		return net, err
	}
	observerPort := spec.ObserverPort
	if observerPort == 0 {
		observerPort = 7443
	}
	if _, err = d.api.AuthorizeSecurityGroupIngress(ctx, &ec2.AuthorizeSecurityGroupIngressInput{GroupId: aws.String(net.ObserverGroupID), IpPermissions: []types.IpPermission{groupPair(int32(observerPort), "tcp", d.cfg.CellAgentGroupID)}}); err != nil {
		return net, err
	}
	observerEgress = append(observerEgress, toEgressGroup(d.cfg.EgressGroupID)...)
	if _, err = d.api.AuthorizeSecurityGroupEgress(ctx, &ec2.AuthorizeSecurityGroupEgressInput{GroupId: aws.String(net.ObserverGroupID), IpPermissions: observerEgress}); err != nil {
		return net, err
	}
	return net, nil
}

// ReleaseClaim deletes the claim's groups. They reference each other (the
// workload's ingress names the observer, the observer's egress names the
// workload), and EC2 refuses to delete a referenced group: their rules go
// first.
func (d *Driver) ReleaseClaim(ctx context.Context, net driver.ClaimNetwork) error {
	ctx, cancel := context.WithTimeout(ctx, d.operationTimeout())
	defer cancel()
	var ids []string
	for _, id := range []string{net.ObserverGroupID, net.WorkloadGroupID} {
		if id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	var errs []error
	out, err := d.api.DescribeSecurityGroups(ctx, &ec2.DescribeSecurityGroupsInput{GroupIds: ids})
	if err != nil {
		return err
	}
	for _, g := range out.SecurityGroups {
		if tagsOf(g.Tags)[driver.TagCell] != d.cfg.CellID {
			return fmt.Errorf("%w: security group %s", driver.ErrNotOwned, aws.ToString(g.GroupId))
		}
		if len(g.IpPermissions) > 0 {
			if _, err := d.api.RevokeSecurityGroupIngress(ctx, &ec2.RevokeSecurityGroupIngressInput{GroupId: g.GroupId, IpPermissions: g.IpPermissions}); err != nil {
				errs = append(errs, err)
			}
		}
		if len(g.IpPermissionsEgress) > 0 {
			if _, err := d.api.RevokeSecurityGroupEgress(ctx, &ec2.RevokeSecurityGroupEgressInput{GroupId: g.GroupId, IpPermissions: g.IpPermissionsEgress}); err != nil {
				errs = append(errs, err)
			}
		}
	}
	for _, id := range ids {
		if _, err := d.api.DeleteSecurityGroup(ctx, &ec2.DeleteSecurityGroupInput{GroupId: aws.String(id)}); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// claimGroup checks that the group is this cell's and this claim's: a spec
// naming another claim's group would put the VM where that claim's
// observer reaches it.
func (d *Driver) claimGroup(ctx context.Context, groupID, claimID, orgID string) error {
	out, err := d.api.DescribeSecurityGroups(ctx, &ec2.DescribeSecurityGroupsInput{GroupIds: []string{groupID}})
	if err != nil {
		return err
	}
	if len(out.SecurityGroups) != 1 {
		return fmt.Errorf("%w: security group %s not found", driver.ErrNotOwned, groupID)
	}
	tags := tagsOf(out.SecurityGroups[0].Tags)
	if tags[driver.TagCell] != d.cfg.CellID || tags[driver.TagClaim] != claimID || tags[driver.TagOrg] != orgID || aws.ToString(out.SecurityGroups[0].VpcId) != d.cfg.VPCID {
		return fmt.Errorf("%w: security group %s is not claim %s's", driver.ErrNotOwned, groupID, claimID)
	}
	return nil
}

func tagsOf(ts []types.Tag) map[string]string {
	out := map[string]string{}
	for _, t := range ts {
		out[aws.ToString(t.Key)] = aws.ToString(t.Value)
	}
	return out
}

// InstanceType picks a type for a neutral size.
func InstanceType(s driver.MachineSize) types.InstanceType {
	switch {
	case s.CPU <= 2 && s.MemoryGB <= 4:
		return types.InstanceTypeC7iLarge
	case s.CPU <= 2 && s.MemoryGB <= 8:
		return types.InstanceTypeM7iLarge
	case s.CPU <= 4 && s.MemoryGB <= 8:
		return types.InstanceTypeC7iXlarge
	case s.CPU <= 4 && s.MemoryGB <= 16:
		return types.InstanceTypeM7iXlarge
	case s.CPU <= 8 && s.MemoryGB <= 16:
		return types.InstanceTypeC7i2xlarge
	case s.CPU <= 8 && s.MemoryGB <= 32:
		return types.InstanceTypeM7i2xlarge
	}
	return types.InstanceTypeM7i4xlarge
}

// ErrWrongOrgKey: a disk is never encrypted with another org's key (S-11).
var ErrWrongOrgKey = errors.New("awsec2: KMS key does not belong to the claim's org")

func (d *Driver) Create(ctx context.Context, spec driver.MachineSpec) (driver.MachineRef, error) {
	ctx, cancel := context.WithTimeout(ctx, d.operationTimeout())
	defer cancel()
	if err := ctx.Err(); err != nil {
		return driver.MachineRef{}, err
	}
	if _, supplied := spec.Tags[tagOriginalRootVolume]; supplied {
		return driver.MachineRef{}, errors.New("awsec2: original root volume provenance is driver-owned")
	}
	if err := spec.ValidateFor(d.Capabilities()); err != nil {
		return driver.MachineRef{}, err
	}
	if spec.CellID != d.cfg.CellID {
		return driver.MachineRef{}, fmt.Errorf("awsec2: spec for cell %s, this is %s", spec.CellID, d.cfg.CellID)
	}
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.MachineRef{}, err
	}
	if err := d.claimGroup(ctx, spec.ClaimGroupID, spec.ClaimID, spec.OrgID); err != nil {
		return driver.MachineRef{}, err
	}
	orgKey, err := d.cfg.OrgKey(spec.OrgID)
	if err != nil {
		return driver.MachineRef{}, err
	}
	if orgKey != spec.KMSKeyRef {
		return driver.MachineRef{}, ErrWrongOrgKey
	}
	image, subnet := spec.ImageRef, d.cfg.WorkloadSubnetID
	if spec.Role == driver.RoleObserver {
		image, subnet = d.cfg.ObserverImageRef, d.cfg.ObserverSubnetID
	}
	if image == "" {
		return driver.MachineRef{}, errors.New("awsec2: image reference required")
	}
	disk := int32(spec.Size.DiskGB)
	if disk == 0 {
		disk = 30
	}
	tags := ec2Tags(spec.AllTags())
	in := &ec2.RunInstancesInput{
		ClientToken:  aws.String(launchToken(spec)),
		MinCount:     aws.Int32(1),
		MaxCount:     aws.Int32(1),
		ImageId:      aws.String(image),
		InstanceType: InstanceType(spec.Size),
		LaunchTemplate: &types.LaunchTemplateSpecification{
			LaunchTemplateId: aws.String(d.cfg.LaunchTemplateID),
			Version:          aws.String(d.cfg.LaunchTemplateVersion),
		},
		SubnetId:         aws.String(subnet),
		SecurityGroupIds: []string{spec.ClaimGroupID},
		// The template already has it off; saying it again costs nothing.
		MetadataOptions: &types.InstanceMetadataOptionsRequest{
			HttpEndpoint:     types.InstanceMetadataEndpointStateDisabled,
			HttpProtocolIpv6: types.InstanceMetadataProtocolStateDisabled,
		},
		BlockDeviceMappings: []types.BlockDeviceMapping{{
			DeviceName: aws.String("/dev/xvda"),
			Ebs: &types.EbsBlockDevice{
				Encrypted:           aws.Bool(true),
				KmsKeyId:            aws.String(orgKey),
				VolumeSize:          aws.Int32(disk),
				VolumeType:          types.VolumeTypeGp3,
				DeleteOnTermination: aws.Bool(true),
			},
		}},
		InstanceInitiatedShutdownBehavior: types.ShutdownBehaviorTerminate,
		TagSpecifications: []types.TagSpecification{
			{ResourceType: types.ResourceTypeInstance, Tags: tags},
			{ResourceType: types.ResourceTypeVolume, Tags: tags},
		},
	}
	if spec.UserData != "" {
		in.UserData = aws.String(base64.StdEncoding.EncodeToString([]byte(spec.UserData)))
	}
	if d.cfg.Hibernate && spec.Role != driver.RoleObserver {
		in.HibernationOptions = &types.HibernationOptionsRequest{Configured: aws.Bool(true)}
	}
	out, err := d.api.RunInstances(ctx, in)
	if err != nil {
		var apiErr smithy.APIError
		if errors.As(err, &apiErr) && apiErr.ErrorFault() == smithy.FaultClient {
			return driver.MachineRef{}, fmt.Errorf("awsec2: launch: %w", err)
		}
		return driver.MachineRef{}, errors.Join(fmt.Errorf("awsec2: launch: %w", err), d.cleanupLaunchByToken(ctx, spec, image, aws.ToString(in.ClientToken)))
	}
	if out == nil || len(out.Instances) != 1 || aws.ToString(out.Instances[0].InstanceId) == "" {
		// A successful launch with an incomplete response may have created resources.
		// Never pretend cleanup was proved without an instance id.
		return driver.MachineRef{}, errors.Join(errors.New("awsec2: invalid launch result"), d.cleanupLaunchByToken(ctx, spec, image, aws.ToString(in.ClientToken)))
	}
	ref := driver.MachineRef{DriverRef: aws.ToString(out.Instances[0].InstanceId), ImageID: image, Tags: spec.AllTags()}
	ready, err := d.waitRunning(ctx, ref, types.InstanceStateNamePending)
	if err == nil {
		ready, err = d.recordOriginalRoot(ctx, ref, ready)
	}
	if err != nil {
		return driver.MachineRef{}, errors.Join(err, d.cleanupCreated(ctx, ref))
	}
	return refOf(*ready), nil
}

func refOf(i types.Instance) driver.MachineRef {
	tags := tagsOf(i.Tags)
	return driver.MachineRef{
		MachineID:      aws.ToString(i.InstanceId),
		DriverRef:      aws.ToString(i.InstanceId),
		PrivateAddress: aws.ToString(i.PrivateIpAddress),
		ImageID:        aws.ToString(i.ImageId),
		Tags:           tags,
	}
}

// instance is the machine as EC2 describes it now, including terminal state;
// nil means not visible, which alone does not prove a fresh launch is gone.
func (d *Driver) instance(ctx context.Context, id string) (*types.Instance, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	out, err := d.api.DescribeInstances(ctx, &ec2.DescribeInstancesInput{InstanceIds: []string{id}})
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) && apiErr.ErrorCode() == "InvalidInstanceID.NotFound" {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if out == nil {
		return nil, errors.New("awsec2: empty describe result")
	}
	for _, r := range out.Reservations {
		for _, i := range r.Instances {
			if aws.ToString(i.InstanceId) == id {
				return &i, nil
			}
		}
	}
	return nil, nil
}

// owned is the live instance behind ref when it is this cell's. The cell's
// IAM role already limits lifecycle calls to its own tag; the driver checks
// too, so a broader role an operator hands it changes nothing.
func (d *Driver) owned(ctx context.Context, ref driver.MachineRef) (*types.Instance, error) {
	i, err := d.actualOwned(ctx, ref)
	if err == nil && i != nil && i.State != nil && i.State.Name == types.InstanceStateNameTerminated {
		return nil, nil
	}
	return i, err
}

// actualOwned preserves terminal states for launch failure and cleanup checks.
func (d *Driver) actualOwned(ctx context.Context, ref driver.MachineRef) (*types.Instance, error) {
	i, err := d.instance(ctx, ref.DriverRef)
	if err != nil || i == nil {
		return nil, err
	}
	if err := d.checkScope(i, ref); err != nil {
		return nil, err
	}
	return i, nil
}

// live is owned for an instance that must exist.
func (d *Driver) live(ctx context.Context, ref driver.MachineRef) (*types.Instance, error) {
	i, err := d.owned(ctx, ref)
	if err == nil && i == nil {
		err = fmt.Errorf("%w: instance %s is gone", driver.ErrNotOwned, ref.DriverRef)
	}
	return i, err
}

// List asks EC2 for this cell's instances only: a selector naming another
// cell finds nothing.
func (d *Driver) List(ctx context.Context, selector map[string]string) ([]driver.MachineRef, error) {
	if cell, ok := selector[driver.TagCell]; ok && cell != d.cfg.CellID {
		return nil, nil
	}
	selector = maps.Clone(selector)
	if selector == nil {
		selector = map[string]string{}
	}
	selector[driver.TagCell] = d.cfg.CellID
	filters := []types.Filter{{
		Name:   aws.String("instance-state-name"),
		Values: []string{"pending", "running", "stopping", "stopped"},
	}}
	for _, k := range sortedKeys(selector) {
		filters = append(filters, types.Filter{Name: aws.String("tag:" + k), Values: []string{selector[k]}})
	}
	var out []driver.MachineRef
	var token *string
	for {
		page, err := d.api.DescribeInstances(ctx, &ec2.DescribeInstancesInput{Filters: filters, NextToken: token})
		if err != nil {
			return nil, err
		}
		for _, r := range page.Reservations {
			for _, i := range r.Instances {
				ref := refOf(i)
				// Filters are the cloud's; the selector is checked again here.
				if driver.Matches(ref.Tags, selector) {
					out = append(out, ref)
				}
			}
		}
		if page.NextToken == nil || *page.NextToken == "" {
			return out, nil
		}
		token = page.NextToken
	}
}

// tag updates mutable metadata; provenance and the absolute ceiling cannot move.
func (d *Driver) tag(ctx context.Context, id string, tags map[string]string) error {
	for k := range tags {
		if k == tagOriginalRootVolume {
			return errors.New("awsec2: original root volume provenance is immutable")
		}
		if k == driver.TagHardExpires {
			return driver.ErrHardExpiresImmutable
		}
	}
	_, err := d.api.CreateTags(ctx, &ec2.CreateTagsInput{Resources: []string{id}, Tags: ec2Tags(tags)})
	return err
}

// SetExpiry moves kodus:expires on this cell's instance, held under the
// ceiling the instance carries (not the one the caller's ref says).
func (d *Driver) SetExpiry(ctx context.Context, ref driver.MachineRef, at time.Time) error {
	i, err := d.live(ctx, ref)
	if err != nil {
		return err
	}
	hard := driver.ParseExpiry(tagsOf(i.Tags), driver.TagHardExpires)
	if hard.IsZero() {
		return fmt.Errorf("awsec2: instance %s has no ceiling", ref.DriverRef)
	}
	if at.After(hard) {
		at = hard
	}
	return d.tag(ctx, ref.DriverRef, map[string]string{driver.TagExpires: driver.FormatTime(at)})
}

var _ driver.MachineDriver = (*Driver)(nil)

// Reaper is the aws-ec2 driver cut down to what the reaper's role allows
// (iam/reaper-role.json): list and destroy.
type Reaper struct{ d *Driver }

func (r *Reaper) List(ctx context.Context, selector map[string]string) ([]driver.MachineRef, error) {
	return r.d.List(ctx, selector)
}

func (r *Reaper) Destroy(ctx context.Context, ref driver.MachineRef) error {
	return r.d.Destroy(ctx, ref)
}

// NewForReaper returns the reaper's driver: List and Destroy only, so
// nothing can call what its role cannot do (and Create, with no org key,
// would not run).
func NewForReaper(api EC2API, cellID string) *Reaper {
	return &Reaper{d: &Driver{api: api, cfg: Config{CellID: cellID}}}
}
