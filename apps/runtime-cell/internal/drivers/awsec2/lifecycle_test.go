package awsec2

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

type pendingLaunch struct{ *mockEC2 }

// A successful StartInstances can precede DescribeInstances observing the
// transition. Resume used to reject that first stale stopped observation.
func TestResumeWaitsPastStaleStoppedObservation(t *testing.T) {
	m := &mockEC2{}
	ref := plantResetMachine(m, "i-resume")
	d := newDriver(t, m)
	api := &observedEC2{mockEC2: m, describeHook: func(_ context.Context, _ *ec2.DescribeInstancesInput, out *ec2.DescribeInstancesOutput, n int) (*ec2.DescribeInstancesOutput, error) {
		eachInstance(out, func(i *types.Instance) {
			if n <= 2 {
				i.State = &types.InstanceState{Name: types.InstanceStateNameStopped}
			} else if n == 3 {
				i.State = &types.InstanceState{Name: types.InstanceStateNamePending}
			}
		})
		return out, nil
	}}
	d.api = api
	if err := d.Resume(context.Background(), ref); err != nil {
		t.Fatalf("accepted start failed on stale stopped state: %v", err)
	}
	if api.describes != 4 {
		t.Fatalf("resume did not wait for running: %d observations", api.describes)
	}
}

func (m pendingLaunch) RunInstances(ctx context.Context, in *ec2.RunInstancesInput, opts ...func(*ec2.Options)) (*ec2.RunInstancesOutput, error) {
	out, err := m.mockEC2.RunInstances(ctx, in, opts...)
	if err == nil {
		out.Instances[0].State = &types.InstanceState{Name: types.InstanceStateNamePending}
		out.Instances[0].PrivateIpAddress = nil
	}
	return out, err
}

// RunInstances used to return a pending machine without an address, before
// DescribeInstances had confirmed that it was ready and belonged to this claim.
func TestCreateReturnsAuthoritativeRunningInstance(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	d.api = pendingLaunch{m}
	ref, err := d.Create(context.Background(), spec(driver.RoleWorkload))
	if err != nil {
		t.Fatal(err)
	}
	if ref.PrivateAddress != "10.0.3.10" || len(m.describe) == 0 {
		t.Fatalf("not described ready: ref=%+v describes=%d", ref, len(m.describe))
	}
}

// Reset used to trust the caller's tags and reset a different org's actual
// instance if the supplied snapshot happened to carry the caller's org tag.
func TestResetRefusesForeignActualTarget(t *testing.T) {
	m := &mockEC2{snapshots: map[string]types.Snapshot{"snap-1": {SnapshotId: aws.String("snap-1"), VolumeId: aws.String("vol-original"), Tags: ec2Tags(map[string]string{driver.TagCell: "cell-1", driver.TagOrg: "org-a"})}}}
	d := newDriver(t, m)
	m.plant(types.Instance{InstanceId: aws.String("i-target"), State: &types.InstanceState{Name: types.InstanceStateNameRunning}, Tags: ec2Tags(map[string]string{driver.TagCell: "cell-1", driver.TagOrg: "org-b"})})
	err := d.Reset(context.Background(), driver.MachineRef{DriverRef: "i-target", Tags: map[string]string{driver.TagOrg: "org-a"}}, driver.SnapshotRef{Kind: "disk", Ref: "snap-1"})
	if !errors.Is(err, driver.ErrNotOwned) {
		t.Fatalf("foreign target reset: %v", err)
	}
}

func plantResetMachine(m *mockEC2, id string) driver.MachineRef {
	tags := map[string]string{driver.TagCell: "cell-1", driver.TagOrg: "org-a", driver.TagClaim: "claim-1", tagOriginalRootVolume: "vol-original"}
	m.plant(types.Instance{InstanceId: aws.String(id), ImageId: aws.String("ami-workload"), PrivateIpAddress: aws.String("10.0.3.10"), State: &types.InstanceState{Name: types.InstanceStateNameRunning}, Tags: ec2Tags(tags), RootDeviceName: aws.String("/dev/xvda"), BlockDeviceMappings: []types.InstanceBlockDeviceMapping{{DeviceName: aws.String("/dev/xvda"), Ebs: &types.EbsInstanceBlockDevice{VolumeId: aws.String("vol-original")}}}})
	return driver.MachineRef{MachineID: id, DriverRef: id, ImageID: "ami-workload", Tags: tags}
}
func resetSnapshot(id, volume, cell, org string) types.Snapshot {
	return types.Snapshot{SnapshotId: aws.String(id), VolumeId: aws.String(volume), State: types.SnapshotStateCompleted, Tags: ec2Tags(map[string]string{driver.TagCell: cell, driver.TagOrg: org})}
}

// The EC2 client must be able to retry an identical launch without allocating
// a second VM. Previously the launch had no idempotency token.
func TestCreateLaunchTokenStablePerClaimRole(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	s := spec(driver.RoleWorkload)
	first, err := d.Create(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	second, err := d.Create(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	if aws.ToString(m.run[0].ClientToken) == "" || aws.ToString(m.run[0].ClientToken) != aws.ToString(m.run[1].ClientToken) {
		t.Fatal("launch token missing or unstable")
	}
	if first.DriverRef != second.DriverRef || len(m.instances) != 1 {
		t.Fatalf("retry allocated duplicate: %s %s count=%d", first.DriverRef, second.DriverRef, len(m.instances))
	}
	s.Role = driver.RoleObserver
	if _, err = d.Create(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if aws.ToString(m.run[0].ClientToken) == aws.ToString(m.run[2].ClientToken) {
		t.Fatal("workload and observer share launch identity")
	}
	if len(m.tags) != 2 {
		t.Fatalf("retry overwrote provenance: %d writes", len(m.tags))
	}
}

type observedEC2 struct {
	*mockEC2
	describeHook  func(context.Context, *ec2.DescribeInstancesInput, *ec2.DescribeInstancesOutput, int) (*ec2.DescribeInstancesOutput, error)
	taskHook      func(*ec2.DescribeReplaceRootVolumeTasksInput, *ec2.DescribeReplaceRootVolumeTasksOutput, int) (*ec2.DescribeReplaceRootVolumeTasksOutput, error)
	describes     int
	taskDescribes int
}

func (m *observedEC2) DescribeInstances(ctx context.Context, in *ec2.DescribeInstancesInput, opts ...func(*ec2.Options)) (*ec2.DescribeInstancesOutput, error) {
	out, err := m.mockEC2.DescribeInstances(ctx, in, opts...)
	m.describes++
	if err != nil || m.describeHook == nil {
		return out, err
	}
	return m.describeHook(ctx, in, out, m.describes)
}
func (m *observedEC2) DescribeReplaceRootVolumeTasks(ctx context.Context, in *ec2.DescribeReplaceRootVolumeTasksInput, opts ...func(*ec2.Options)) (*ec2.DescribeReplaceRootVolumeTasksOutput, error) {
	out, err := m.mockEC2.DescribeReplaceRootVolumeTasks(ctx, in, opts...)
	m.taskDescribes++
	if err != nil || m.taskHook == nil {
		return out, err
	}
	return m.taskHook(in, out, m.taskDescribes)
}
func eachInstance(out *ec2.DescribeInstancesOutput, change func(*types.Instance)) {
	for r := range out.Reservations {
		for i := range out.Reservations[r].Instances {
			change(&out.Reservations[r].Instances[i])
		}
	}
}

func TestCreatePollsPendingAndMissingAddress(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	api := &observedEC2{mockEC2: m, describeHook: func(_ context.Context, _ *ec2.DescribeInstancesInput, out *ec2.DescribeInstancesOutput, n int) (*ec2.DescribeInstancesOutput, error) {
		eachInstance(out, func(i *types.Instance) {
			if n == 1 {
				i.State = &types.InstanceState{Name: types.InstanceStateNamePending}
				i.PrivateIpAddress = nil
			}
			if n == 2 {
				i.PrivateIpAddress = nil
			}
		})
		return out, nil
	}}
	d.api = api
	ref, err := d.Create(context.Background(), spec(driver.RoleWorkload))
	if err != nil {
		t.Fatal(err)
	}
	if api.describes < 4 || ref.PrivateAddress == "" {
		t.Fatalf("not awaited: describes=%d ref=%+v", api.describes, ref)
	}
}

func TestCreateTimeoutAndCancellationCleanOwnedVM(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelled), func(t *testing.T) {
			m := &mockEC2{}
			d := newDriver(t, m)
			d.cfg.OperationTimeout = 3 * time.Second
			d.cfg.PollInterval = time.Second
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			api := &observedEC2{mockEC2: m, describeHook: func(_ context.Context, _ *ec2.DescribeInstancesInput, out *ec2.DescribeInstancesOutput, n int) (*ec2.DescribeInstancesOutput, error) {
				if cancelled && n == 1 {
					cancel()
				}
				eachInstance(out, func(i *types.Instance) {
					if i.State.Name != types.InstanceStateNameTerminated {
						i.State = &types.InstanceState{Name: types.InstanceStateNamePending}
						i.PrivateIpAddress = nil
					}
				})
				return out, nil
			}}
			d.api = api
			ref, err := d.Create(ctx, spec(driver.RoleWorkload))
			want := context.DeadlineExceeded
			if cancelled {
				want = context.Canceled
			}
			if !errors.Is(err, want) || ref.DriverRef != "" {
				t.Fatalf("ref=%+v err=%v", ref, err)
			}
			if len(m.terminate) != 1 || errors.Is(err, driver.ErrResourceCleanupPending) {
				t.Fatalf("cleanup not confirmed: calls=%d err=%v", len(m.terminate), err)
			}
		})
	}
}

func TestCreateRefusesAuthoritativeScopeMismatch(t *testing.T) {
	for _, field := range []string{driver.TagCell, driver.TagOrg, driver.TagClaim, "image"} {
		t.Run(field, func(t *testing.T) {
			m := &mockEC2{}
			d := newDriver(t, m)
			d.api = &observedEC2{mockEC2: m, describeHook: func(_ context.Context, _ *ec2.DescribeInstancesInput, out *ec2.DescribeInstancesOutput, _ int) (*ec2.DescribeInstancesOutput, error) {
				eachInstance(out, func(i *types.Instance) {
					if field == "image" {
						i.ImageId = aws.String("ami-foreign")
					} else {
						tags := tagsOf(i.Tags)
						tags[field] = "foreign"
						i.Tags = ec2Tags(tags)
					}
				})
				return out, nil
			}}
			if _, err := d.Create(context.Background(), spec(driver.RoleWorkload)); !errors.Is(err, driver.ErrNotOwned) {
				t.Fatalf("scope accepted: %v", err)
			}
			if len(m.terminate) != 0 {
				t.Fatal("terminated foreign machine")
			}
		})
	}
}

func TestCreateCannotForgeOriginalRootTag(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	s := spec(driver.RoleWorkload)
	s.Tags = map[string]string{tagOriginalRootVolume: "vol-forged"}
	if _, err := d.Create(context.Background(), s); err == nil || len(m.run) != 0 {
		t.Fatalf("forged provenance accepted: %v", err)
	}
}

func TestCreateReportsUnconfirmedCleanup(t *testing.T) {
	m := &mockEC2{failOn: map[string]error{"TerminateInstances": errors.New("denied")}}
	d := newDriver(t, m)
	d.cfg.OperationTimeout = time.Second
	d.api = &observedEC2{mockEC2: m, describeHook: func(_ context.Context, _ *ec2.DescribeInstancesInput, out *ec2.DescribeInstancesOutput, _ int) (*ec2.DescribeInstancesOutput, error) {
		eachInstance(out, func(i *types.Instance) { i.PrivateIpAddress = nil })
		return out, nil
	}}
	if _, err := d.Create(context.Background(), spec(driver.RoleWorkload)); !errors.Is(err, driver.ErrResourceCleanupPending) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cleanup silently forgotten: %v", err)
	}
}

func TestResetRequiresOriginalVolumeAndImmutableProvenance(t *testing.T) {
	for _, which := range []string{"other_volume", "missing_provenance", "wrong_org", "wrong_cell", "pending_snapshot", "no_root"} {
		t.Run(which, func(t *testing.T) {
			m := &mockEC2{}
			d := newDriver(t, m)
			ref := plantResetMachine(m, "i-1")
			snap := resetSnapshot("snap-1", "vol-original", "cell-1", "org-a")
			switch which {
			case "other_volume":
				snap.VolumeId = aws.String("vol-foreign")
			case "missing_provenance":
				actual := m.instances[ref.DriverRef]
				tags := tagsOf(actual.Tags)
				delete(tags, tagOriginalRootVolume)
				actual.Tags = ec2Tags(tags)
			case "wrong_org":
				snap.Tags = ec2Tags(map[string]string{driver.TagCell: "cell-1", driver.TagOrg: "org-b"})
			case "wrong_cell":
				snap.Tags = ec2Tags(map[string]string{driver.TagCell: "cell-2", driver.TagOrg: "org-a"})
			case "pending_snapshot":
				snap.State = types.SnapshotStatePending
			case "no_root":
				m.instances[ref.DriverRef].RootDeviceName = nil
			}
			m.snapshots = map[string]types.Snapshot{"snap-1": snap}
			if err := d.Reset(context.Background(), ref, driver.SnapshotRef{Kind: "disk", Ref: "snap-1"}); err == nil {
				t.Fatal("invalid snapshot/target accepted")
			}
			if len(m.replace) != 0 {
				t.Fatal("replacement launched")
			}
		})
	}
}

func TestResetRepeatedRoundsUseOriginalVolume(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	ref := plantResetMachine(m, "i-1")
	m.snapshots = map[string]types.Snapshot{"snap-1": resetSnapshot("snap-1", "vol-original", "cell-1", "org-a")}
	for range 2 {
		if err := d.Reset(context.Background(), ref, driver.SnapshotRef{Kind: "disk", Ref: "snap-1"}); err != nil {
			t.Fatal(err)
		}
	}
	if len(m.replace) != 2 {
		t.Fatal("missing replacement")
	}
	for _, in := range m.replace {
		if !aws.ToBool(in.DeleteReplacedRootVolume) || aws.ToString(in.ClientToken) == "" {
			t.Fatal("leaking root or non-idempotent SDK retry")
		}
	}
	if aws.ToString(m.replace[0].ClientToken) == aws.ToString(m.replace[1].ClientToken) {
		t.Fatal("independent rounds collapsed into one reset")
	}
}

func TestResetWaitsForTaskAndNeverAcceptsFailedOrMissingTask(t *testing.T) {
	for _, state := range []types.ReplaceRootVolumeTaskState{types.ReplaceRootVolumeTaskStateSucceeded, types.ReplaceRootVolumeTaskStateFailed, types.ReplaceRootVolumeTaskState("failed-detached"), types.ReplaceRootVolumeTaskState("unknown"), types.ReplaceRootVolumeTaskStatePending} {
		t.Run(string(state), func(t *testing.T) {
			m := &mockEC2{}
			d := newDriver(t, m)
			d.cfg.OperationTimeout = 3 * time.Second
			d.cfg.PollInterval = time.Second
			ref := plantResetMachine(m, "i-1")
			m.snapshots = map[string]types.Snapshot{"snap-1": resetSnapshot("snap-1", "vol-original", "cell-1", "org-a")}
			api := &observedEC2{mockEC2: m, taskHook: func(_ *ec2.DescribeReplaceRootVolumeTasksInput, out *ec2.DescribeReplaceRootVolumeTasksOutput, n int) (*ec2.DescribeReplaceRootVolumeTasksOutput, error) {
				if n == 1 {
					out.ReplaceRootVolumeTasks[0].TaskState = types.ReplaceRootVolumeTaskStateInProgress
				} else {
					out.ReplaceRootVolumeTasks[0].TaskState = state
				}
				return out, nil
			}}
			d.api = api
			err := d.Reset(context.Background(), ref, driver.SnapshotRef{Kind: "disk", Ref: "snap-1"})
			if (err == nil) != (state == types.ReplaceRootVolumeTaskStateSucceeded) {
				t.Fatalf("state=%s err=%v", state, err)
			}
			if state == types.ReplaceRootVolumeTaskStatePending && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal(err)
			}
			if api.taskDescribes < 2 {
				t.Fatal("did not wait for completion")
			}
		})
	}
}

func TestResetRefusesTaskForAnotherInstance(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	ref := plantResetMachine(m, "i-1")
	m.snapshots = map[string]types.Snapshot{"snap-1": resetSnapshot("snap-1", "vol-original", "cell-1", "org-a")}
	d.api = &observedEC2{mockEC2: m, taskHook: func(_ *ec2.DescribeReplaceRootVolumeTasksInput, out *ec2.DescribeReplaceRootVolumeTasksOutput, _ int) (*ec2.DescribeReplaceRootVolumeTasksOutput, error) {
		out.ReplaceRootVolumeTasks[0].InstanceId = aws.String("i-other")
		return out, nil
	}}
	if err := d.Reset(context.Background(), ref, driver.SnapshotRef{Kind: "disk", Ref: "snap-1"}); !errors.Is(err, driver.ErrNotOwned) {
		t.Fatal(err)
	}
}

func TestResumeWaitsForRunningAndAddress(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	ref := plantResetMachine(m, "i-1")
	m.instances[ref.DriverRef].State = &types.InstanceState{Name: types.InstanceStateNameStopped}
	api := &observedEC2{mockEC2: m, describeHook: func(_ context.Context, _ *ec2.DescribeInstancesInput, out *ec2.DescribeInstancesOutput, n int) (*ec2.DescribeInstancesOutput, error) {
		if n == 2 {
			eachInstance(out, func(i *types.Instance) { i.PrivateIpAddress = nil })
		}
		return out, nil
	}}
	d.api = api
	if err := d.Resume(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	if api.describes != 3 {
		t.Fatalf("resume returned before address: %d describes", api.describes)
	}
}

// Cancellation while the cloud is accepting RunInstances used to return an
// ordinary error and leave an allocated instance outside the claim cleanup.
type lostLaunch struct {
	*mockEC2
	cancel context.CancelFunc
}

func (m lostLaunch) RunInstances(ctx context.Context, in *ec2.RunInstancesInput, opts ...func(*ec2.Options)) (*ec2.RunInstancesOutput, error) {
	if _, err := m.mockEC2.RunInstances(ctx, in, opts...); err != nil {
		return nil, err
	}
	m.cancel()
	return nil, context.Canceled
}
func TestCreateLostLaunchResponseFindsAndCleansByClientToken(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	d.api = lostLaunch{m, cancel}
	ref, err := d.Create(ctx, spec(driver.RoleWorkload))
	if !errors.Is(err, context.Canceled) || ref.DriverRef != "" {
		t.Fatalf("ref=%+v err=%v", ref, err)
	}
	if len(m.terminate) != 1 || errors.Is(err, driver.ErrResourceCleanupPending) {
		t.Fatalf("allocated launch forgotten: terminated=%d err=%v", len(m.terminate), err)
	}
}
func TestCancelledCreateNeverLaunches(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := d.Create(ctx, spec(driver.RoleWorkload)); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if len(m.run) != 0 {
		t.Fatal("already cancelled request allocated a VM")
	}
}

type provenanceRace struct {
	*mockEC2
	different bool
}

func (m provenanceRace) CreateTags(_ context.Context, in *ec2.CreateTagsInput, _ ...func(*ec2.Options)) (*ec2.CreateTagsOutput, error) {
	for _, tag := range in.Tags {
		if aws.ToString(tag.Key) == tagOriginalRootVolume {
			actual := m.instances[in.Resources[0]]
			volume := aws.ToString(tag.Value)
			if m.different {
				volume = "vol-foreign"
			}
			tags := tagsOf(actual.Tags)
			tags[tagOriginalRootVolume] = volume
			actual.Tags = ec2Tags(tags)
			return nil, errors.New("immutable tag already written")
		}
	}
	return nil, errors.New("unexpected tag write")
}
func TestCreateConcurrentProvenanceWriteMustReadBackSameRoot(t *testing.T) {
	for _, different := range []bool{false, true} {
		t.Run(fmt.Sprint(different), func(t *testing.T) {
			m := &mockEC2{}
			d := newDriver(t, m)
			d.api = provenanceRace{m, different}
			ref, err := d.Create(context.Background(), spec(driver.RoleWorkload))
			if different {
				if !errors.Is(err, driver.ErrNotOwned) || ref.DriverRef != "" || len(m.terminate) != 1 {
					t.Fatalf("foreign root accepted: ref=%+v err=%v", ref, err)
				}
			} else if err != nil || ref.Tags[tagOriginalRootVolume] == "" {
				t.Fatalf("identical first-write race failed: %v", err)
			}
		})
	}
}

func TestCreateRetryPreservesRootProvenanceAfterReset(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	s := spec(driver.RoleWorkload)
	ref, err := d.Create(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	original := ref.Tags[tagOriginalRootVolume]
	m.instances[ref.DriverRef].BlockDeviceMappings = []types.InstanceBlockDeviceMapping{{DeviceName: aws.String("/dev/xvda"), Ebs: &types.EbsInstanceBlockDevice{VolumeId: aws.String("vol-replaced")}}}
	retried, err := d.Create(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	if retried.DriverRef != ref.DriverRef || retried.Tags[tagOriginalRootVolume] != original || len(m.tags) != 1 {
		t.Fatal("retry rewrote original root provenance")
	}
}

func TestResetTaskCancellationDoesNotReportSuccess(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	ref := plantResetMachine(m, "i-1")
	m.snapshots = map[string]types.Snapshot{"snap-1": resetSnapshot("snap-1", "vol-original", "cell-1", "org-a")}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	d.api = &observedEC2{mockEC2: m, taskHook: func(_ *ec2.DescribeReplaceRootVolumeTasksInput, out *ec2.DescribeReplaceRootVolumeTasksOutput, _ int) (*ec2.DescribeReplaceRootVolumeTasksOutput, error) {
		cancel()
		return out, nil
	}}
	if err := d.Reset(ctx, ref, driver.SnapshotRef{Kind: "disk", Ref: "snap-1"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled reset reports success: %v", err)
	}
}

func TestSuspendAndDestroyWaitForPhysicalCompletion(t *testing.T) {
	for _, operation := range []string{"suspend", "destroy"} {
		t.Run(operation, func(t *testing.T) {
			m := &mockEC2{}
			d := newDriver(t, m)
			ref := plantResetMachine(m, "i-1")
			api := &observedEC2{mockEC2: m, describeHook: func(_ context.Context, _ *ec2.DescribeInstancesInput, out *ec2.DescribeInstancesOutput, n int) (*ec2.DescribeInstancesOutput, error) {
				if n == 2 {
					eachInstance(out, func(i *types.Instance) { i.State = &types.InstanceState{Name: types.InstanceStateNameStopping} })
				}
				return out, nil
			}}
			d.api = api
			var err error
			if operation == "suspend" {
				err = d.Suspend(context.Background(), ref, driver.SuspendStop)
			} else {
				err = d.Destroy(context.Background(), ref)
			}
			if err != nil {
				t.Fatal(err)
			}
			if api.describes < 3 {
				t.Fatalf("%s returned after API accepted, without waiting", operation)
			}
		})
	}
}

// A terminal launch failure is already physically gone, not an unresolved
// orphan. Earlier polling discarded the terminated state and timed out instead.
func TestCreateTerminalInstanceFailsWithoutPendingCleanup(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	api := &observedEC2{mockEC2: m, describeHook: func(_ context.Context, _ *ec2.DescribeInstancesInput, out *ec2.DescribeInstancesOutput, _ int) (*ec2.DescribeInstancesOutput, error) {
		eachInstance(out, func(i *types.Instance) { i.State = &types.InstanceState{Name: types.InstanceStateNameTerminated} })
		return out, nil
	}}
	d.api = api
	if _, err := d.Create(context.Background(), spec(driver.RoleWorkload)); err == nil || errors.Is(err, driver.ErrResourceCleanupPending) || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("terminal launch not settled: %v", err)
	}
	if len(m.terminate) != 0 || api.describes > 3 {
		t.Fatalf("terminated machine was mutated or polled indefinitely: terminate=%d describes=%d", len(m.terminate), api.describes)
	}
}

func TestResetSuccessTaskWithoutNewRootIsNotReady(t *testing.T) {
	m := &mockEC2{}
	d := newDriver(t, m)
	d.cfg.OperationTimeout = 3 * time.Second
	d.cfg.PollInterval = time.Second
	ref := plantResetMachine(m, "i-1")
	m.snapshots = map[string]types.Snapshot{"snap-1": resetSnapshot("snap-1", "vol-original", "cell-1", "org-a")}
	d.api = &observedEC2{mockEC2: m, taskHook: func(_ *ec2.DescribeReplaceRootVolumeTasksInput, out *ec2.DescribeReplaceRootVolumeTasksOutput, _ int) (*ec2.DescribeReplaceRootVolumeTasksOutput, error) {
		m.instances[ref.DriverRef].BlockDeviceMappings = []types.InstanceBlockDeviceMapping{{DeviceName: aws.String("/dev/xvda"), Ebs: &types.EbsInstanceBlockDevice{VolumeId: aws.String("vol-original")}}}
		return out, nil
	}}
	if err := d.Reset(context.Background(), ref, driver.SnapshotRef{Kind: "disk", Ref: "snap-1"}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("reset accepted stale root: %v", err)
	}
}
