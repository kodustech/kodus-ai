package awsec2

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// tagOriginalRootVolume is captured before the machine leaves Create. The
// current root volume changes after replacement; AWS requires snapshots from
// the original root even in later replay rounds. IAM permits this tag once.
const tagOriginalRootVolume = "kodus:original-root-volume"

func launchToken(spec driver.MachineSpec) string {
	sum := sha256.Sum256([]byte("kodus-launch\x00" + spec.CellID + "\x00" + spec.OrgID + "\x00" + spec.ClaimID + "\x00" + string(spec.Role)))
	return hex.EncodeToString(sum[:])
}
func (d *Driver) operationTimeout() time.Duration {
	if d.cfg.OperationTimeout > 0 {
		return d.cfg.OperationTimeout
	}
	return 15 * time.Minute
}
func (d *Driver) cleanupTimeout() time.Duration {
	if d.cfg.CleanupTimeout > 0 {
		return d.cfg.CleanupTimeout
	}
	return 30 * time.Second
}

// poll bounds retries on the injected clock and API calls on the real context.
// No operation waits indefinitely, including an API call that honors context.
func (d *Driver) poll(ctx context.Context, limit time.Duration, check func() (bool, error)) error {
	c := clock.Or(d.cfg.Clock)
	end := c.Now().Add(limit)
	interval := d.cfg.PollInterval
	if interval <= 0 {
		interval = 2 * time.Second
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !c.Now().Before(end) {
			return context.DeadlineExceeded
		}
		done, err := check()
		if cancelled := ctx.Err(); cancelled != nil {
			return cancelled
		}
		if err != nil || done {
			return err
		}
		delay := interval
		if left := end.Sub(c.Now()); delay > left {
			delay = left
		}
		if delay <= 0 {
			return context.DeadlineExceeded
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.After(delay):
		}
	}
}

func (d *Driver) checkScope(i *types.Instance, ref driver.MachineRef) error {
	tags := tagsOf(i.Tags)
	if tags[driver.TagCell] != d.cfg.CellID {
		return fmt.Errorf("%w: instance %s cell", driver.ErrNotOwned, ref.DriverRef)
	}
	for _, key := range []string{driver.TagOrg, driver.TagClaim, driver.TagRole, driver.TagEnv} {
		if want := ref.Tags[key]; want != "" && tags[key] != want {
			return fmt.Errorf("%w: instance %s %s", driver.ErrNotOwned, ref.DriverRef, key)
		}
	}
	if ref.ImageID != "" && aws.ToString(i.ImageId) != ref.ImageID {
		return fmt.Errorf("%w: instance %s image", driver.ErrNotOwned, ref.DriverRef)
	}
	return nil
}

// previous may remain visible briefly after EC2 accepts a state change.
// A launch only tolerates pending; resume also tolerates its previous stopped state.
func (d *Driver) waitRunning(ctx context.Context, ref driver.MachineRef, previous types.InstanceStateName) (ready *types.Instance, err error) {
	err = d.poll(ctx, d.operationTimeout(), func() (bool, error) {
		i, err := d.actualOwned(ctx, ref)
		if err != nil {
			return false, err
		}
		if i == nil {
			return false, nil
		}
		if i.State == nil {
			return false, nil
		}
		switch i.State.Name {
		case types.InstanceStateNameRunning:
			ip := net.ParseIP(aws.ToString(i.PrivateIpAddress))
			if ip == nil || ip.To4() == nil || ip.IsUnspecified() {
				return false, nil
			}
			ready = i
			return true, nil
		case types.InstanceStateNamePending:
			return false, nil
		default:
			if i.State.Name == previous {
				return false, nil
			}
			return false, fmt.Errorf("awsec2: instance %s became %s while waiting for running", ref.DriverRef, i.State.Name)
		}
	})
	if err != nil {
		return nil, fmt.Errorf("awsec2: wait running %s: %w", ref.DriverRef, err)
	}
	return ready, nil
}

func rootVolume(i *types.Instance) (string, error) {
	root := aws.ToString(i.RootDeviceName)
	if root != "" {
		for _, b := range i.BlockDeviceMappings {
			if aws.ToString(b.DeviceName) == root && b.Ebs != nil && aws.ToString(b.Ebs.VolumeId) != "" {
				return aws.ToString(b.Ebs.VolumeId), nil
			}
		}
	}
	return "", fmt.Errorf("awsec2: instance %s has no EBS root mapping", aws.ToString(i.InstanceId))
}

func (d *Driver) recordOriginalRoot(ctx context.Context, ref driver.MachineRef, i *types.Instance) (*types.Instance, error) {
	volume, err := rootVolume(i)
	if err != nil {
		return nil, err
	}
	if original := tagsOf(i.Tags)[tagOriginalRootVolume]; original != "" {
		// A retry after a successful launch must preserve the first root identity,
		// including when a previous owner already replaced the current root.
		return i, nil
	}
	_, writeErr := d.api.CreateTags(ctx, &ec2.CreateTagsInput{Resources: []string{ref.DriverRef}, Tags: ec2Tags(map[string]string{tagOriginalRootVolume: volume})})
	var ready *types.Instance
	err = d.poll(ctx, d.operationTimeout(), func() (bool, error) {
		actual, err := d.live(ctx, ref)
		if err != nil {
			return false, err
		}
		original := tagsOf(actual.Tags)[tagOriginalRootVolume]
		if original == "" {
			if writeErr != nil {
				return false, fmt.Errorf("awsec2: record root provenance: %w", writeErr)
			}
			return false, nil
		}
		if original != volume {
			return false, fmt.Errorf("%w: original root provenance changed for %s", driver.ErrNotOwned, ref.DriverRef)
		}
		ready = actual
		return true, nil
	})
	if err != nil {
		return nil, fmt.Errorf("awsec2: root provenance %s: %w", ref.DriverRef, err)
	}
	return ready, nil
}

// cleanupCreated keeps cancellation from abandoning a newly launched VM. If
// ownership or termination cannot be proved, the caller retains responsibility
// via ErrResourceCleanupPending; the cell/reaper still has the claim's tags.
func (d *Driver) cleanupCreated(ctx context.Context, ref driver.MachineRef) error {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), d.cleanupTimeout())
	defer cancel()
	actual, err := d.actualOwned(cleanup, ref)
	if err == nil && actual == nil {
		err = errors.New("awsec2: launched instance not yet visible for cleanup")
	}
	if err == nil && (actual.State == nil || actual.State.Name != types.InstanceStateNameTerminated) {
		err = d.terminate(cleanup, ref, d.cleanupTimeout())
	}
	if err != nil {
		return fmt.Errorf("awsec2: cleanup %s: %w", ref.DriverRef, errors.Join(driver.ErrResourceCleanupPending, err))
	}
	return nil
}

func (d *Driver) Suspend(ctx context.Context, ref driver.MachineRef, mode driver.SuspendMode) error {
	ctx, cancel := context.WithTimeout(ctx, d.operationTimeout())
	defer cancel()
	if mode != driver.SuspendStop && mode != driver.SuspendHibernate {
		return fmt.Errorf("awsec2: invalid suspend mode %q", mode)
	}
	if mode == driver.SuspendHibernate && !d.cfg.Hibernate {
		return fmt.Errorf("awsec2: hibernation: %w", driver.ErrUnsupported)
	}
	if _, err := d.live(ctx, ref); err != nil {
		return err
	}
	if _, err := d.api.StopInstances(ctx, &ec2.StopInstancesInput{InstanceIds: []string{ref.DriverRef}, Hibernate: aws.Bool(mode == driver.SuspendHibernate)}); err != nil {
		return fmt.Errorf("awsec2: stop: %w", err)
	}
	return d.poll(ctx, d.operationTimeout(), func() (bool, error) {
		i, err := d.live(ctx, ref)
		if err != nil {
			return false, err
		}
		if i.State == nil {
			return false, nil
		}
		switch i.State.Name {
		case types.InstanceStateNameStopped:
			return true, nil
		case types.InstanceStateNameStopping, types.InstanceStateNameRunning:
			return false, nil
		default:
			return false, fmt.Errorf("awsec2: instance %s became %s while stopping", ref.DriverRef, i.State.Name)
		}
	})
}
func (d *Driver) Resume(ctx context.Context, ref driver.MachineRef) error {
	ctx, cancel := context.WithTimeout(ctx, d.operationTimeout())
	defer cancel()
	if _, err := d.live(ctx, ref); err != nil {
		return err
	}
	if _, err := d.api.StartInstances(ctx, &ec2.StartInstancesInput{InstanceIds: []string{ref.DriverRef}}); err != nil {
		return fmt.Errorf("awsec2: start: %w", err)
	}
	_, err := d.waitRunning(ctx, ref, types.InstanceStateNameStopped)
	return err
}
func (d *Driver) terminate(ctx context.Context, ref driver.MachineRef, limit time.Duration) error {
	if _, err := d.api.TerminateInstances(ctx, &ec2.TerminateInstancesInput{InstanceIds: []string{ref.DriverRef}}); err != nil {
		return fmt.Errorf("awsec2: terminate %s: %w", ref.DriverRef, err)
	}
	return d.poll(ctx, limit, func() (bool, error) { i, err := d.owned(ctx, ref); return i == nil, err })
}

// Destroy confirms termination before claim networking can be released.
func (d *Driver) Destroy(ctx context.Context, ref driver.MachineRef) error {
	ctx, cancel := context.WithTimeout(ctx, d.operationTimeout())
	defer cancel()
	i, err := d.owned(ctx, ref)
	if err != nil || i == nil {
		return err
	}
	return d.terminate(ctx, ref, d.operationTimeout())
}

// A response can be lost after EC2 allocates the machine. Search the launch's
// immutable client token under a fresh bounded context; never launch again to
// discover its identity, and never infer absence from one eventually consistent
// empty DescribeInstances response.
func (d *Driver) cleanupLaunchByToken(ctx context.Context, spec driver.MachineSpec, image, token string) error {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), d.cleanupTimeout())
	defer cancel()
	ref := driver.MachineRef{ImageID: image, Tags: spec.AllTags()}
	err := d.poll(cleanup, d.cleanupTimeout(), func() (bool, error) {
		out, err := d.api.DescribeInstances(cleanup, &ec2.DescribeInstancesInput{Filters: []types.Filter{
			{Name: aws.String("client-token"), Values: []string{token}},
			{Name: aws.String("tag:" + driver.TagCell), Values: []string{spec.CellID}},
			{Name: aws.String("tag:" + driver.TagOrg), Values: []string{spec.OrgID}},
			{Name: aws.String("tag:" + driver.TagClaim), Values: []string{spec.ClaimID}},
			{Name: aws.String("tag:" + driver.TagRole), Values: []string{string(spec.Role)}},
		}})
		if err != nil {
			return false, err
		}
		if out == nil {
			return false, nil
		}
		var instances []types.Instance
		for _, r := range out.Reservations {
			instances = append(instances, r.Instances...)
		}
		if len(instances) == 0 {
			return false, nil
		}
		if len(instances) != 1 || aws.ToString(out.NextToken) != "" {
			return false, errors.New("awsec2: ambiguous launch recovery")
		}
		i := instances[0]
		ref.DriverRef = aws.ToString(i.InstanceId)
		if ref.DriverRef == "" || aws.ToString(i.ClientToken) != token {
			return false, fmt.Errorf("%w: launch recovery identity", driver.ErrNotOwned)
		}
		if err := d.checkScope(&i, ref); err != nil {
			return false, err
		}
		return true, nil
	})
	if err == nil {
		err = d.terminate(cleanup, ref, d.cleanupTimeout())
	}
	if err != nil {
		return fmt.Errorf("awsec2: launch cleanup unresolved: %w", errors.Join(driver.ErrResourceCleanupPending, err))
	}
	return nil
}
