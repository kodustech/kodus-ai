package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// The warm fork reset (Config.WarmForkReset, driver.SpareKeeper;
// docs/runtime/gvisor-warm-fork-reset.md). A reset brings the project down
// and up again, and on a large app nearly all of its time is the services
// starting (kodus-ai: 88-111 s of 97-122 s). With no memory snapshot to
// restore, the next best is a second copy already started: while a round
// runs, the machine's spare boots beside its project, and the reset swaps
// it in.
//
// The two copies share everything a boot of the machine shares: the claim
// network, its egress and resolver, the holder and its cgroup parent, the
// images built for the machine, the decoy file, the trust files and the
// coverage directory. What they cannot share is a name and an address, so
// a machine's project runs under one of two names, each in its own half of
// the subnet's service addresses (sandbox.ServiceAddressesIn): the
// machine's name in block 0 (its first boot, and every machine with no
// spare), and <machine>-w in block 1. A spare takes whichever its project
// is not in; the swap ends the used copy and keeps the spare where it is.
//
// What a spare boots from is what a reset's Up boots from, and nothing
// else (S-52): the images of the machine's own builds, the environment's
// baked volumes (restoreData) and the first boot's golden copies
// (restoreGolden), copied into volumes of its own project that it removes
// first. It never sees a volume or a container of the copy its rounds
// used. A PR's spare runs the PR's images, as the reset it replaces would.

const (
	// spareSuffix names a machine's project in address block 1.
	spareSuffix = "-w"
	// labelProjectOf names the machine on every container of a project
	// that does not carry the machine's own name, so Destroy, the sweep
	// and the reaper find it with the machine.
	labelProjectOf = "kodus.project-of"
)

// ErrSparesOff is a spare asked of a machine whose spares are off: one of
// them failed, and the machine resets as before from then on.
var ErrSparesOff = errors.New("dockergvisor: the machine's warm spares are off")

// projectName is the machine's compose project in an address block.
func projectName(machine string, block int) string {
	if block == 1 {
		return machine + spareSuffix
	}
	return machine
}

// projectOf is the compose project the machine's services run under now,
// and its address block: the machine's own name in block 0 until a swap
// moved it.
func (d *Driver) projectOf(machine string) (string, int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.machines[machine]
	if m == nil || m.project == "" {
		return machine, 0
	}
	return m.project, m.block
}

// spareState is a machine's warm spare, booting or ready.
type spareState struct {
	project string
	block   int
	cancel  context.CancelFunc
	// done is closed when its boot returned, whatever it returned.
	done  chan struct{}
	ready bool
	// What its boot found (projectBoot.record), the machine's once it
	// takes over.
	sources                              []string
	services                             map[string]string
	exec                                 *execTarget
	targets, repoExec                    map[string]execTarget
	restoredData, seedAtInit, seedInData bool
}

// view is the spare as a machine's state, for the recipe's steps.
func (s *spareState) view() machineState {
	return machineState{services: s.services, exec: s.exec, targets: s.targets, repoExec: s.repoExec, restoredData: s.restoredData, seedAtInit: s.seedAtInit, seedInData: s.seedInData}
}

// BootSpare is driver.SpareKeeper's: it boots the machine's spare from req
// (the Up its project last got) in the block its project is not in, tells
// before the spare's addresses once compose's output is checked and before
// any container starts, and runs the recipe's boot steps in it. A spare
// that fails is removed and turns the machine's spares off; one ended by
// DropSpare or Destroy (its context cancelled) does not.
func (d *Driver) BootSpare(ctx context.Context, req driver.UpRequest, before func(sources []string) error) (err error) {
	ref := req.Ref
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return err
	}
	sp, ctx, err := d.startSpare(ctx, ref.MachineID)
	if err != nil {
		return err
	}
	defer close(sp.done)
	defer func() {
		if err == nil {
			return
		}
		cancelled := ctx.Err() != nil
		d.mu.Lock()
		m := d.machineLocked(ref.MachineID)
		if m.spare == sp {
			m.spare = nil
			m.spareOff = m.spareOff || !cancelled
		}
		d.mu.Unlock()
		cleanup, cancel := spareCleanup(ctx)
		defer cancel()
		if rerr := d.downProject(cleanup, sp.project); rerr != nil {
			err = errors.Join(err, rerr)
		}
		if !cancelled {
			d.log().Warn("spare.failed", "machine", ref.MachineID, "project", sp.project, "err", err)
		}
	}()
	// Nothing the block's name may still hold reaches the spare: its
	// containers and volumes start new, once the used copy that had the
	// name is down.
	if err := d.waitDrained(ctx, ref.MachineID); err != nil {
		return err
	}
	if err := d.downProject(ctx, sp.project); err != nil {
		return err
	}
	at := d.clock.Now()
	if _, err := d.upProject(ctx, req, sp, before); err != nil {
		return err
	}
	if err := d.runRecipe(ctx, ref.MachineID, sp.view(), req.ProjectDir, req.Output, false); err != nil {
		return err
	}
	d.mu.Lock()
	m := d.machineLocked(ref.MachineID)
	if m.spare != sp {
		d.mu.Unlock()
		return context.Canceled // dropped while it booted
	}
	sp.ready = true
	d.mu.Unlock()
	d.log().Info("spare.ready", "machine", ref.MachineID, "project", sp.project, "block", sp.block, "ms", d.clock.Now().Sub(at).Milliseconds())
	return nil
}

// startSpare records a new spare of the machine, in the block its project
// is not in, under a context its drop cancels.
func (d *Driver) startSpare(ctx context.Context, machine string) (*spareState, context.Context, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.machineLocked(machine)
	switch {
	case m.spareOff:
		return nil, nil, ErrSparesOff
	case m.swapping:
		return nil, nil, errors.New("dockergvisor: the machine's spare is being swapped in")
	case m.spare != nil:
		return nil, nil, errors.New("dockergvisor: the machine has a spare already")
	case m.setup:
		// A setup's volumes are what a bake copies (S-52).
		return nil, nil, fmt.Errorf("%w: a setup's machine keeps no spare", driver.ErrUnsupported)
	case m.services == nil:
		return nil, nil, errors.New("dockergvisor: the machine has no project up")
	case len(m.services) > sandbox.AddressBlockSize:
		m.spareOff = true
		return nil, nil, fmt.Errorf("%w: %d services do not fit one address block", ErrSparesOff, len(m.services))
	}
	block := 1 - m.block
	sctx, cancel := context.WithCancel(ctx)
	sp := &spareState{project: projectName(machine, block), block: block, cancel: cancel, done: make(chan struct{})}
	m.spare = sp
	return sp, sctx, nil
}

// TakeSpare is driver.SpareKeeper's: a ready spare whose containers all
// still run becomes the machine's project, once the copy its rounds used
// is killed (its down with its volumes follows in the background). ok false: no spare is ready (one may still be
// booting, and stays). An error removes the spare and turns spares off;
// the project the machine had is left as it was for the reset that follows.
func (d *Driver) TakeSpare(ctx context.Context, ref driver.MachineRef) (sources []string, ok bool, err error) {
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return nil, false, err
	}
	d.mu.Lock()
	m := d.machineLocked(ref.MachineID)
	sp := m.spare
	if sp == nil || !sp.ready {
		d.mu.Unlock()
		return nil, false, nil
	}
	// Taken, or failed: no one else takes or drops it, and no new spare
	// starts in its block until the swap is over.
	m.spare, m.swapping = nil, true
	sp.cancel() // its boot is over: nothing listens on its context
	used := m.project
	if used == "" {
		used = ref.MachineID
	}
	d.mu.Unlock()
	at := d.clock.Now()
	defer func() {
		d.mu.Lock()
		d.machineLocked(ref.MachineID).swapping = false
		d.mu.Unlock()
	}()
	fail := func(err error) ([]string, bool, error) {
		d.mu.Lock()
		d.machineLocked(ref.MachineID).spareOff = true
		d.mu.Unlock()
		cleanup, cancel := spareCleanup(ctx)
		defer cancel()
		err = errors.Join(err, d.downProject(cleanup, sp.project))
		d.log().Warn("spare.swap.failed", "machine", ref.MachineID, "project", sp.project, "err", err)
		return nil, false, err
	}
	if err := d.spareRunning(ctx, sp); err != nil {
		return fail(err)
	}
	// The used copy ends first: killed, so nothing of it runs on or holds
	// memory. Its containers and volumes go right after, off the reset's
	// path (usedDown); the next spare under its name waits for that.
	if err := d.d.ComposeKill(ctx, used, "SIGKILL"); err != nil {
		return fail(fmt.Errorf("kill %s: %w", used, err))
	}
	killMs := d.clock.Now().Sub(at).Milliseconds()
	drained := d.usedDown(ctx, ref.MachineID, used)
	total := d.clock.Now().Sub(at).Milliseconds()
	d.mu.Lock()
	m = d.machineLocked(ref.MachineID)
	m.project, m.block = sp.project, sp.block
	m.services, m.exec, m.targets, m.repoExec = sp.services, sp.exec, sp.targets, sp.repoExec
	m.restoredData, m.seedAtInit, m.seedInData = sp.restoredData, sp.seedAtInit, sp.seedInData
	m.reset, m.draining = nil, drained
	timing := driver.BootTiming{Kind: "reset", At: at, TotalMs: total, DownMs: killMs, Phases: []driver.BootPhase{{Name: "swap to the warm spare", Ms: total}}}
	m.boot = &claimBoot{claim: ref.Tags[driver.TagClaim], timing: timing}
	m.phases = &claimPhases{claim: ref.Tags[driver.TagClaim], phases: timing.Phases}
	d.mu.Unlock()
	d.log().Info("reset.timing", "machine", ref.MachineID, "totalMs", total, "downMs", killMs, "swap", true, "project", sp.project)
	return slices.Clone(sp.sources), true, nil
}

// usedDown takes the killed used copy down with its volumes in the
// driver's background group, and returns what closes when it is gone. A
// failure is logged: Destroy, the sweep and the reaper still take it.
func (d *Driver) usedDown(ctx context.Context, machine, project string) chan struct{} {
	done := make(chan struct{})
	down := func(life context.Context) error {
		defer close(done)
		cleanup, cancel := spareCleanup(life)
		defer cancel()
		if err := d.downProject(cleanup, project); err != nil {
			d.log().Warn("spare.used_down.failed", "machine", machine, "project", project, "err", err)
		}
		return nil
	}
	if !d.bg.Go("warm fork used copy", down) {
		_ = down(ctx) // the driver is closing: down it here
	}
	return done
}

// waitDrained waits for the machine's last used copy to be down, if one
// is going down, within ctx.
func (d *Driver) waitDrained(ctx context.Context, machine string) error {
	d.mu.Lock()
	var ch chan struct{}
	if m := d.machines[machine]; m != nil {
		ch = m.draining
	}
	d.mu.Unlock()
	if ch == nil {
		return nil
	}
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// spareRunning checks that every container the spare's boot found still
// runs: a spare whose app died while it waited is no fresh round.
func (d *Driver) spareRunning(ctx context.Context, sp *spareState) error {
	ids, err := d.d.IDs(ctx, dockercli.Filters{"label": {composeProjectLabel + "=" + sp.project}})
	if err != nil {
		return err
	}
	cs, err := d.d.Inspect(ctx, ids...)
	if err != nil {
		return err
	}
	running := map[string]bool{}
	for i := range cs {
		if cs[i].Labels[dockercli.LabelFromTag(driver.TagCell)] != d.cfg.CellID {
			return fmt.Errorf("%w: container %s", driver.ErrNotOwned, cs[i].Name)
		}
		if cs[i].PID > 0 {
			running[cs[i].Labels["com.docker.compose.service"]] = true
		}
	}
	for svc := range sp.services {
		if !running[svc] {
			return fmt.Errorf("dockergvisor: the spare's %s no longer runs", svc)
		}
	}
	return nil
}

// DropSpare is driver.SpareKeeper's: the spare's boot is cancelled and
// waited for, and its project goes down with its volumes. Spares stay on.
func (d *Driver) DropSpare(ctx context.Context, ref driver.MachineRef) (bool, error) {
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return false, err
	}
	return d.endSpare(ctx, ref.MachineID)
}

// endSpare ends the machine's spare, if it has one: DropSpare and Destroy.
func (d *Driver) endSpare(ctx context.Context, machine string) (bool, error) {
	d.mu.Lock()
	m := d.machines[machine]
	var sp *spareState
	if m != nil {
		sp, m.spare = m.spare, nil
	}
	d.mu.Unlock()
	if sp == nil {
		return false, nil
	}
	sp.cancel()
	select {
	case <-sp.done:
	case <-ctx.Done():
		return true, ctx.Err()
	case <-d.clock.After(spareStopWait):
		// A boot that does not end on cancel: its project goes anyway.
	}
	cleanup, cancel := spareCleanup(ctx)
	defer cancel()
	return true, d.downProject(cleanup, sp.project)
}

// spareCleanup outlives a cancelled caller long enough to take a whole
// project down (compose down of a dozen services under runsc).
func spareCleanup(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
}

// spareStopWait bounds how long a drop waits for a cancelled boot.
const spareStopWait = 30 * time.Second

// downSpareName takes down the machine's project under the spare's name
// when anything of it is left (Destroy): the isolation backend downs the
// one under the machine's own name.
func (d *Driver) downSpareName(ctx context.Context, machine string) error {
	other := projectName(machine, 1)
	ids, err := d.d.IDs(ctx, dockercli.Filters{"label": {composeProjectLabel + "=" + other}})
	if err != nil {
		return err
	}
	if len(ids) > 0 {
		if err := d.d.ComposeDown(ctx, other, true); err != nil {
			return fmt.Errorf("dockergvisor: down %s: %w", other, err)
		}
	}
	return d.removeProjectVolumes(ctx, other)
}

// downProject takes a compose project down with every volume it holds.
func (d *Driver) downProject(ctx context.Context, project string) error {
	if err := d.d.ComposeDown(ctx, project, true); err != nil {
		return fmt.Errorf("dockergvisor: down %s: %w", project, err)
	}
	return d.removeProjectVolumes(ctx, project)
}
