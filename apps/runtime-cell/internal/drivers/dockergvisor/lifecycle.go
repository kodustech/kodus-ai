package dockergvisor

// A machine's life: create, suspend and resume, reset, destroy, list and
// expiry. Up (up.go) is what boots its project.

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

func machineName(spec driver.MachineSpec) string {
	return fmt.Sprintf("kodus-%s-%s", strings.ToLower(spec.ClaimID), spec.Role)
}

// checkMachineSpec refuses a spec this driver cannot make, one of another
// cell, and one that names a network that is not its claim's: the holder
// joins its own claim's network only.
func (d *Driver) checkMachineSpec(spec driver.MachineSpec) error {
	if err := spec.ValidateFor(d.Capabilities()); err != nil {
		return err
	}
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return err
	}
	if spec.CellID != d.cfg.CellID {
		return fmt.Errorf("%w: spec for cell %s", driver.ErrNotOwned, spec.CellID)
	}
	if spec.ClaimGroupID != d.claimNetwork(spec.ClaimID) {
		return fmt.Errorf("%w: network %s is not claim %s's", driver.ErrNotOwned, spec.ClaimGroupID, spec.ClaimID)
	}
	return nil
}

// retainGeneration holds the baked generation a workload boots from for as
// long as the machine lives (Destroy gives it back), so a newer bake never
// removes it under the machine. drop undoes that, for a machine that was
// not created after all; it does nothing when the spec names no bake.
func (d *Driver) retainGeneration(ctx context.Context, spec driver.MachineSpec, name string, tags map[string]string) (drop func(), err error) {
	if !strings.HasPrefix(spec.ImageID, "kodus-bake/") || spec.Role == driver.RoleObserver {
		return func() {}, nil
	}
	_, release, err := d.holdGeneration(ctx, driver.MachineRef{ImageID: spec.ImageID, Tags: tags})
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	if d.generationHolds == nil {
		d.generationHolds = map[string]func(){}
	}
	if d.generationHolds[name] != nil {
		d.mu.Unlock()
		release()
		return nil, errors.New("dockergvisor: machine already retains a generation")
	}
	d.generationHolds[name] = release
	d.mu.Unlock()
	return func() {
		d.mu.Lock()
		delete(d.generationHolds, name)
		d.mu.Unlock()
		release()
	}, nil
}

func (d *Driver) Create(ctx context.Context, spec driver.MachineSpec) (driver.MachineRef, error) {
	if err := d.checkMachineSpec(spec); err != nil {
		return driver.MachineRef{}, err
	}
	if spec.Role != driver.RoleObserver {
		// A claim whose writes the disks cannot hold is refused before it
		// starts (diskfloor.go); its observer writes nothing that counts.
		if err := d.diskShort(ctx); err != nil {
			return driver.MachineRef{}, err
		}
	}
	tags := spec.AllTags()
	name := machineName(spec)
	// Until the machine exists, a failure gives the generation back.
	dropGeneration, err := d.retainGeneration(ctx, spec, name, tags)
	if err != nil {
		return driver.MachineRef{}, err
	}
	created := false
	defer func() {
		if !created {
			dropGeneration()
		}
	}()
	labels := toLabels(tags)
	var g limitGroup
	if spec.Role == driver.RoleObserver {
		g, err = d.observerGroup(ctx, spec.ClaimGroupID, spec.OrgID)
	} else {
		g, err = d.groupFor(ctx, spec.ClaimGroupID, spec.OrgID, spec.ClaimSize)
	}
	if err != nil {
		return driver.MachineRef{}, err
	}
	g.label(labels)
	labels["kodus.image"] = spec.ImageID
	labels[labelMachine] = name
	resolv, err := d.claimResolv(spec.ClaimGroupID)
	if err != nil {
		return driver.MachineRef{}, err
	}
	h := isolation.Spec{
		Shape: isolation.ShapeEnvironment, Name: name, Image: d.cfg.HolderImage, Network: spec.ClaimGroupID,
		PidsLimit: d.cfg.PidsLimit, Labels: labels, Resolv: resolv, CgroupParent: g.parent, DiskSize: d.cfg.ContainerDiskSize,
	}
	if spec.Role == driver.RoleWorkload {
		h.Rates = d.ratesFor(spec.ClaimSize)
	}
	observerNet := ""
	if spec.Role == driver.RoleObserver && d.cfg.ObserverImage != "" {
		if observerNet, err = d.ensureObserverNetwork(ctx); err != nil {
			return driver.MachineRef{}, fmt.Errorf("dockergvisor: observer network: %w", err)
		}
		h.Image, h.Mounts, h.Cmd = d.cfg.ObserverImage, []string{d.cfg.ObserverTLSDir + ":" + observerTLSMount}, observerCmd(d.cfg.CellID)
		h.AlsoOn = []string{observerNet}
	}
	c, err := d.backend.Create(ctx, h)
	if err != nil {
		return driver.MachineRef{}, err
	}
	if d.cfg.ClaimLimits != nil {
		if err := d.cfg.ClaimLimits.Verify(g.key, c.PID); err != nil {
			cleanup, cancel := cleanupContext(ctx)
			defer cancel()
			return driver.MachineRef{}, errors.Join(ErrResourceEnforcement, err, d.backend.Discard(cleanup, name))
		}
	}
	// The cell dials an observer on the observer network: the claim
	// network has no address on the host.
	address := c.IP(spec.ClaimGroupID)
	if observerNet != "" {
		if address = c.IP(observerNet); address == "" {
			return driver.MachineRef{}, errors.Join(fmt.Errorf("dockergvisor: observer %s has no address on %s", name, observerNet), d.backend.Discard(context.WithoutCancel(ctx), name))
		}
	}
	d.mu.Lock()
	m := d.machineLocked(name)
	m.expires, m.size = spec.ExpiresAt, spec.ClaimSize
	m.setup, m.seeds = spec.Setup, spec.Setup && spec.SeedsCache
	d.mu.Unlock()
	created = true
	return driver.MachineRef{MachineID: name, DriverRef: c.ID, PrivateAddress: address, ImageID: spec.ImageID, Tags: tags}, nil
}

// owned checks that every container of the machine (its holder, its compose
// project under either of its names, spare.go) carries this cell's label.
// exists is false when there is none. A name that is no machine's
// (machineNamePattern) is refused before anything is read: callers build
// paths from it (R3-06). One docker call (LabelsOf) for every operation that
// checks: it used to be three filtered ps and an inspect (G4).
func (d *Driver) owned(ctx context.Context, machine string) (exists bool, err error) {
	if !machineNamePattern.MatchString(machine) {
		return false, fmt.Errorf("%w: %q is not a machine name", driver.ErrNotOwned, machine)
	}
	cellLabel := dockercli.LabelFromTag(driver.TagCell)
	all, err := d.d.LabelsOf(ctx, composeProjectLabel, cellLabel)
	if err != nil {
		return false, err
	}
	projects := []string{projectName(machine, 0), projectName(machine, 1)}
	for _, c := range all {
		if !slices.Contains(c.Names, machine) && !slices.Contains(projects, c.Labels[composeProjectLabel]) {
			continue
		}
		exists = true
		if c.Labels[cellLabel] != d.cfg.CellID {
			name := c.ID
			if len(c.Names) > 0 {
				name = c.Names[0]
			}
			return true, fmt.Errorf("%w: container %s", driver.ErrNotOwned, name)
		}
	}
	return exists, nil
}

func (d *Driver) Suspend(ctx context.Context, ref driver.MachineRef, _ driver.SuspendMode) error {
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return err
	}
	return d.backend.Pause(ctx, ref.MachineID)
}

func (d *Driver) Resume(ctx context.Context, ref driver.MachineRef) error {
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return err
	}
	return d.backend.Start(ctx, ref.MachineID)
}

// Reset between rounds: the project's volumes are dropped and the cell
// brings it up again from the image (ADR-050).
func (d *Driver) Reset(ctx context.Context, ref driver.MachineRef, snap driver.SnapshotRef) error {
	if snap.Kind != "compose_volumes" {
		return fmt.Errorf("dockergvisor: reset %q not supported", snap.Kind)
	}
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return err
	}
	at := d.clock.Now()
	project, _ := d.projectOf(ref.MachineID)
	if err := d.d.ComposeDown(ctx, project, true); err != nil {
		return err
	}
	d.mu.Lock()
	d.machineLocked(ref.MachineID).reset = &pendingReset{at: at, downMs: d.clock.Now().Sub(at).Milliseconds()}
	d.mu.Unlock()
	return nil
}

// Destroy takes the project down and removes the holder, only when every
// container under that name is this cell's.
func (d *Driver) Destroy(ctx context.Context, ref driver.MachineRef) error {
	exists, err := d.owned(ctx, ref.MachineID)
	if err != nil {
		return err
	}
	// A machine whose data a bake is copying keeps its volumes past the
	// down; whichever of the two finishes last removes them.
	d.mu.Lock()
	pin := d.pinned[ref.MachineID]
	d.mu.Unlock()
	keepData := pin != nil && len(pin.volumes) > 0
	// Its warm spare, and its project when a swap left it under the
	// spare's name (spare.go): neither is ever a bake's.
	if _, rerr := d.endSpare(ctx, ref.MachineID); rerr != nil {
		err = errors.Join(err, rerr)
	}
	if rerr := d.waitDrained(ctx, ref.MachineID); rerr != nil {
		err = errors.Join(err, rerr)
	}
	if exists {
		err = errors.Join(err, d.downSpareName(ctx, ref.MachineID), d.backend.Destroy(ctx, ref.MachineID, isolation.DestroyOptions{KeepData: keepData}))
	}
	if keepData {
		if rerr := d.downForBake(ctx, ref.MachineID, pin); rerr != nil {
			err = errors.Join(err, rerr)
		}
	} else if rerr := d.removeProjectVolumes(ctx, ref.MachineID); rerr != nil {
		err = errors.Join(err, rerr)
	}
	// Its golden data goes with it (golden.go).
	if rerr := d.reaper().removeGolden(ctx, ref.MachineID); rerr != nil {
		err = errors.Join(err, rerr)
	}
	if rerr := d.removeBuilt(ctx, ref.MachineID); rerr != nil {
		err = errors.Join(err, rerr)
	}
	if rerr := removeDecoyFile(decoyPath(d.workDir(), ref.MachineID)); rerr != nil {
		err = errors.Join(err, rerr)
	}
	d.forget(ref.MachineID)
	d.mu.Lock()
	_, baking := d.pinned[ref.MachineID]
	d.mu.Unlock()
	// A machine being baked leaves its build cache to the bake.
	if !baking {
		if rerr := d.removeMachineCache(ref.MachineID); rerr != nil {
			err = errors.Join(err, rerr)
		}
	}
	if err == nil {
		d.mu.Lock()
		release := d.generationHolds[ref.MachineID]
		delete(d.generationHolds, ref.MachineID)
		d.mu.Unlock()
		if release != nil {
			release()
		}
	}
	return err
}

// List is this cell's holders (one per machine) carrying the selector's
// labels: a selector naming another cell finds nothing.
func (d *Driver) List(ctx context.Context, selector map[string]string) ([]driver.MachineRef, error) {
	if cell, ok := selector[driver.TagCell]; ok && cell != d.cfg.CellID {
		return nil, nil
	}
	labels := toLabels(selector)
	labels[dockercli.LabelFromTag(driver.TagCell)] = d.cfg.CellID
	labels[labelMachine] = ""
	cs, err := d.d.List(ctx, labels)
	if err != nil {
		return nil, err
	}
	var out []driver.MachineRef
	for i := range cs {
		c := &cs[i]
		tags := map[string]string{}
		for k, v := range c.Labels {
			tags[dockercli.TagFromLabel(k)] = v
		}
		if !driver.Matches(tags, selector) || c.Labels[labelMachine] != c.Name {
			continue
		}
		if e := d.peek(c.Name).expires; !e.IsZero() {
			tags[driver.TagExpires] = driver.FormatTime(e)
		}
		network := networkName(tags[driver.TagClaim])
		out = append(out, driver.MachineRef{MachineID: c.Name, DriverRef: c.ID, PrivateAddress: c.IP(network), ImageID: tags["kodus:image"], Tags: tags})
	}
	return out, nil
}

// SetExpiry moves kodus:expires, which lives in the driver's state (labels
// never change), for this cell's machine, held under the ceiling its
// holder's label carries (not the one the caller's ref says).
func (d *Driver) SetExpiry(ctx context.Context, ref driver.MachineRef, at time.Time) error {
	holders, err := d.d.List(ctx, map[string]string{labelMachine: ref.MachineID})
	if err != nil {
		return err
	}
	if len(holders) != 1 || holders[0].Labels[dockercli.LabelFromTag(driver.TagCell)] != d.cfg.CellID {
		return fmt.Errorf("%w: machine %s", driver.ErrNotOwned, ref.MachineID)
	}
	at, err = driver.ClampToCeiling(at, dockercli.CeilingTags(holders[0].Labels))
	if err != nil {
		return fmt.Errorf("dockergvisor: machine %s: %w", ref.MachineID, err)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.machineLocked(ref.MachineID).expires = at
	return nil
}
