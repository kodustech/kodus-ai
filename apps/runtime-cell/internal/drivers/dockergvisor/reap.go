package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

// The independent reaper's view of a docker-gvisor cell (S-08, cmd/reaper
// -driver docker-gvisor). It runs as its own process on the host, from a
// systemd timer, and needs nothing of the cell agent: everything it acts on
// is read back from Docker's labels and the cell's work directory. A
// machine here is what Destroy takes down: the holder, its compose
// project's containers and volumes, the images built for it, its build
// directories, and the claim network once no machine of the claim is left
// on it. Only containers and networks labelled with this cell's kodus.cell
// are ever touched, whatever a ref names.

// ReaperConfig is the part of the cell's configuration the reaper needs.
type ReaperConfig struct {
	CellID string
	// WorkDir is the driver's work directory (the cell's -workdir/compose):
	// where the builds, the build caches and states, and the claim
	// networks' resolv.conf live.
	WorkDir string
	// EgressContainer is the cell's egress container, which joined every
	// claim network: it leaves a network before the network goes.
	EgressContainer string
	Log             *slog.Logger
}

// Reaper lists and destroys this cell's machines with no in-memory state.
type Reaper struct {
	d   Docker
	cfg ReaperConfig
	// mounted lists the overlays mounted under a directory (Linux
	// mountinfo); a build state directory with one is left to the cell.
	mounted func(under string) ([]overlayMount, error)
}

// NewForReaper is the reaper's driver: List and Destroy, nothing else. It
// checks no runtime and creates nothing, so it runs on a host whose cell
// is down.
func NewForReaper(d Docker, cfg ReaperConfig) (*Reaper, error) {
	if cfg.CellID == "" {
		return nil, errors.New("dockergvisor: reaper: cell id required")
	}
	if cfg.WorkDir == "" {
		return nil, errors.New("dockergvisor: reaper: work directory required")
	}
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.DiscardHandler)
	}
	return &Reaper{d: d, cfg: cfg, mounted: hostOverlays}, nil
}

// reaper is the driver's own reaper, for the cell's sweep.
func (d *Driver) reaper() *Reaper {
	return &Reaper{d: d.d, cfg: ReaperConfig{CellID: d.cfg.CellID, WorkDir: d.workDir(), EgressContainer: d.cfg.EgressContainer, Log: d.log()}, mounted: hostOverlays}
}

// hostOverlays lists the overlays mounted under a directory; none where
// the cell mounts none (not Linux).
func hostOverlays(under string) ([]overlayMount, error) {
	m := defaultMounter()
	if m == nil {
		return nil, nil
	}
	return m.Mounted(under)
}

const composeProjectLabel = "com.docker.compose.project"

// machineNamePattern is what a machine name can be (machineName): it
// becomes a path segment of the work directory, so nothing else is taken.
var machineNamePattern = regexp.MustCompile(`^kodus-[a-z0-9][a-z0-9-]{0,80}$`)

// reapGroup is one machine as Docker shows it: its holder, its project's
// containers, or a container of the cell that belongs to neither (a
// builder a dead cell left).
type reapGroup struct {
	name       string
	holder     *dockercli.Container
	containers []dockercli.Container
	// hard is the earliest ceiling any of its containers carries: a
	// ceiling only goes down.
	hard time.Time
}

func (g reapGroup) machine() bool {
	return g.holder != nil || g.containers[0].Labels[composeProjectLabel] != ""
}

func (g reapGroup) tags() map[string]string {
	c := g.containers[0]
	if g.holder != nil {
		c = *g.holder
	}
	tags := map[string]string{}
	for k, v := range c.Labels {
		tags[dockercli.TagFromLabel(k)] = v
	}
	tags[driver.TagHardExpires] = driver.FormatTime(g.hard)
	return tags
}

// groups reads every container of this cell (one ps, one inspect) and
// groups them by machine.
func (r *Reaper) groups(ctx context.Context) ([]reapGroup, error) {
	ids, err := r.d.IDs(ctx, dockercli.Filters{"label": {dockercli.LabelFromTag(driver.TagCell) + "=" + r.cfg.CellID}})
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	cs, err := r.d.Inspect(ctx, ids...)
	if err != nil {
		return nil, err
	}
	byName := map[string]*reapGroup{}
	var order []string
	for _, c := range cs {
		if c.Labels[dockercli.LabelFromTag(driver.TagCell)] != r.cfg.CellID {
			continue
		}
		key := c.Name
		if p := c.Labels[composeProjectLabel]; p != "" {
			key = p
		}
		g := byName[key]
		if g == nil {
			g = &reapGroup{name: key}
			byName[key] = g
			order = append(order, key)
		}
		if c.Labels[labelMachine] == c.Name {
			h := c
			g.holder = &h
		}
		g.containers = append(g.containers, c)
		// A container with no or a bad ceiling is past it (ParseExpiry).
		hard := driver.ParseExpiry(map[string]string{driver.TagHardExpires: c.Labels[dockercli.LabelFromTag(driver.TagHardExpires)]}, driver.TagHardExpires)
		if len(g.containers) == 1 || hard.Before(g.hard) {
			g.hard = hard
		}
	}
	out := make([]reapGroup, 0, len(order))
	for _, k := range order {
		out = append(out, *byName[k])
	}
	return out, nil
}

// List is this cell's machines, and the containers of the cell that belong
// to none, each with the earliest kodus:hard-expires its containers carry.
// A selector naming another cell finds nothing.
func (r *Reaper) List(ctx context.Context, selector map[string]string) ([]driver.MachineRef, error) {
	if cell, ok := selector[driver.TagCell]; ok && cell != r.cfg.CellID {
		return nil, nil
	}
	gs, err := r.groups(ctx)
	if err != nil {
		return nil, err
	}
	var out []driver.MachineRef
	live := map[string]bool{}
	for _, g := range gs {
		live[g.name] = true
		tags := g.tags()
		if !driver.Matches(tags, selector) {
			continue
		}
		ref := driver.MachineRef{MachineID: g.name, DriverRef: g.containers[0].ID, ImageID: tags["kodus:image"], Tags: tags}
		if g.holder != nil {
			ref.DriverRef = g.holder.ID
		}
		out = append(out, ref)
	}
	// A machine whose containers are gone but whose golden data is not is
	// one more to destroy, past the ceiling its volumes carry.
	orphans, err := r.orphanGolden(ctx, live)
	if err != nil {
		return nil, err
	}
	for _, o := range orphans {
		if driver.Matches(o.Tags, selector) {
			out = append(out, o)
		}
	}
	return out, nil
}

// Destroy takes the machine down with everything it holds, after reading
// its owner from Docker: one container under its name or project that is
// not this cell's refuses the whole machine.
func (r *Reaper) Destroy(ctx context.Context, ref driver.MachineRef) error {
	cs, err := r.machineContainers(ctx, ref.MachineID)
	if err != nil {
		return err
	}
	if len(cs) == 0 {
		// Already gone, but for golden data a crash may have left (orphanGolden).
		if !machineNamePattern.MatchString(ref.MachineID) {
			return nil
		}
		return r.removeGolden(ctx, ref.MachineID)
	}
	g := reapGroup{name: ref.MachineID, containers: cs}
	for i := range cs {
		if cs[i].Labels[labelMachine] == cs[i].Name {
			g.holder = &cs[i]
		}
	}
	if !g.machine() {
		return r.removeLone(ctx, cs)
	}
	return r.destroyMachine(ctx, g)
}

// machineContainers is every container named machine or of its project,
// refused with ErrNotOwned when one is another cell's or no one's.
func (r *Reaper) machineContainers(ctx context.Context, machine string) ([]dockercli.Container, error) {
	byName, err := r.d.IDs(ctx, dockercli.Filters{"name": {"^/?" + regexp.QuoteMeta(machine) + "$"}})
	if err != nil {
		return nil, err
	}
	byProject, err := r.d.IDs(ctx, dockercli.Filters{"label": {composeProjectLabel + "=" + machine}})
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var ids []string
	for _, id := range append(byName, byProject...) {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	cs, err := r.d.Inspect(ctx, ids...)
	if err != nil {
		return nil, err
	}
	for _, c := range cs {
		if c.Labels[dockercli.LabelFromTag(driver.TagCell)] != r.cfg.CellID {
			return nil, fmt.Errorf("%w: container %s", driver.ErrNotOwned, c.Name)
		}
	}
	return cs, nil
}

func (r *Reaper) removeLone(ctx context.Context, cs []dockercli.Container) error {
	var errs []error
	for _, c := range cs {
		errs = append(errs, r.d.Remove(ctx, c.ID))
	}
	return errors.Join(errs...)
}

// destroyMachine is Driver.Destroy without the driver's memory: the
// project down with its volumes, the holder, the images built under the
// machine's claim tags (named after the project's services), the build
// directories, and then the claim networks it was on.
func (r *Reaper) destroyMachine(ctx context.Context, g reapGroup) error {
	if !machineNamePattern.MatchString(g.name) {
		return fmt.Errorf("dockergvisor: reaper: %q is not a machine name", g.name)
	}
	var errs []error
	errs = append(errs, r.d.ComposeDown(ctx, g.name, true))
	// Each container by name too: what compose down left, or all of them
	// when it failed (rm -f of one already gone is done).
	for _, c := range g.containers {
		errs = append(errs, r.d.Remove(ctx, c.Name))
	}
	// What compose down leaves: a volume a bake restored or a project whose
	// containers were already gone.
	errs = append(errs, r.removeProjectVolumes(ctx, g.name), r.removeGolden(ctx, g.name))
	errs = append(errs, r.removeBuilt(ctx, g), r.removeDirs(g.name))
	errs = append(errs, r.releaseNetworks(ctx, g.networks()))
	err := errors.Join(errs...)
	r.cfg.Log.Info("reaper.machine.destroyed", "machine", g.name, "claim", g.tags()[driver.TagClaim], "ok", err == nil)
	return err
}

// removeBuilt removes the images built for the machine, under the claim tag
// of each service its project ran (builtTag); one already gone is done.
func (r *Reaper) removeBuilt(ctx context.Context, g reapGroup) error {
	services := map[string]bool{}
	for _, c := range g.containers {
		if s := c.Labels["com.docker.compose.service"]; s != "" {
			services[s] = true
		}
	}
	var errs []error
	for _, s := range sortedSet(services) {
		errs = append(errs, r.d.RemoveImage(ctx, builtTag(g.name, s)))
	}
	return errors.Join(errs...)
}

// networks are the networks the group's containers are on.
func (g reapGroup) networks() []string {
	set := map[string]bool{}
	for _, c := range g.containers {
		for n := range c.Networks {
			set[n] = true
		}
	}
	return sortedSet(set)
}

func (r *Reaper) removeProjectVolumes(ctx context.Context, machine string) error {
	vols, err := r.d.Volumes(ctx, map[string]string{composeProjectLabel: machine})
	if err != nil || len(vols) == 0 {
		return err
	}
	names := make([]string, 0, len(vols))
	for _, v := range vols {
		names = append(names, v.Name)
	}
	return r.d.VolumeRemove(ctx, names...)
}

// removeDirs removes the machine's directories under the work directory: a
// build's output, its writable build cache, its decoy file, and its build
// state overlays unless one is still mounted (the cell unmounts those when
// it starts).
func (r *Reaper) removeDirs(machine string) error {
	if !machineNamePattern.MatchString(machine) {
		return fmt.Errorf("dockergvisor: reaper: %q is not a machine name", machine)
	}
	var errs []error
	for _, dir := range []string{
		filepath.Join(r.cfg.WorkDir, "builds", machine),
		filepath.Join(r.cfg.WorkDir, "cache", "machine", machine),
	} {
		errs = append(errs, os.RemoveAll(dir))
	}
	errs = append(errs, removeDecoyFile(decoyPath(r.cfg.WorkDir, machine)))
	state := filepath.Join(r.cfg.WorkDir, "buildkit", "machine", machine)
	if _, err := os.Stat(state); err == nil {
		mounted, merr := r.mounted(state)
		switch {
		case merr != nil:
			errs = append(errs, merr)
		case len(mounted) > 0:
			r.cfg.Log.Warn("reaper.state.mounted", "machine", machine, "overlays", len(mounted))
		default:
			errs = append(errs, os.RemoveAll(state))
		}
	}
	return errors.Join(errs...)
}

// releaseNetworks removes each claim network of this cell (labelled with
// its claim; never the observers' network) on which no container but the
// egress is left: the last machine of a claim takes its network with it.
func (r *Reaper) releaseNetworks(ctx context.Context, names []string) error {
	var errs []error
	for _, n := range names {
		labels, err := r.d.NetworkLabels(ctx, n)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if labels == nil || labels[dockercli.LabelFromTag(driver.TagCell)] != r.cfg.CellID || labels[dockercli.LabelFromTag(driver.TagClaim)] == "" {
			continue
		}
		left, err := r.d.IDs(ctx, dockercli.Filters{"network": {n}})
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if len(left) > 0 {
			cs, err := r.d.Inspect(ctx, left...)
			if err != nil {
				errs = append(errs, err)
				continue
			}
			if other := slices.IndexFunc(cs, func(c dockercli.Container) bool { return c.Name != r.cfg.EgressContainer }); other >= 0 {
				continue // another machine of the claim still uses it
			}
		}
		if r.cfg.EgressContainer != "" {
			if err := r.d.NetworkDisconnect(ctx, n, r.cfg.EgressContainer); err != nil {
				errs = append(errs, err)
				continue
			}
		}
		if err := os.Remove(filepath.Join(r.cfg.WorkDir, "resolv", n+".conf")); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
		errs = append(errs, r.d.NetworkRemove(ctx, n))
	}
	return errors.Join(errs...)
}

// expired is this cell's groups past their ceiling at now.
func (r *Reaper) expired(ctx context.Context, now time.Time) ([]reapGroup, error) {
	gs, err := r.groups(ctx)
	if err != nil {
		return nil, err
	}
	var out []reapGroup
	for _, g := range gs {
		if !g.hard.After(now) {
			out = append(out, g)
		}
	}
	return out, nil
}

func sortedSet(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
