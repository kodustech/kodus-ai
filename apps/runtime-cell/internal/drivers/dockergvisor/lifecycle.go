package dockergvisor

// A machine's life: create, suspend and resume, reset, destroy, list and
// expiry. Up (up.go) is what boots its project.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

func machineName(spec driver.MachineSpec) string {
	return fmt.Sprintf("kodus-%s-%s", strings.ToLower(spec.ClaimID), spec.Role)
}

func (d *Driver) Create(ctx context.Context, spec driver.MachineSpec) (driver.MachineRef, error) {
	if err := spec.ValidateFor(d.Capabilities()); err != nil {
		return driver.MachineRef{}, err
	}
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.MachineRef{}, err
	}
	if spec.CellID != d.cfg.CellID {
		return driver.MachineRef{}, fmt.Errorf("%w: spec for cell %s", driver.ErrNotOwned, spec.CellID)
	}
	// The holder joins this claim's network only: a spec naming another
	// claim's network is refused.
	if spec.ClaimGroupID != d.claimNetwork(spec.ClaimID) {
		return driver.MachineRef{}, fmt.Errorf("%w: network %s is not claim %s's", driver.ErrNotOwned, spec.ClaimGroupID, spec.ClaimID)
	}
	tags := spec.AllTags()
	name := machineName(spec)
	keepGeneration := false
	if strings.HasPrefix(spec.ImageID, "kodus-bake/") && spec.Role != driver.RoleObserver {
		_, release, err := d.holdGeneration(ctx, driver.MachineRef{ImageID: spec.ImageID, Tags: tags})
		if err != nil {
			return driver.MachineRef{}, err
		}
		defer func() {
			if !keepGeneration {
				release()
			}
		}()
		d.mu.Lock()
		if d.generationHolds == nil {
			d.generationHolds = map[string]func(){}
		}
		if d.generationHolds[name] != nil {
			d.mu.Unlock()
			return driver.MachineRef{}, errors.New("dockergvisor: machine already retains a generation")
		}
		d.generationHolds[name] = release
		d.mu.Unlock()
		defer func() {
			if !keepGeneration {
				d.mu.Lock()
				delete(d.generationHolds, name)
				d.mu.Unlock()
			}
		}()
	}
	labels := toLabels(tags)
	var g limitGroup
	var err error
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
	h := dockercli.HolderSpec{Name: name, Image: d.cfg.HolderImage, Network: spec.ClaimGroupID, Runtime: d.cfg.Runtime,
		PidsLimit: d.cfg.PidsLimit, Labels: labels, Resolv: resolv, CgroupParent: g.parent}
	observerNet := ""
	if spec.Role == driver.RoleObserver && d.cfg.ObserverImage != "" {
		if observerNet, err = d.ensureObserverNetwork(ctx); err != nil {
			return driver.MachineRef{}, fmt.Errorf("dockergvisor: observer network: %w", err)
		}
		h.Image, h.Mounts, h.Cmd = d.cfg.ObserverImage, []string{d.cfg.ObserverTLSDir + ":" + observerTLSMount}, observerCmd(d.cfg.CellID)
		h.AlsoOn = []string{observerNet}
	}
	c, err := d.d.RunHolder(ctx, h)
	if err != nil {
		return driver.MachineRef{}, err
	}
	if d.cfg.ClaimLimits != nil {
		if err := d.cfg.ClaimLimits.Verify(g.key, c.PID); err != nil {
			cleanup, cancel := cleanupContext(ctx)
			defer cancel()
			return driver.MachineRef{}, errors.Join(ErrResourceEnforcement, err, d.d.Remove(cleanup, name))
		}
	}
	// The cell dials an observer on the observer network: the claim
	// network has no address on the host.
	address := c.IP(spec.ClaimGroupID)
	if observerNet != "" {
		if address = c.IP(observerNet); address == "" {
			return driver.MachineRef{}, errors.Join(fmt.Errorf("dockergvisor: observer %s has no address on %s", name, observerNet), d.d.Remove(context.WithoutCancel(ctx), name))
		}
	}
	d.mu.Lock()
	m := d.machineLocked(name)
	m.expires, m.size = spec.ExpiresAt, spec.ClaimSize
	m.setup, m.seeds = spec.Setup, spec.Setup && spec.SeedsCache
	d.mu.Unlock()
	keepGeneration = true
	return driver.MachineRef{MachineID: name, DriverRef: c.ID, PrivateAddress: address, ImageID: spec.ImageID, Tags: tags}, nil
}

// owned checks that every container of the machine (its holder, its compose
// project) carries this cell's label. exists is false when there is none.
func (d *Driver) owned(ctx context.Context, machine string) (exists bool, err error) {
	byName, err := d.d.IDs(ctx, dockercli.Filters{"name": {"^/?" + machine + "$"}})
	if err != nil {
		return false, err
	}
	byProject, err := d.d.IDs(ctx, dockercli.Filters{"label": {"com.docker.compose.project=" + machine}})
	if err != nil {
		return false, err
	}
	cs, err := d.d.Inspect(ctx, append(byName, byProject...)...)
	if err != nil {
		return false, err
	}
	for _, c := range cs {
		if c.Labels[dockercli.LabelFromTag(driver.TagCell)] != d.cfg.CellID {
			return true, fmt.Errorf("%w: container %s", driver.ErrNotOwned, c.Name)
		}
	}
	return len(cs) > 0, nil
}

func (d *Driver) Suspend(ctx context.Context, ref driver.MachineRef, _ driver.SuspendMode) error {
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return err
	}
	return d.d.ComposeStop(ctx, ref.MachineID)
}

func (d *Driver) Resume(ctx context.Context, ref driver.MachineRef) error {
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return err
	}
	return d.d.ComposeStart(ctx, ref.MachineID)
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
	if err := d.d.ComposeDown(ctx, ref.MachineID, true); err != nil {
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
	if exists {
		err = d.d.ComposeDown(ctx, ref.MachineID, !keepData)
		if rerr := d.d.Remove(ctx, ref.MachineID); rerr != nil {
			err = errors.Join(err, rerr)
		}
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
	for _, c := range cs {
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
	hard, perr := time.Parse(time.RFC3339, holders[0].Labels[dockercli.LabelFromTag(driver.TagHardExpires)])
	if perr != nil {
		return fmt.Errorf("dockergvisor: machine %s has no ceiling: %w", ref.MachineID, perr)
	}
	if at.After(hard) {
		at = hard
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.machineLocked(ref.MachineID).expires = at
	return nil
}
