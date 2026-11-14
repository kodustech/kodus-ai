package awsec2

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// ErrComposeResetInCell: compose volumes are reset by the cell agent over the
// transport; only a disk snapshot is a driver operation.
var ErrComposeResetInCell = errors.New("awsec2: compose_volumes reset runs in the cell agent")

func (d *Driver) Reset(ctx context.Context, ref driver.MachineRef, snap driver.SnapshotRef) error {
	if snap.Kind != "disk" {
		return ErrComposeResetInCell
	}
	ctx, cancel := context.WithTimeout(ctx, d.operationTimeout())
	defer cancel()
	target, err := d.live(ctx, ref)
	if err != nil {
		return err
	}
	tags := tagsOf(target.Tags)
	if tags[driver.TagOrg] == "" || tags[driver.TagClaim] == "" || ref.Tags[driver.TagClaim] != tags[driver.TagClaim] || ref.Tags[driver.TagOrg] != tags[driver.TagOrg] {
		return fmt.Errorf("%w: reset target %s requires actual org and claim", driver.ErrNotOwned, ref.DriverRef)
	}
	if target.State == nil || target.State.Name != types.InstanceStateNameRunning {
		return fmt.Errorf("awsec2: reset target %s is not running", ref.DriverRef)
	}
	current, err := rootVolume(target)
	if err != nil {
		return err
	}
	original := tags[tagOriginalRootVolume]
	if original == "" {
		return fmt.Errorf("%w: reset target %s has no original root provenance", driver.ErrNotOwned, ref.DriverRef)
	}
	out, err := d.api.DescribeSnapshots(ctx, &ec2.DescribeSnapshotsInput{SnapshotIds: []string{snap.Ref}})
	if err != nil {
		return fmt.Errorf("awsec2: describe reset snapshot: %w", err)
	}
	if out == nil || len(out.Snapshots) != 1 {
		return fmt.Errorf("%w: snapshot %s not found", driver.ErrNotOwned, snap.Ref)
	}
	snapshot := out.Snapshots[0]
	st := tagsOf(snapshot.Tags)
	if aws.ToString(snapshot.SnapshotId) != snap.Ref || aws.ToString(snapshot.VolumeId) != original || st[driver.TagOrg] != tags[driver.TagOrg] || st[driver.TagCell] != d.cfg.CellID {
		return fmt.Errorf("%w: snapshot %s is not target %s's original root", driver.ErrNotOwned, snap.Ref, ref.DriverRef)
	}
	if snapshot.State != types.SnapshotStateCompleted {
		return fmt.Errorf("awsec2: snapshot %s is not completed", snap.Ref)
	}
	token := make([]byte, 32)
	if _, err = rand.Read(token); err != nil {
		return fmt.Errorf("awsec2: reset token: %w", err)
	}
	task, err := d.api.CreateReplaceRootVolumeTask(ctx, &ec2.CreateReplaceRootVolumeTaskInput{
		InstanceId: aws.String(ref.DriverRef), SnapshotId: aws.String(snap.Ref), DeleteReplacedRootVolume: aws.Bool(true), ClientToken: aws.String(hex.EncodeToString(token)),
		TagSpecifications: []types.TagSpecification{{ResourceType: types.ResourceTypeReplaceRootVolumeTask, Tags: ec2Tags(map[string]string{driver.TagCell: d.cfg.CellID, driver.TagOrg: tags[driver.TagOrg], driver.TagClaim: tags[driver.TagClaim]})}},
	})
	if err != nil {
		return fmt.Errorf("awsec2: replace root: %w", err)
	}
	if task == nil || task.ReplaceRootVolumeTask == nil || aws.ToString(task.ReplaceRootVolumeTask.ReplaceRootVolumeTaskId) == "" {
		return errors.New("awsec2: replace root returned no task id")
	}
	id := aws.ToString(task.ReplaceRootVolumeTask.ReplaceRootVolumeTaskId)
	err = d.poll(ctx, d.operationTimeout(), func() (bool, error) {
		out, err := d.api.DescribeReplaceRootVolumeTasks(ctx, &ec2.DescribeReplaceRootVolumeTasksInput{ReplaceRootVolumeTaskIds: []string{id}})
		if err != nil {
			return false, fmt.Errorf("awsec2: describe root task: %w", err)
		}
		if out == nil || len(out.ReplaceRootVolumeTasks) != 1 {
			return false, errors.New("awsec2: root task missing or ambiguous")
		}
		task := out.ReplaceRootVolumeTasks[0]
		if aws.ToString(task.ReplaceRootVolumeTaskId) != id || aws.ToString(task.InstanceId) != ref.DriverRef || aws.ToString(task.SnapshotId) != snap.Ref || !aws.ToBool(task.DeleteReplacedRootVolume) {
			return false, fmt.Errorf("%w: root task %s does not match reset", driver.ErrNotOwned, id)
		}
		switch task.TaskState {
		case types.ReplaceRootVolumeTaskStateSucceeded:
			return true, nil
		case types.ReplaceRootVolumeTaskStatePending, types.ReplaceRootVolumeTaskStateInProgress:
			return false, nil
		default:
			return false, fmt.Errorf("awsec2: root task %s ended in %s", id, task.TaskState)
		}
	})
	if err != nil {
		return fmt.Errorf("awsec2: wait root task %s: %w", id, err)
	}
	// Task success precedes the guest becoming reachable. Read back the new root
	// from EC2 before allowing a subsequent round; this does not prove app health.
	return d.poll(ctx, d.operationTimeout(), func() (bool, error) {
		i, err := d.live(ctx, ref)
		if err != nil {
			return false, err
		}
		if tagsOf(i.Tags)[tagOriginalRootVolume] != original {
			return false, fmt.Errorf("%w: root provenance changed", driver.ErrNotOwned)
		}
		if i.State == nil || i.State.Name != types.InstanceStateNameRunning || aws.ToString(i.PrivateIpAddress) == "" {
			return false, nil
		}
		volume, err := rootVolume(i)
		if err != nil {
			return false, err
		}
		return volume != current, nil
	})
}
