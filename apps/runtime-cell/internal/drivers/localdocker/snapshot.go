package localdocker

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// data.reset: snapshot. Once the first boot is ready (migrated, seeded),
// the project's named volumes are copied into snapshot volumes; a reset
// copies them back and starts the project again, with no build, migrate or
// seed. A copy is only made with the services that use the volumes
// stopped, so it is consistent. Base and PR are separate projects, so each
// has its own snapshots.

// labelSnapshotOf marks a snapshot volume with the volume it copies; with
// labelMachine and the cell's label, destroy and the sweep find it. Compose
// does not label it, so a down -v never takes it.
const labelSnapshotOf = "kodus.snapshot-of"

// ErrNoSnapshotDocker: the Docker in use cannot copy volumes.
var errNoSnapshotDocker = errors.New("this Docker cannot copy volumes")

func wantsSnapshot(rec *recipe.Recipe) bool {
	return rec != nil && rec.ResetStrategy() == recipe.ResetSnapshot
}

func dockerVolume(project, key string) string { return project + "_" + key }

func snapshotVolume(volume string) string { return volume + "-kodus-snapshot" }

// projectVolumes is every named volume of the plan, as Docker names them,
// and the services that mount at least one.
func projectVolumes(project string, plan *bootPlan) (volumes, services []string) {
	seen := map[string]bool{}
	for svc, keys := range plan.volumes {
		services = append(services, svc)
		for _, k := range keys {
			if v := dockerVolume(project, k); !seen[v] {
				seen[v] = true
				volumes = append(volumes, v)
			}
		}
	}
	sort.Strings(volumes)
	sort.Strings(services)
	return volumes, services
}

func (d *Driver) snapshotDocker() (SnapshotDocker, error) {
	sd, ok := d.docker.(SnapshotDocker)
	if !ok {
		return nil, errNoSnapshotDocker
	}
	return sd, nil
}

func (d *Driver) hasSnapshot(name string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.st.Machines[name]
	return m != nil && len(m.Snapshots) > 0
}

func (d *Driver) setSnapshots(name string, snaps map[string]string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if m := d.st.Machines[name]; m != nil {
		m.Snapshots = snaps
	}
	return d.saveLocked()
}

func (d *Driver) snapshots(name string) map[string]string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := map[string]string{}
	if m := d.st.Machines[name]; m != nil {
		for k, v := range m.Snapshots {
			out[k] = v
		}
	}
	return out
}

// takeSnapshot stops the services that mount named volumes, copies each
// volume into its snapshot, and brings the project up again whatever the
// copy did. An error from the copy is a snapshot not taken (the caller
// falls back); an error from bringing it up again is a broken machine.
func (d *Driver) takeSnapshot(ctx context.Context, ref driver.MachineRef, plan *bootPlan) (copyErr, upErr error) {
	sd, err := d.snapshotDocker()
	if err != nil {
		return err, nil
	}
	volumes, services := projectVolumes(ref.MachineID, plan)
	if len(volumes) == 0 {
		return errors.New("the project has no named volume to snapshot"), nil
	}
	if err := sd.ComposeStopServices(ctx, ref.MachineID, services...); err != nil {
		return fmt.Errorf("stop: %w", err), d.docker.ComposeUp(ctx, plan.project)
	}
	labels := map[string]string{labelMachine: ref.MachineID, dockercli.LabelFromTag(driver.TagCell): d.cfg.CellID}
	snaps := map[string]string{}
	for _, v := range volumes {
		l := map[string]string{labelSnapshotOf: v}
		for k, val := range labels {
			l[k] = val
		}
		if err := sd.CopyVolume(ctx, v, snapshotVolume(v), l); err != nil {
			copyErr = fmt.Errorf("copy %s: %w", v, err)
			break
		}
		snaps[v] = snapshotVolume(v)
	}
	if upErr = d.docker.ComposeUp(ctx, plan.project); upErr != nil {
		return copyErr, upErr
	}
	if copyErr != nil {
		return copyErr, nil
	}
	return nil, d.setSnapshots(ref.MachineID, snaps)
}

// restoreSnapshot stops every service, empties each named volume and
// copies its snapshot back. The caller brings the project up.
func (d *Driver) restoreSnapshot(ctx context.Context, ref driver.MachineRef, plan *bootPlan) error {
	sd, err := d.snapshotDocker()
	if err != nil {
		return err
	}
	snaps := d.snapshots(ref.MachineID)
	volumes, _ := projectVolumes(ref.MachineID, plan)
	for _, v := range volumes {
		if snaps[v] == "" {
			return fmt.Errorf("no snapshot of %s", v)
		}
	}
	if len(volumes) == 0 {
		return errors.New("no snapshot")
	}
	if err := sd.ComposeStopServices(ctx, ref.MachineID); err != nil {
		return fmt.Errorf("stop: %w", err)
	}
	for _, v := range volumes {
		if err := sd.CopyVolume(ctx, snaps[v], v, nil); err != nil {
			return fmt.Errorf("restore %s: %w", v, err)
		}
	}
	return nil
}

// removeSnapshots removes the machine's snapshot volumes.
func (d *Driver) removeSnapshots(ctx context.Context, machine string) error {
	sd, ok := d.docker.(SnapshotDocker)
	if !ok {
		return nil
	}
	vols, err := sd.Volumes(ctx, map[string]string{labelMachine: machine, labelSnapshotOf: ""})
	if err != nil {
		return err
	}
	names := make([]string, 0, len(vols))
	for _, v := range vols {
		names = append(names, v.Name)
	}
	return sd.VolumeRemove(ctx, names...)
}

// sweepSnapshots removes this cell's snapshot volumes whose machine the
// state file no longer knows (a crash between destroy and its cleanup).
func (d *Driver) sweepSnapshots(ctx context.Context) error {
	sd, ok := d.docker.(SnapshotDocker)
	if !ok {
		return nil
	}
	vols, err := sd.Volumes(ctx, map[string]string{dockercli.LabelFromTag(driver.TagCell): d.cfg.CellID, labelSnapshotOf: ""})
	if err != nil {
		return err
	}
	var gone []string
	d.mu.Lock()
	for _, v := range vols {
		if _, live := d.st.Machines[v.Labels[labelMachine]]; !live {
			gone = append(gone, v.Name)
		}
	}
	d.mu.Unlock()
	return sd.VolumeRemove(ctx, gone...)
}
