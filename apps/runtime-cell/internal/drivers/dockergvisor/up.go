package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// Up runs the claim's compose project after the allowlist rewrite and the
// second check of compose's canonical output. Nothing starts if either
// refuses. It returns the containers' addresses on the claim network.
//
// The steps run in this order and each leaves what the next needs in the
// projectBoot. The first that fails ends it.
func (d *Driver) Up(ctx context.Context, ref driver.MachineRef, composeFile []byte, projectDir string) ([]string, error) {
	b := &projectBoot{d: d, ctx: ctx, ref: ref, composeFile: composeFile, projectDir: projectDir}
	defer b.finish()
	for _, step := range []func() error{
		b.sandbox, // the claim's network, limits and decoy: what compose is rewritten with
		b.build,   // the project's images, and which data volumes it has
		b.render,  // the cell's compose file, checked against what compose will run
		b.data,    // the data the app starts on: a golden copy, the bake's, or fresh
		b.up,      // compose up, and what came up
		b.record,  // timing, and what the machine now runs
	} {
		if err := step(); err != nil {
			return nil, err
		}
	}
	return b.sources, nil
}

// projectBoot is one Up of a machine's compose project: what each step leaves for
// the next. It lives for one Up call.
type projectBoot struct {
	d           *Driver
	ctx         context.Context
	ref         driver.MachineRef
	composeFile []byte
	projectDir  string

	// reset is the reset this boot follows (its down is the boot's first
	// phase); nil for a first boot.
	reset           *pendingReset
	network, resolv string
	subnet          netip.Prefix
	opts            sandbox.Options

	started time.Time
	steps   driver.BuildSteps
	buildMs int64
	// keys are the project's data volumes; abs its directory.
	keys []string
	abs  string

	// gold is the machine's golden data a reset restores; firstTry a first
	// boot that may take one.
	gold       *golden
	firstTry   bool
	project    dockercli.ComposeProject
	canonical  []byte
	rec        *recipe.Recipe
	seedAtInit bool
	plan       *goldenPlan
	why        string
	// seedInData: this Up's data holds the recipe's seed already; nil
	// leaves what the last Up said (no reset: same data).
	seedInData            *bool
	restoreMs, snapshotMs int64

	restoreAt, upAt, upped time.Time
	restored               int
	cs                     []dockercli.Container
	sources                []string
	// files are the compose files this boot rendered, removed when it ends.
	files []string
}

func (b *projectBoot) finish() {
	for _, f := range b.files {
		os.Remove(f)
	}
}

// renderProject renders the cell's compose file and remembers it for removal.
func (b *projectBoot) renderProject() (dockercli.ComposeProject, []byte, error) {
	project, canonical, err := b.d.render(b.ctx, b.ref.MachineID, b.abs, b.composeFile, b.opts)
	if err == nil {
		b.files = append(b.files, project.File)
	}
	return project, canonical, err
}

// sandbox reads where the machine runs (its claim network, cgroup parent and
// limits) and plants the decoy: the options compose is rewritten with.
func (b *projectBoot) sandbox() error {
	d, ctx, ref := b.d, b.ctx, b.ref
	// A reset's down is the first phase of the boot that follows it.
	d.mu.Lock()
	b.reset = d.machineLocked(ref.MachineID).reset
	d.machineLocked(ref.MachineID).reset = nil
	d.mu.Unlock()
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return err
	}
	b.network = networkName(ref.Tags[driver.TagClaim])
	resolv, err := d.claimResolv(b.network)
	if err != nil {
		return err
	}
	b.resolv = resolv
	raw, err := d.d.NetworkSubnet(ctx, b.network)
	if err != nil {
		return err
	}
	if b.subnet, err = netip.ParsePrefix(raw); err != nil {
		return fmt.Errorf("dockergvisor: subnet of %s: %w", b.network, err)
	}
	parent, err := d.parentFor(ctx, ref)
	if err != nil {
		return err
	}
	mem, cpus := d.limits(ref.MachineID)
	b.opts = sandbox.Options{
		CgroupParent: parent,
		ProjectDir:   b.projectDir, Project: ref.MachineID, Runtime: d.cfg.Runtime, PidsLimit: d.cfg.PidsLimit,
		MemLimit: mem, CPUs: cpus, Network: b.network, Subnet: b.subnet, Resolv: b.resolv,
		HealthStartInterval: d.healthEvery,
		Labels: toLabels(map[string]string{
			driver.TagCell: d.cfg.CellID, driver.TagOrg: ref.Tags[driver.TagOrg], driver.TagClaim: ref.Tags[driver.TagClaim],
			driver.TagRole: ref.Tags[driver.TagRole], driver.TagHardExpires: ref.Tags[driver.TagHardExpires],
		}),
	}
	if b.opts.Decoy, err = d.writeDecoy(ref.MachineID, driver.CanariesFrom(ctx)); err != nil {
		return fmt.Errorf("dockergvisor: decoy file: %w", err)
	}
	return nil
}

// build builds the project's images and reads which data volumes it has.
func (b *projectBoot) build() error {
	d, ctx, ref := b.d, b.ctx, b.ref
	builds, err := sandbox.Builds(b.composeFile, b.opts)
	if err != nil {
		return err
	}
	b.started = d.clock.Now()
	if b.opts.Built, b.steps, err = d.build(ctx, ref, builds, b.network, b.resolv, b.subnet); err != nil {
		return err
	}
	b.buildMs = d.clock.Now().Sub(b.started).Milliseconds()
	if b.keys, err = dataKeys(b.composeFile, b.projectDir); err != nil {
		return fmt.Errorf("dockergvisor: data volumes: %w", err)
	}
	d.mu.Lock()
	if o := d.machineLocked(ref.MachineID).output; o != nil {
		o.volumes = b.keys
	}
	d.mu.Unlock()
	if b.abs, err = filepath.Abs(b.projectDir); err != nil {
		return err
	}
	return nil
}

// render writes the cell's compose file, with the machine's golden data
// mounted when a reset has one, and plans the golden copy from what compose
// will really run. Golden data that no longer fits is dropped and the
// project rendered again without it.
func (b *projectBoot) render() error {
	d, ctx, ref := b.d, b.ctx, b.ref
	// A reset of a machine with golden data mounts it where the image kept
	// its data in an anonymous volume (golden.go).
	d.mu.Lock()
	b.gold = d.machineLocked(ref.MachineID).golden
	b.firstTry = b.gold == nil && !d.machineLocked(ref.MachineID).goldenOff && !d.cfg.NoGoldenData
	d.mu.Unlock()
	if b.reset == nil {
		b.gold = nil
	}
	if b.gold != nil {
		b.opts.DataVolumes = b.gold.dataVolumes()
	}
	var err error
	b.project, b.canonical, err = b.renderProject()
	if err != nil && b.gold != nil {
		d.goldenOff(ctx, ref.MachineID, "render: "+err.Error())
		b.gold, b.opts.DataVolumes = nil, nil
		b.project, b.canonical, err = b.renderProject()
	}
	if err != nil {
		return err
	}
	b.rec, _ = recipe.Load(b.projectDir) // read and refused by the agent already
	if b.reset == nil {
		warnUnapplied(d.log(), ref.MachineID, b.rec)
	}
	b.seedAtInit = seedRunsAtInit(b.canonical, b.abs, b.rec)
	b.plan, b.why = planGolden(b.canonical, b.composeFile, b.abs, b.rec, b.seedAtInit, b.opts.DataVolumes)
	if b.gold != nil && (b.plan == nil || b.plan.sum != b.gold.sum) {
		// What the copy was made from changed: recreate, as before it.
		d.goldenOff(ctx, ref.MachineID, "inputs changed")
		b.gold, b.opts.DataVolumes = nil, nil
		os.Remove(b.project.File)
		if b.project, _, err = b.renderProject(); err != nil {
			return err
		}
	}
	return nil
}

// data puts in place the data the app starts on: the machine's golden copy
// restored (a reset), a golden copy taken (a first boot whose plan allows
// one), and what the environment's bake kept.
func (b *projectBoot) data() error {
	d, ctx, ref := b.d, b.ctx, b.ref
	switch {
	case b.gold != nil:
		at := d.clock.Now()
		if err := d.restoreGolden(ctx, ref, b.gold); err != nil {
			d.goldenOff(ctx, ref.MachineID, err.Error())
			b.opts.DataVolumes = nil
			os.Remove(b.project.File)
			if b.project, _, err = b.renderProject(); err != nil {
				return err
			}
			b.seedInData = new(false)
		} else {
			b.restoreMs = d.clock.Now().Sub(at).Milliseconds()
			b.seedInData = new(b.gold.seeded)
			d.log().Info("data.golden.restored", "machine", ref.MachineID, "volumes", len(b.gold.vols), "ms", b.restoreMs)
		}
	case b.reset != nil:
		b.seedInData = new(false)
	case b.firstTry && b.plan == nil:
		d.goldenOff(ctx, ref.MachineID, b.why)
	case b.firstTry:
		at := d.clock.Now()
		g, seeded, err := d.takeGolden(ctx, ref, b.project, b.plan, b.abs, b.rec)
		b.seedInData = new(seeded)
		var seedErr *goldenSeedError
		if errors.As(err, &seedErr) {
			return seedErr.err
		}
		b.snapshotMs = d.clock.Now().Sub(at).Milliseconds()
		if err != nil {
			d.goldenOff(ctx, ref.MachineID, err.Error())
		} else {
			d.mu.Lock()
			d.machineLocked(ref.MachineID).golden = g
			d.mu.Unlock()
			d.log().Info("data.golden.taken", "machine", ref.MachineID, "services", strings.Join(b.plan.services, ","), "volumes", len(g.vols), "seeded", g.seeded, "ms", b.snapshotMs)
		}
	}
	b.restoreAt = d.clock.Now()
	restored, err := d.restoreData(ctx, ref, b.keys)
	if err != nil {
		return fmt.Errorf("dockergvisor: data from the bake: %w", err)
	}
	b.restored = restored
	if restored > 0 {
		d.log().Info("data.restored", "machine", ref.MachineID, "volumes", restored)
	}
	return nil
}

// up starts the project and reads the containers that came up.
func (b *projectBoot) up() error {
	d, ctx := b.d, b.ctx
	b.upAt = d.clock.Now()
	if err := d.d.ComposeUp(ctx, b.project); err != nil {
		return err
	}
	b.upped = d.clock.Now()
	ids, err := d.d.IDs(ctx, dockercli.Filters{"label": {"com.docker.compose.project=" + b.ref.MachineID}})
	if err != nil {
		return err
	}
	if b.cs, err = d.d.Inspect(ctx, ids...); err != nil {
		return err
	}
	return nil
}

// record keeps the boot's timing and what the machine now runs: its
// services' addresses, where exec goes, and what its data holds.
func (b *projectBoot) record() error {
	d, ref := b.d, b.ref
	timing := bootPhases(b.started, b.upAt, b.upped, b.cs)
	timing.BuildMs = b.buildMs
	if b.restored > 0 {
		timing.RestoreMs = b.upAt.Sub(b.restoreAt).Milliseconds()
	}
	timing.RestoreMs += b.restoreMs
	timing.SnapshotMs = b.snapshotMs
	if b.steps.Steps > 0 {
		timing.BuildSteps = &b.steps
	}
	if b.reset != nil {
		timing.Kind, timing.At, timing.DownMs = "reset", b.reset.at, b.reset.downMs
		timing.TotalMs = b.upped.Sub(b.reset.at).Milliseconds()
	}
	d.log().Info(timing.Kind+".timing", "machine", ref.MachineID, "totalMs", timing.TotalMs, "downMs", timing.DownMs, "buildMs", timing.BuildMs,
		"restoreMs", timing.RestoreMs, "upMs", timing.UpMs, "seedMs", timing.SeedMs, "readyMs", timing.ReadyMs)
	d.mu.Lock()
	d.machineLocked(ref.MachineID).boot = &claimBoot{claim: ref.Tags[driver.TagClaim], timing: timing}
	d.mu.Unlock()
	services := map[string]string{}
	containers := map[string]dockercli.Container{}
	for _, c := range b.cs {
		if ip := c.IP(b.network); ip != "" {
			b.sources = append(b.sources, ip)
			if svc := c.Labels["com.docker.compose.service"]; svc != "" {
				services[svc] = ip
				containers[svc] = c
			}
		}
	}
	at, ok := execService(b.projectDir, containers)
	targets := make(map[string]execTarget, len(containers))
	for svc, c := range containers {
		targets[svc] = targetOf(c)
	}
	d.mu.Lock()
	m := d.machineLocked(ref.MachineID)
	m.services, m.exec, m.targets = services, nil, targets
	if ok {
		m.exec = &at
	}
	// Every data volume came from the bake: its seed is in them already.
	m.restoredData = len(b.keys) > 0 && b.restored == len(b.keys)
	m.seedAtInit = b.seedAtInit
	if b.seedInData != nil {
		m.seedInData = *b.seedInData
	}
	d.mu.Unlock()
	return nil
}

// render writes the cell's compose file for the project and checks what
// compose will run from it (VerifyCanonical). The caller removes the file.
func (d *Driver) render(ctx context.Context, machine, abs string, composeFile []byte, opts sandbox.Options) (dockercli.ComposeProject, []byte, error) {
	out, err := sandbox.Apply(composeFile, opts)
	if err != nil {
		return dockercli.ComposeProject{}, nil, err
	}
	// The rewritten file lives in the cell's own directory: the checkout is
	// the PR's, and any name in it may be a planted symlink.
	f, err := os.CreateTemp(d.cfg.WorkDir, "kodus-compose-*.yaml")
	if err != nil {
		return dockercli.ComposeProject{}, nil, err
	}
	project := dockercli.ComposeProject{Name: machine, Dir: abs, File: f.Name(), EnvFile: os.DevNull}
	fail := func(err error) (dockercli.ComposeProject, []byte, error) {
		os.Remove(f.Name())
		return dockercli.ComposeProject{}, nil, err
	}
	if _, err := f.Write(out); err != nil {
		f.Close()
		return fail(err)
	}
	if err := f.Close(); err != nil {
		return fail(err)
	}
	canonical, err := d.d.ComposeConfig(ctx, project)
	if err != nil {
		return fail(err)
	}
	if err := sandbox.VerifyCanonical(canonical, opts); err != nil {
		return fail(err)
	}
	return project, canonical, nil
}

// goldenOff ends the machine's golden data: its resets recreate the data
// from nothing, as before (golden.go).
func (d *Driver) goldenOff(ctx context.Context, machine, why string) {
	d.mu.Lock()
	m := d.machineLocked(machine)
	g := m.golden
	m.golden, m.goldenOff = nil, true
	d.mu.Unlock()
	if err := d.dropGolden(ctx, g); err != nil {
		d.log().Warn("data.golden.drop.failed", "machine", machine, "err", err)
	}
	d.log().Info("data.golden.off", "machine", machine, "reason", why)
}

// bootPhases splits a boot at what Docker says of its containers: up is
// compose creating and starting the first of them; seed is the services
// that depend on others waiting for those to pass their healthcheck (a
// database's init and seed run there, in its own start); ready is the last
// ones started passing theirs. With no dependency, seed is zero.
func bootPhases(started, upAt, upped time.Time, cs []dockercli.Container) driver.BootTiming {
	t := driver.BootTiming{Kind: "boot", At: started, UpMs: upped.Sub(upAt).Milliseconds(), TotalMs: upped.Sub(started).Milliseconds()}
	var first, last time.Time
	for _, c := range cs {
		if c.Labels["com.docker.compose.service"] == "" || c.StartedAt.IsZero() {
			continue
		}
		if first.IsZero() || c.StartedAt.Before(first) {
			first = c.StartedAt
		}
		if c.StartedAt.After(last) {
			last = c.StartedAt
		}
	}
	// A container that did not start in this up (or a clock that does not
	// agree with the daemon's) leaves the up whole.
	if first.IsZero() || first.Before(upAt) || last.After(upped) {
		return t
	}
	t.UpMs = first.Sub(upAt).Milliseconds()
	t.SeedMs = last.Sub(first).Milliseconds()
	t.ReadyMs = upped.Sub(last).Milliseconds()
	return t
}
