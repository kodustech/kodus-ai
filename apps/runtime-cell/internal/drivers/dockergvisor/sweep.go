package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// SweepExpired destroys every machine of this cell whose kodus:hard-expires
// has passed, and removes every other container of the cell past it (a
// builder a crashed or killed cell left running). Nothing of a claim
// outlives its ceiling, whatever happened to the cell: a machine goes with
// its project, volumes, built images and directories, and its claim
// network once no machine of the claim is left on it, as the independent
// reaper takes it (reap.go). A container with no or a bad ceiling is past
// it (driver.ParseExpiry).
func (d *Driver) SweepExpired(ctx context.Context, now time.Time) ([]string, error) {
	rp := d.reaper()
	gs, err := rp.expired(ctx, now)
	if err != nil {
		return nil, err
	}
	var gone []string
	var errs []error
	// Golden data of a machine already gone (golden.go), past its ceiling.
	all, err := rp.groups(ctx)
	if err != nil {
		return nil, err
	}
	live := map[string]bool{}
	for _, g := range all {
		live[g.name] = true
	}
	orphans, err := rp.orphanGolden(ctx, live)
	if err != nil {
		return nil, err
	}
	for _, o := range orphans {
		if driver.ParseExpiry(o.Tags, driver.TagHardExpires).After(now) {
			continue
		}
		if err := rp.removeGolden(ctx, o.MachineID); err != nil {
			errs = append(errs, err)
			continue
		}
		gone = append(gone, o.MachineID)
	}
	for _, g := range gs {
		var err error
		if g.machine() {
			err = d.destroyExpired(ctx, rp, g)
		} else {
			err = rp.removeLone(ctx, g.containers)
		}
		if err != nil {
			errs = append(errs, err)
			continue
		}
		gone = append(gone, g.name)
	}
	return gone, errors.Join(errs...)
}

// destroyExpired is Destroy for a machine past its ceiling, and what only
// the driver's memory would have removed when it has none of the machine
// (a cell that restarted): the images built for it and its directories.
// Then its claim network, which no release will come for.
func (d *Driver) destroyExpired(ctx context.Context, rp *Reaper, g reapGroup) error {
	if !machineNamePattern.MatchString(g.name) {
		return fmt.Errorf("dockergvisor: sweep: %q is not a machine name", g.name)
	}
	d.mu.Lock()
	_, known := d.machines[g.name]
	d.mu.Unlock()
	if d.cfg.ClaimLimits != nil {
		for _, network := range g.networks() {
			labels, err := d.d.NetworkLabels(ctx, network)
			if err != nil {
				return err
			}
			if labels == nil || labels["kodus.cell"] != d.cfg.CellID || labels["kodus.org"] == "" {
				continue
			}
			d.mu.Lock()
			if d.limitGroups == nil {
				d.limitGroups = map[string]limitGroup{}
			}
			if d.limitGroups[network].key == "" {
				d.limitGroups[network] = limitGroup{key: resourceKey(d.cfg.CellID, labels["kodus.org"], network), network: network}
			}
			d.mu.Unlock()
		}
	}
	err := d.Destroy(ctx, driver.MachineRef{MachineID: g.name, Tags: g.tags()})
	if err != nil {
		return err
	}
	if !known {
		err = errors.Join(rp.removeBuilt(ctx, g), rp.removeDirs(g.name))
	}
	return errors.Join(err, rp.releaseNetworks(ctx, g.networks()))
}

// Sweep is the cell's periodic sweep (cmd/cell): what SweepExpired removes,
// and a start of ReclaimDisk on a goroutine of its own. Removing a state or
// the trash may take minutes; a machine past its ceiling must not wait for
// it, so the sweep never does. A reclaim's error is logged, not returned.
func (d *Driver) Sweep(ctx context.Context, now time.Time) ([]string, error) {
	d.reclaim.start(d.ReclaimDisk, d.log())
	gone, err := d.SweepExpired(ctx, now)
	return gone, errors.Join(err, d.sweepLimitGroups(ctx))
}

// diskReclaim runs one reclaim at a time: a sweep that comes while the
// last one still removes bytes skips its turn instead of piling up a second
// walk of the same directories.
type diskReclaim struct {
	busy    atomic.Bool
	running sync.WaitGroup
}

// start runs reclaim on its own goroutine; false when one still runs.
func (r *diskReclaim) start(reclaim func() error, log *slog.Logger) bool {
	if !r.busy.CompareAndSwap(false, true) {
		return false
	}
	r.running.Add(1)
	go func() {
		defer r.running.Done()
		defer r.busy.Store(false)
		if err := reclaim(); err != nil {
			log.Warn("disk.reclaim.failed", "err", err)
		}
	}()
	return true
}

// wait returns once the reclaim started last has ended.
func (r *diskReclaim) wait() { r.running.Wait() }

// ReclaimDisk removes what may take gigabytes and no build holds: the least
// recently used BuildKit states while the disk is below its floor, and the
// build cache generations no build reads any more. It runs on the sweep,
// off every build's path.
func (d *Driver) ReclaimDisk() error {
	return errors.Join(d.states.Evict(), d.caches.Sweep())
}
