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

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildstate"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/gvisor"
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
	// Now is the orphan pass's clock (time.Now when nil).
	Now func() time.Time
}

// machineEnder is the part of an isolation backend the reaper needs: end a
// machine by its name, reading nothing from memory.
type machineEnder interface {
	Destroy(ctx context.Context, name string, opts isolation.DestroyOptions) error
}

// Reaper lists and destroys this cell's machines with no in-memory state.
type Reaper struct {
	d   reaperPort
	cfg ReaperConfig
	// ender ends a machine (its holder and project) through the isolation
	// backend, as Driver.Destroy does; the shared layer's leftovers (images,
	// directories, golden data, networks) stay here.
	ender machineEnder
	// mounted lists the overlays mounted under a directory (Linux
	// mountinfo); a build state directory with one is left to the cell.
	mounted func(under string) ([]buildstate.OverlayMount, error)
}

// NewForReaper is the reaper's driver: List and Destroy, nothing else. It
// checks no runtime and creates nothing, so it runs on a host whose cell
// is down.
func NewForReaper(d reaperPort, cfg ReaperConfig) (*Reaper, error) {
	if cfg.CellID == "" {
		return nil, errors.New("dockergvisor: reaper: cell id required")
	}
	if cfg.WorkDir == "" {
		return nil, errors.New("dockergvisor: reaper: work directory required")
	}
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.DiscardHandler)
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Reaper{d: d, cfg: cfg, ender: gvisor.NewEnder(d), mounted: buildstate.MountedOverlays}, nil
}

// reaper is the driver's own reaper, for the cell's sweep.
func (d *Driver) reaper() *Reaper {
	return &Reaper{d: d.d, cfg: ReaperConfig{CellID: d.cfg.CellID, WorkDir: d.workDir(), EgressContainer: d.cfg.EgressContainer, Log: d.log(), Now: d.clock.Now}, ender: d.backend, mounted: buildstate.MountedOverlays}
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
	delete(tags, driver.TagHardExpires)
	if !g.hard.IsZero() {
		tags[driver.TagHardExpires] = driver.FormatTime(g.hard)
	}
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
	for i := range cs {
		c := &cs[i]
		if c.Labels[dockercli.LabelFromTag(driver.TagCell)] != r.cfg.CellID {
			continue
		}
		key := c.Name
		if p := c.Labels[composeProjectLabel]; p != "" {
			key = p
		}
		// A project under the spare's name is its machine's (spare.go).
		if m := c.Labels[labelProjectOf]; m != "" && c.Labels[composeProjectLabel] == projectName(m, 1) {
			key = m
		}
		g := byName[key]
		if g == nil {
			g = &reapGroup{name: key}
			byName[key] = g
			order = append(order, key)
		}
		if c.Labels[labelMachine] == c.Name {
			h := *c
			g.holder = &h
		}
		g.containers = append(g.containers, *c)
		// A container with no or a bad ceiling is past it: zero, the
		// earliest, so its whole machine goes (driver.Expired).
		hard, _ := driver.Ceiling(dockercli.CeilingTags(c.Labels))
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
	// Its project under the spare's name too (spare.go).
	bySpare, err := r.d.IDs(ctx, dockercli.Filters{"label": {composeProjectLabel + "=" + projectName(machine, 1)}})
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var ids []string
	for _, id := range slices.Concat(byName, byProject, bySpare) {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	cs, err := r.d.Inspect(ctx, ids...)
	if err != nil {
		return nil, err
	}
	for i := range cs {
		if cs[i].Labels[dockercli.LabelFromTag(driver.TagCell)] != r.cfg.CellID {
			return nil, fmt.Errorf("%w: container %s", driver.ErrNotOwned, cs[i].Name)
		}
	}
	return cs, nil
}

func (r *Reaper) removeLone(ctx context.Context, cs []dockercli.Container) error {
	var errs []error
	for i := range cs {
		errs = append(errs, r.d.Remove(ctx, cs[i].ID))
	}
	return errors.Join(errs...)
}

// destroyMachine is Driver.Destroy without the driver's memory: the
// backend ends the machine (the project down with its volumes, the holder),
// then the images built under the machine's claim tags (named after the
// project's services), the build directories, and the claim networks it
// was on. Ownership was read from Docker before (machineContainers).
func (r *Reaper) destroyMachine(ctx context.Context, g reapGroup) error {
	if !machineNamePattern.MatchString(g.name) {
		return fmt.Errorf("dockergvisor: reaper: %q is not a machine name", g.name)
	}
	var errs []error
	errs = append(errs, r.ender.Destroy(ctx, g.name, isolation.DestroyOptions{}))
	// Each container by name too: what compose down left, or all of them
	// when it failed (rm -f of one already gone is done).
	for i := range g.containers {
		errs = append(errs, r.d.Remove(ctx, g.containers[i].Name))
	}
	// What compose down leaves: a volume a bake restored or a project whose
	// containers were already gone.
	errs = append(errs,
		r.removeProjectVolumes(ctx, g.name), r.removeGolden(ctx, g.name),
		r.removeBuilt(ctx, g), r.removeDirs(g.name),
		r.releaseNetworks(ctx, g.networks()))
	err := errors.Join(errs...)
	r.cfg.Log.Info("reaper.machine.destroyed", "machine", g.name, "claim", g.tags()[driver.TagClaim], "ok", err == nil)
	return err
}

// removeBuilt removes the images built for the machine, under the claim tag
// of each service its project ran (builtTag); one already gone is done.
func (r *Reaper) removeBuilt(ctx context.Context, g reapGroup) error {
	services := map[string]bool{}
	for i := range g.containers {
		if s := g.containers[i].Labels["com.docker.compose.service"]; s != "" {
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
	for i := range g.containers {
		for n := range g.containers[i].Networks {
			set[n] = true
		}
	}
	return sortedSet(set)
}

// removeProjectVolumes removes the volumes of the machine's project, under
// either of its names (spare.go).
func (r *Reaper) removeProjectVolumes(ctx context.Context, machine string) error {
	var names []string
	for _, project := range []string{projectName(machine, 0), projectName(machine, 1)} {
		vols, err := r.d.Volumes(ctx, map[string]string{composeProjectLabel: project})
		if err != nil {
			return err
		}
		for _, v := range vols {
			names = append(names, v.Name)
		}
	}
	if len(names) == 0 {
		return nil
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
		if idle, err := r.onlyEgressOn(ctx, n); err != nil || !idle {
			errs = append(errs, err)
			continue // another machine of the claim still uses it
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

// onlyEgressOn says no container but the cell's egress is on network n.
func (r *Reaper) onlyEgressOn(ctx context.Context, n string) (bool, error) {
	left, err := r.d.IDs(ctx, dockercli.Filters{"network": {n}})
	if err != nil || len(left) == 0 {
		return err == nil, err
	}
	cs, err := r.d.Inspect(ctx, left...)
	if err != nil {
		return false, err
	}
	return !slices.ContainsFunc(cs, func(c dockercli.Container) bool { return c.Name != r.cfg.EgressContainer }), nil
}

// idleNetworkGrace is how old a claim network with no machine on it must be
// before the sweep or the reaper takes it: a claim's network is made just
// before its first machine (PrepareClaim, then Create), and this margin
// covers that step on a slow Docker many times over.
const idleNetworkGrace = 15 * time.Minute

// idleNetworks are this cell's claim networks (labelled with a claim; never
// the observers' network) older than grace at now on which no
// container but the egress is left. Nothing else releases them when the
// lease that knew the network is gone: a cell that restarted with live
// claims (its lease sweep destroys their machines, not their networks), one
// that died between PrepareClaim and Create, or a ReleaseClaim that failed
// once (R3-01).
func (r *Reaper) idleNetworks(ctx context.Context, now time.Time, grace time.Duration) ([]string, error) {
	nets, err := r.d.NetworksLabelled(ctx, map[string]string{dockercli.LabelFromTag(driver.TagCell): r.cfg.CellID})
	if err != nil {
		return nil, err
	}
	var out []string
	var errs []error
	for _, n := range nets {
		if n.Labels[dockercli.LabelFromTag(driver.TagCell)] != r.cfg.CellID || n.Labels[dockercli.LabelFromTag(driver.TagClaim)] == "" {
			continue
		}
		if now.Sub(n.Created) < grace {
			continue
		}
		idle, err := r.onlyEgressOn(ctx, n.Name)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if idle {
			out = append(out, n.Name)
		}
	}
	slices.Sort(out)
	return out, errors.Join(errs...)
}

// Drain ends every machine of this cell, past its ceiling or not, the
// containers of the cell that belong to none, and then every claim network
// of the cell no machine is left on. It is what a cell starting under claim
// limits does with what its previous process left (cmd/cell): leases live in
// the cell's memory, so nothing of the new process adopts those claims, and
// their populated resource groups would refuse its start until each
// machine's ceiling passed (R3-04). It returns how many it ended.
func (r *Reaper) Drain(ctx context.Context) (int, error) {
	refs, err := r.List(ctx, map[string]string{driver.TagCell: r.cfg.CellID})
	if err != nil {
		return 0, err
	}
	var errs []error
	n := 0
	for _, ref := range refs {
		if err := r.Destroy(ctx, ref); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", ref.MachineID, err))
			continue
		}
		n++
	}
	idle, err := r.idleNetworks(ctx, r.cfg.Now(), 0)
	errs = append(errs, err, r.releaseNetworks(ctx, idle))
	return n, errors.Join(errs...)
}

// expired is this cell's groups past their ceiling at now.
func (r *Reaper) expired(ctx context.Context, now time.Time) ([]reapGroup, error) {
	gs, err := r.groups(ctx)
	if err != nil {
		return nil, err
	}
	var out []reapGroup
	for _, g := range gs {
		if driver.Expired(g.tags(), now) {
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
