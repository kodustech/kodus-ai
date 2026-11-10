package localdocker

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// Boot brings the workload up from the checkout under the machine's
// project name: setup, build and pull, up --wait, migrate and seed, then
// the recipe's health check. Each exposed port is published on 127.0.0.1
// on a port Docker picks; the timing is logged and kept in the state file.
func (d *Driver) Boot(ctx context.Context, ref driver.MachineRef, checkout string) error {
	run := newBootRun(d.cfg.Log, ref.MachineID, bootKindBoot)
	if err := d.startWorkload(ctx, ref, checkout, run, buildImages); err != nil {
		return err
	}
	return d.saveBootReport(ref.MachineID, run.finish())
}

// Reset puts the workload back to the state every round starts from
// (machine.reset, compose_volumes). recreate, the default: down -v drops
// the containers and volumes, then up from the same checkout with the
// images already built, migrate, seed and the health check. reseed: seed
// and the health check only, for a seed that cleans up after itself.
// snapshot: stop, copy the first ready boot's volumes back, up and the
// health check; when there is no snapshot or the copy fails, recreate
// (localdocker.reset.snapshot_fallback says why).
func (d *Driver) Reset(ctx context.Context, ref driver.MachineRef, snap driver.SnapshotRef) error {
	if snap.Kind != "compose_volumes" {
		return fmt.Errorf("localdocker: reset %q not supported", snap.Kind)
	}
	plan, err := d.lastBootPlan(ref.MachineID)
	if err != nil {
		return err
	}
	run := newBootRun(d.cfg.Log, ref.MachineID, bootKindReset)
	if plan != nil && plan.recipe != nil && plan.recipe.ResetStrategy() == recipe.ResetReseed && len(plan.recipe.FakeServices()) == 0 {
		if err := run.phase(phaseSeed, func() error { return d.seed(ctx, ref.MachineID, plan.project.Dir, plan.recipe) }); err != nil {
			return err
		}
		if err := run.phase(phaseReady, func() error { return d.waitUntilHealthy(ctx, ref.MachineID, plan.recipe) }); err != nil {
			return err
		}
		return d.saveBootReport(ref.MachineID, run.finish())
	}
	if plan != nil && wantsSnapshot(plan.recipe) && len(plan.recipe.FakeServices()) == 0 {
		restored, err := d.resetFromSnapshot(ctx, ref, plan, run)
		if restored || err != nil {
			return err
		}
	}
	if err := run.phase(phaseDown, func() error {
		return d.docker.ComposeDown(ctx, ref.MachineID, DownOptions{Volumes: true})
	}); err != nil {
		return err
	}
	if plan == nil {
		return nil
	}
	if err := d.startWorkload(ctx, ref, plan.project.Dir, run, reuseBuiltImages); err != nil {
		return err
	}
	return d.saveBootReport(ref.MachineID, run.finish())
}

// resetFromSnapshot restores the snapshot and brings the project up.
// restored false with no error: there was no snapshot or the copy failed,
// and the caller recreates. A restored project that does not come up is an
// error: its data are the snapshot's, there is nothing to fall back to.
func (d *Driver) resetFromSnapshot(ctx context.Context, ref driver.MachineRef, plan *bootPlan, run *bootRun) (bool, error) {
	fallback := func(why error) (bool, error) {
		d.cfg.Log.Warn("localdocker.reset.snapshot_fallback", "machine", ref.MachineID, "reason", why.Error())
		_ = d.setSnapshots(ref.MachineID, nil) // the next ready boot takes a new one
		return false, nil
	}
	if !d.hasSnapshot(ref.MachineID) {
		return fallback(errors.New("no snapshot was taken"))
	}
	if err := run.phase(phaseRestore, func() error { return d.restoreSnapshot(ctx, ref, plan) }); err != nil {
		return fallback(err)
	}
	if err := run.phase(phaseUp, func() error { return d.docker.ComposeUp(ctx, plan.project) }); err != nil {
		return true, err
	}
	if err := d.recordPublishedPorts(ctx, ref.MachineID, plan.published); err != nil {
		return true, err
	}
	if err := run.phase(phaseReady, func() error { return d.waitUntilHealthy(ctx, ref.MachineID, plan.recipe) }); err != nil {
		return true, err
	}
	return true, d.saveBootReport(ref.MachineID, run.finish())
}

// startMode says whether a start builds the images or runs the ones the
// boot built.
type startMode int

const (
	buildImages startMode = iota
	reuseBuiltImages
)

// startWorkload runs the phases from build (or up) to ready.
func (d *Driver) startWorkload(ctx context.Context, ref driver.MachineRef, checkout string, run *bootRun, mode startMode) error {
	m, ok := d.lookupMachine(ref.MachineID)
	if !ok {
		return fmt.Errorf("localdocker: unknown machine %s", ref.MachineID)
	}
	if driver.Role(m.tags[driver.TagRole]) != driver.RoleWorkload {
		return fmt.Errorf("localdocker: only the workload boots, not %s", m.tags[driver.TagRole])
	}
	plan, err := newBootPlan(checkout, ref.MachineID, m.claimExpose, containerLabels(ref.MachineID, m.tags))
	if err != nil {
		return err
	}
	if err := plan.write(); err != nil {
		return err
	}
	rec := plan.recipe
	if rec != nil {
		if keys := recipeKeysIgnored(rec); len(keys) > 0 {
			d.cfg.Log.Warn("localdocker.recipe.ignored", "machine", ref.MachineID, "keys", strings.Join(keys, ","))
		}
	}
	d.cfg.Log.Info("localdocker.boot.plan", "machine", ref.MachineID, "kind", run.report.Kind, "services", len(plan.services),
		"pulled", len(plan.pullFromRegistry), "exposed", len(plan.exposed), "recipe", rec != nil)

	if mode == buildImages {
		if err := run.phase(phaseBuild, func() error {
			if err := d.runSetup(ctx, checkout, rec); err != nil {
				return err
			}
			return d.docker.ComposeBuild(ctx, plan.project, plan.pullFromRegistry)
		}); err != nil {
			return err
		}
	}
	if err := run.phase(phaseUp, func() error { return d.docker.ComposeUp(ctx, plan.project) }); err != nil {
		return err
	}
	if err := d.rememberBoot(ref.MachineID, plan); err != nil {
		return err
	}
	if err := d.recordPublishedPorts(ctx, ref.MachineID, plan.published); err != nil {
		return err
	}
	if err := run.phase(phaseSeed, func() error {
		if err := d.migrate(ctx, checkout, rec); err != nil {
			return err
		}
		return d.seed(ctx, ref.MachineID, checkout, rec)
	}); err != nil {
		return err
	}
	if err := run.phase(phaseReady, func() error { return d.waitUntilHealthy(ctx, ref.MachineID, rec) }); err != nil {
		return err
	}
	if !wantsSnapshot(rec) || len(rec.FakeServices()) > 0 || d.hasSnapshot(ref.MachineID) {
		return nil
	}
	// The first ready boot (or the recreate a failed restore fell back to)
	// is what every snapshot reset starts from.
	var copyErr error
	if err := run.phase(phaseSnapshot, func() error {
		var upErr error
		copyErr, upErr = d.takeSnapshot(ctx, ref, plan)
		return upErr
	}); err != nil {
		return err
	}
	if copyErr != nil {
		d.cfg.Log.Warn("localdocker.reset.snapshot_fallback", "machine", ref.MachineID, "reason", "snapshot not taken: "+copyErr.Error())
	}
	// The services that were stopped are up again, maybe on new host
	// ports; the app must answer again before the claim is ready.
	if err := d.recordPublishedPorts(ctx, ref.MachineID, plan.published); err != nil {
		return err
	}
	return run.phase(phaseReady, func() error { return d.waitUntilHealthy(ctx, ref.MachineID, rec) })
}

// containerLabels are the claim's tags as Docker labels, for the sweep.
func containerLabels(machine string, tags map[string]string) map[string]string {
	labels := map[string]string{labelMachine: machine}
	for _, t := range []string{driver.TagCell, driver.TagEnv, driver.TagOrg, driver.TagClaim, driver.TagRole, driver.TagHardExpires, tagImage} {
		labels[dockercli.LabelFromTag(t)] = tags[t]
	}
	return labels
}

// runSetup runs the recipe's setup commands on the host, in the checkout.
func (d *Driver) runSetup(ctx context.Context, checkout string, rec *recipe.Recipe) error {
	if rec == nil {
		return nil
	}
	for i, c := range rec.Setup {
		if err := d.docker.Shell(ctx, checkout, rec.Services.Compose.Env, c); err != nil {
			return fmt.Errorf("setup[%d]: %w", i, err)
		}
	}
	return nil
}

// rememberBoot keeps what the agent and the observer read later: where the
// workload booted from, what it publishes, its services and seed.
func (d *Driver) rememberBoot(name string, plan *bootPlan) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if m := d.st.Machines[name]; m != nil {
		m.Dir, m.Expose, m.Services, m.SeedSha = plan.project.Dir, plan.exposed, plan.services, seedFingerprint(plan.project.Dir, plan.recipe)
	}
	return d.saveLocked()
}
