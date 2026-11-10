package localdocker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

// machineView is a copy of what the state file knows about a machine.
type machineView struct {
	tags map[string]string
	// claimExpose is what the claim asked to reach.
	claimExpose []driver.ExposePort
	// checkout is where the workload last booted from; "" before that.
	checkout string
}

func (d *Driver) lookupMachine(name string) (machineView, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.st.Machines[name]
	if m == nil {
		return machineView{}, false
	}
	v := machineView{tags: m.Tags, checkout: m.Dir}
	if c := d.st.Claims[m.Tags[driver.TagClaim]]; c != nil {
		v.claimExpose = c.Expose
	}
	return v, true
}

func isWorkload(ref driver.MachineRef) bool {
	return driver.Role(ref.Tags[driver.TagRole]) == driver.RoleWorkload
}

// Create records the machine. Nothing runs yet: the workload boots when the
// checkout lands in it (Transport.Upload calls Boot), and the observer is
// the cell's in-process observer on the same host.
func (d *Driver) Create(_ context.Context, spec driver.MachineSpec) (driver.MachineRef, error) {
	if err := spec.ValidateFor(d.Capabilities()); err != nil {
		return driver.MachineRef{}, err
	}
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.MachineRef{}, err
	}
	if spec.CellID != d.cfg.CellID {
		return driver.MachineRef{}, fmt.Errorf("%w: spec for cell %s", driver.ErrNotOwned, spec.CellID)
	}
	tags := spec.AllTags()
	tags[tagImage] = spec.ImageID
	name := machineName(spec.ClaimID, spec.Role)
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.st.Machines[name]; ok {
		return driver.MachineRef{}, fmt.Errorf("localdocker: machine %s exists", name)
	}
	d.st.Machines[name] = &machineState{Tags: tags, ExpiresAt: spec.ExpiresAt.UTC()}
	if err := d.saveLocked(); err != nil {
		delete(d.st.Machines, name)
		return driver.MachineRef{}, err
	}
	return d.refLocked(name), nil
}

func (d *Driver) refLocked(name string) driver.MachineRef {
	m := d.st.Machines[name]
	tags := make(map[string]string, len(m.Tags)+1)
	for k, v := range m.Tags {
		tags[k] = v
	}
	tags[driver.TagExpires] = driver.FormatTime(m.ExpiresAt)
	return driver.MachineRef{MachineID: name, DriverRef: name, PrivateAddress: "127.0.0.1", ImageID: m.Tags[tagImage], Tags: tags}
}

// recordPublishedPorts asks Docker which host port each published port
// landed on and keeps the answer: Docker picks them at every up and start.
func (d *Driver) recordPublishedPorts(ctx context.Context, name string, published []compose.PublishedPort) error {
	ports := make(map[string]string, len(published))
	for _, p := range published {
		key := exposeKey(p.Service, p.Port.Port)
		addr, err := d.docker.ComposePort(ctx, name, p.ComposeService, p.Port.Port)
		if err != nil {
			return fmt.Errorf("localdocker: port %s: %w", key, err)
		}
		ports[key] = addr
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if m := d.st.Machines[name]; m != nil {
		m.Ports = ports
	}
	return d.saveLocked()
}

// HostAddress is where the observer reaches an exposed port of the claim's
// workload ("127.0.0.1:55001").
func (d *Driver) HostAddress(claimID, service string, port int) (string, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.st.Machines[machineName(claimID, driver.RoleWorkload)]
	if m == nil {
		return "", false
	}
	a, ok := m.Ports[exposeKey(service, port)]
	return a, ok
}

func (d *Driver) Suspend(ctx context.Context, ref driver.MachineRef, _ driver.SuspendMode) error {
	if !isWorkload(ref) {
		return nil
	}
	return d.docker.ComposeStop(ctx, ref.MachineID)
}

// Resume starts the project again; Docker may publish on new host ports, so
// they are read again.
func (d *Driver) Resume(ctx context.Context, ref driver.MachineRef) error {
	if !isWorkload(ref) {
		return nil
	}
	if err := d.docker.ComposeStart(ctx, ref.MachineID); err != nil {
		return err
	}
	plan, err := d.lastBootPlan(ref.MachineID)
	if err != nil || plan == nil {
		return err
	}
	return d.recordPublishedPorts(ctx, ref.MachineID, plan.published)
}

// owner is the cell a machine belongs to: the state file's record, else the
// cell label Docker shows on the containers carrying its machine name. ""
// when neither knows the machine.
func (d *Driver) owner(ctx context.Context, name string) (string, error) {
	d.mu.Lock()
	m := d.st.Machines[name]
	d.mu.Unlock()
	if m != nil {
		return m.Tags[driver.TagCell], nil
	}
	containers, err := d.docker.List(ctx, map[string]string{labelMachine: name})
	if err != nil {
		return "", err
	}
	for _, c := range containers {
		return c.Labels[dockercli.LabelFromTag(driver.TagCell)], nil
	}
	return "", nil
}

// Destroy takes the project down with its volumes and the images it built,
// forgets the machine and removes its files. It touches only a machine this
// cell owns: the same Docker runs the developer's own stacks and maybe
// another cell's. A machine nobody knows is already gone.
func (d *Driver) Destroy(ctx context.Context, ref driver.MachineRef) error {
	cell, err := d.owner(ctx, ref.MachineID)
	switch {
	case err != nil:
		return err
	case cell == "":
		return nil
	case cell != d.cfg.CellID:
		return fmt.Errorf("%w: machine %s", driver.ErrNotOwned, ref.MachineID)
	}
	if isWorkload(ref) || ref.Tags[driver.TagRole] == "" {
		err = d.docker.ComposeDown(ctx, ref.MachineID, DownOptions{Volumes: true, BuiltImages: true})
		if serr := d.removeSnapshots(ctx, ref.MachineID); serr != nil {
			err = errors.Join(err, serr)
		}
	}
	d.mu.Lock()
	delete(d.st.Machines, ref.MachineID)
	if serr := d.saveLocked(); serr != nil {
		err = errors.Join(err, serr)
	}
	d.mu.Unlock()
	if d.cfg.MachinesDir != "" && ref.MachineID != "" && projectName(ref.MachineID) == ref.MachineID {
		if rerr := os.RemoveAll(filepath.Join(d.cfg.MachinesDir, ref.MachineID)); rerr != nil {
			err = errors.Join(err, rerr)
		}
	}
	return err
}

// List is every machine of the state file plus every compose project Docker
// runs with this cell's labels and a machine name. A project the state file does not know has
// no kodus:expires, so a sweep treats it as expired.
func (d *Driver) List(ctx context.Context, selector map[string]string) ([]driver.MachineRef, error) {
	cell := d.cfg.CellID
	if c, ok := selector[driver.TagCell]; ok && c != cell {
		return nil, nil
	}
	containers, err := d.docker.List(ctx, map[string]string{dockercli.LabelFromTag(driver.TagCell): cell})
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	seen := map[string]bool{}
	var out []driver.MachineRef
	add := func(ref driver.MachineRef) {
		if seen[ref.MachineID] || !driver.Matches(ref.Tags, selector) {
			return
		}
		seen[ref.MachineID] = true
		out = append(out, ref)
	}
	for _, c := range containers {
		// Only containers the driver labelled with its machine name: a
		// compose project that merely carries this cell's label (a
		// developer's own stack, another tool) is not the driver's to sweep.
		name := c.Labels[labelMachine]
		if name == "" || projectName(name) != name {
			continue
		}
		if _, ok := d.st.Machines[name]; ok {
			add(d.refLocked(name))
			continue
		}
		tags := map[string]string{}
		for k, v := range c.Labels {
			if strings.HasPrefix(k, reservedLabelPrefix) {
				tags[dockercli.TagFromLabel(k)] = v
			}
		}
		add(driver.MachineRef{MachineID: name, DriverRef: name, PrivateAddress: "127.0.0.1", ImageID: tags[tagImage], Tags: tags})
	}
	for name, m := range d.st.Machines {
		if m.Tags[driver.TagCell] == cell {
			add(d.refLocked(name))
		}
	}
	return out, nil
}

// SetExpiry moves kodus:expires in the state file, never past
// kodus:hard-expires, for a machine this cell owns. One Docker still runs
// but the state file lost (a crash) is adopted back from its labels.
func (d *Driver) SetExpiry(ctx context.Context, ref driver.MachineRef, at time.Time) error {
	if cell, err := d.owner(ctx, ref.MachineID); err != nil {
		return err
	} else if cell != d.cfg.CellID {
		return fmt.Errorf("%w: machine %s", driver.ErrNotOwned, ref.MachineID)
	}
	if hard := driver.ParseExpiry(ref.Tags, driver.TagHardExpires); !hard.IsZero() && at.After(hard) {
		at = hard
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.st.Machines[ref.MachineID]
	if m == nil {
		tags := map[string]string{}
		for k, v := range ref.Tags {
			if k != driver.TagExpires {
				tags[k] = v
			}
		}
		m = &machineState{Tags: tags}
		d.st.Machines[ref.MachineID] = m
	}
	m.ExpiresAt = at.UTC()
	return d.saveLocked()
}

// Sweep destroys every machine of this cell past kodus:expires or
// kodus:hard-expires, and every labelled project nobody can date. The cell
// runs it at start, which is how a restarted laptop cell cleans up after a
// crash.
func (d *Driver) Sweep(ctx context.Context, now time.Time) ([]string, error) {
	refs, err := d.List(ctx, map[string]string{driver.TagCell: d.cfg.CellID})
	if err != nil {
		return nil, err
	}
	var gone []string
	var errs []error
	for _, ref := range refs {
		soft := driver.ParseExpiry(ref.Tags, driver.TagExpires)
		hard := driver.ParseExpiry(ref.Tags, driver.TagHardExpires)
		if now.Before(soft) && now.Before(hard) {
			continue
		}
		if err := d.Destroy(ctx, ref); err != nil {
			errs = append(errs, err)
			continue
		}
		gone = append(gone, ref.MachineID)
	}
	if err := d.sweepSnapshots(ctx); err != nil {
		errs = append(errs, err)
	}
	if len(gone) > 0 || len(errs) > 0 {
		d.cfg.Log.Info("localdocker.sweep", "destroyed", len(gone), "failed", len(errs))
	}
	return gone, errors.Join(errs...)
}
