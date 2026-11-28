package dockergvisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// Up runs the claim's compose project after the allowlist rewrite and the
// second check of compose's canonical output. Nothing starts if either
// refuses. It returns the containers' addresses on the claim network.
//
// The steps run in this order and each leaves what the next needs in the
// projectBoot. The first that fails ends it. Every docker command of the
// boot tees its stderr to req.Output.
func (d *Driver) Up(ctx context.Context, req driver.UpRequest) ([]string, error) {
	return d.upProject(ctx, req, nil, nil)
}

// upProject is Up of the machine's project, or, with sp, of its warm spare
// (spare.go): the same steps under the spare's project name and address
// block, on the images the machine's last Up ran (it builds nothing), and
// what came up kept in sp instead of the machine. before gets the spare's
// addresses before compose up.
func (d *Driver) upProject(ctx context.Context, req driver.UpRequest, sp *spareState, before func([]string) error) ([]string, error) {
	ctx = dockercli.WithOutput(ctx, req.Output)
	b := &projectBoot{d: d, ctx: ctx, req: req, ref: req.Ref, composeFile: req.Compose, projectDir: req.ProjectDir, sp: sp, before: before}
	if sp != nil {
		b.name, b.block = sp.project, sp.block
	} else {
		b.name, b.block = d.projectOf(req.Ref.MachineID)
	}
	defer b.finish()
	for _, step := range []func() error{
		b.timed(PhaseSandbox, b.sandbox),   // the claim's network, limits and decoy: what compose is rewritten with
		b.build,                            // the project's images, and which data volumes it has (timed by its builds' phases)
		b.timed(PhaseCoverage, b.coverage), // a Run's built services that run Node, instrumented
		b.timed(PhaseRender, b.render),     // the cell's compose file, checked against what compose will run
		b.timed(PhasePull, b.pull),         // the images the cell did not build, pulled by the cell, never by compose
		b.data,                             // the data the app starts on: a golden copy, the bake's, or fresh
		b.announce,                         // a spare's addresses, for the claim's egress, before any starts
		b.up,                               // compose up, and what came up
		b.record,                           // timing, and what the machine now runs
	} {
		if err := step(); err != nil {
			// Where the time went until it stopped (a build the claim's
			// ceiling cut, an up that did not answer): claim.failed says it.
			if sp == nil {
				b.keepPhases(b.phases(nil))
			}
			return nil, err
		}
	}
	return b.sources, nil
}

// Phase names of the boot's own steps (the builds' are in build.go).
const (
	PhaseSandbox  = "claim sandbox"
	PhaseCoverage = "coverage setup"
	PhaseRender   = "render compose"
	PhasePull     = "pull images"
)

// timed is step, its time kept as a phase of the boot: every step between
// the claim asking to boot and the app answering is named, so the time
// outside every phase is what nobody measured.
func (b *projectBoot) timed(name string, step func() error) func() error {
	return func() error {
		at := b.d.clock.Now()
		err := step()
		b.own = append(b.own, driver.BootPhase{Name: name, Ms: b.d.clock.Now().Sub(at).Milliseconds()})
		return err
	}
}

// phases is the boot in words: its builds' phases and, once compose ran,
// the cell's own (timing).
func (b *projectBoot) phases(t *driver.BootTiming) []driver.BootPhase {
	var own []driver.BootPhase
	if t != nil {
		own = []driver.BootPhase{
			{Name: "compose down", Ms: t.DownMs},
			{Name: "restore data", Ms: t.RestoreMs},
			{Name: "snapshot data", Ms: t.SnapshotMs},
			// Up is compose creating and starting the containers, the
			// services that wait on others' healthchecks included (seed);
			// ready is the last ones until their first healthy answer.
			{Name: "compose up", Ms: t.UpMs + t.SeedMs},
			{Name: "first healthy", Ms: t.ReadyMs},
		}
	} else if !b.upAt.IsZero() && b.upped.IsZero() {
		// compose up was running when the boot stopped.
		own = []driver.BootPhase{{Name: "compose up", Ms: b.d.clock.Now().Sub(b.upAt).Milliseconds(), Running: true}}
	}
	// All of them, slowest first: the agent adds its own and bounds the list
	// after it has measured what none of them cover (BootTiming.Phases).
	return driver.MergePhases(-1, b.steps.Phases, b.own, own)
}

// keepPhases records the boot's phases for the claim it booted for.
func (b *projectBoot) keepPhases(phases []driver.BootPhase) {
	if len(phases) == 0 {
		return
	}
	b.d.mu.Lock()
	b.d.machineLocked(b.ref.MachineID).phases = &claimPhases{claim: b.ref.Tags[driver.TagClaim], phases: phases}
	b.d.mu.Unlock()
}

// projectBoot is one Up of a machine's compose project: what each step leaves for
// the next. It lives for one Up call.
type projectBoot struct {
	d   *Driver
	ctx context.Context
	// req is what the agent asked of this Up; ref, composeFile and
	// projectDir are its fields.
	req         driver.UpRequest
	ref         driver.MachineRef
	composeFile []byte
	projectDir  string
	// name is the compose project the boot runs, block its address block
	// (spare.go): the machine's own name in block 0 until a swap.
	name  string
	block int
	// sp is the machine's warm spare this boot is (nil: the machine's
	// project), before what it tells the spare's addresses to.
	sp     *spareState
	before func([]string) error

	// reset is the reset this boot follows (its down is the boot's first
	// phase); nil for a first boot.
	reset           *pendingReset
	network, resolv string
	subnet          netip.Prefix
	opts            sandbox.Options

	started time.Time
	// own are the boot's own steps' phases (timed).
	own     []driver.BootPhase
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
		_ = os.Remove(f)
	}
}

// renderProject renders the cell's compose file and remembers it for removal.
func (b *projectBoot) renderProject() (dockercli.ComposeProject, []byte, error) {
	project, canonical, err := b.d.render(b.ctx, b.name, b.abs, b.composeFile, b.opts)
	if err == nil {
		b.files = append(b.files, project.File)
	}
	return project, canonical, err
}

// sandbox reads where the machine runs (its claim network, cgroup parent and
// limits), plants the decoy and takes a Run's coverage files: the options
// compose is rewritten with.
func (b *projectBoot) sandbox() error {
	d, ctx, ref := b.d, b.ctx, b.ref
	// A reset's down is the first phase of the boot that follows it; a
	// spare's boot is no reset's.
	if b.sp == nil {
		d.mu.Lock()
		b.reset = d.machineLocked(ref.MachineID).reset
		d.machineLocked(ref.MachineID).reset = nil
		d.mu.Unlock()
	}
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return err
	}
	b.network = networkName(ref.Tags[driver.TagClaim])
	resolv, err := d.claimResolv(b.network)
	if err != nil {
		return err
	}
	b.resolv = resolv
	if b.subnet, err = d.subnetOf(ctx, b.network); err != nil {
		return err
	}
	parent, err := d.parentFor(ctx, ref)
	if err != nil {
		return err
	}
	mem, cpus := d.limits(ref.MachineID)
	b.opts = sandbox.Options{
		CgroupParent: parent,
		ProjectDir:   b.projectDir, Root: b.req.WorkspaceRoot, Project: b.name, Runtime: d.cfg.Runtime, PidsLimit: d.cfg.PidsLimit,
		MemLimit: mem, MemShared: parent == "", CPUs: cpus, Network: b.network, Subnet: b.subnet, AddressBlock: b.block, Resolv: b.resolv,
		HealthStartInterval: d.healthEvery, HostEnv: dockercli.EnvNames(),
		LogMaxSize: d.cfg.ServiceLogMaxSize, LogMaxFile: d.cfg.ServiceLogMaxFile, DiskSize: d.cfg.ContainerDiskSize,
		Labels: toLabels(map[string]string{
			driver.TagCell: d.cfg.CellID, driver.TagOrg: ref.Tags[driver.TagOrg], driver.TagClaim: ref.Tags[driver.TagClaim],
			driver.TagRole: ref.Tags[driver.TagRole], driver.TagHardExpires: ref.Tags[driver.TagHardExpires],
		}),
	}
	if b.name != ref.MachineID {
		// Destroy, the sweep and the reaper find it with the machine.
		b.opts.Labels[labelProjectOf] = ref.MachineID
	}
	if b.req.CellTrust {
		b.opts.Trust = d.cfg.Trust // a claim with org secrets: the cell CA in every service
	}
	if cov := b.req.Coverage; cov.Set() {
		b.opts.Coverage = sandbox.Coverage{Dir: cov.Dir, Preload: cov.Preload, Services: cov.Services} // a Run's instrumented services
	}
	if b.opts.Decoy, err = d.writeDecoy(ref.MachineID, b.req.Canaries); err != nil {
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
	// The whole file is checked before anything is built. render checks it
	// again with the images' real names, but a file the cell refuses (a
	// container_name, an extends, an env file that is not in the checkout)
	// used to be refused only there, after every image was built: immich on
	// the dev cell built for 875 s and then was refused.
	pre := b.opts
	pre.Built = make(map[string]string, len(builds))
	for _, bl := range builds {
		pre.Built[bl.Service] = "kodus-build/unbuilt"
	}
	if _, err := sandbox.Apply(b.composeFile, pre); err != nil {
		return err
	}
	if b.sp == nil {
		declared, err := sandbox.DeclaredMemory(b.composeFile, b.opts)
		if err != nil {
			return err
		}
		d.mu.Lock()
		d.machineLocked(ref.MachineID).memFloorMB = int((declared + 1<<20 - 1) >> 20)
		d.mu.Unlock()
	}
	b.started = d.clock.Now()
	if b.sp != nil {
		// A spare runs the images the machine's project runs: the claim's
		// own builds, never rebuilt for it.
		b.opts.Built = maps.Clone(d.peek(ref.MachineID).built)
		for _, bl := range builds {
			if b.opts.Built[bl.Service] == "" {
				return fmt.Errorf("dockergvisor: the spare has no image for %s", bl.Service)
			}
		}
	} else {
		// The shared image store (prstore.go): the PR image a shard pulls, the one the PR side pushes after its builds.
		d.bindPRStore(ref, b.req)
		if b.opts.Built, b.steps, err = d.build(ctx, ref, builds, b.network, b.resolv, b.subnet, b.req.BuildSecrets, b.req.SharedImages); err != nil {
			return err
		}
		d.startPRPush(ref)
	}
	b.buildMs = d.clock.Now().Sub(b.started).Milliseconds()
	if b.keys, err = dataKeys(b.composeFile, b.projectDir); err != nil {
		return fmt.Errorf("dockergvisor: data volumes: %w", err)
	}
	if b.sp == nil {
		d.mu.Lock()
		if o := d.machineLocked(ref.MachineID).output; o != nil {
			o.volumes = b.keys
		}
		d.mu.Unlock()
	}
	if b.abs, err = filepath.Abs(b.projectDir); err != nil {
		return err
	}
	return nil
}

// coverage instruments, for an Up that asked for a Run's coverage, the
// services built here whose image runs Node (compose.AddBuiltNodeCoverage,
// from the image's config), and keeps every instrumented service for the
// agent (CoverageServices). An image whose config cannot be read is left
// out, never guessed at.
func (b *projectBoot) coverage() error {
	d, cov := b.d, b.req.Coverage
	var services []string
	if cov.Set() {
		services = slices.Clone(cov.Services)
		images := map[string]compose.ImageConfig{}
		// Every built service is judged on every Up, even one the request
		// already names: after a reset the agent passes back this driver's
		// list (built services included), and the compose file it sends
		// never carries their instrumentation.
		for svc, img := range b.opts.Built {
			cfg, err := d.d.ImageConfig(b.ctx, img)
			if err != nil {
				d.log().Warn("coverage.image_config", "machine", b.ref.MachineID, "err", err)
				continue
			}
			images[svc] = compose.ImageConfig(cfg)
		}
		if len(images) > 0 {
			proj, err := compose.FromYAML(b.composeFile)
			if err != nil {
				return fmt.Errorf("dockergvisor: coverage: %w", err)
			}
			built, err := proj.AddBuiltNodeCoverage(compose.NodeCoverage{Dir: sandbox.CoverageTarget, Preload: sandbox.CoveragePreloadTarget}, images)
			if err != nil {
				return fmt.Errorf("dockergvisor: coverage: %w", err)
			}
			if len(built) > 0 {
				if b.composeFile, err = proj.Marshal(); err != nil {
					return fmt.Errorf("dockergvisor: coverage: %w", err)
				}
				services = append(services, built...)
				slices.Sort(services)
				services = slices.Compact(services)
			}
		}
		b.opts.Coverage.Services = services
	}
	if b.sp == nil { // a spare instruments what the project does
		d.mu.Lock()
		d.machineLocked(b.ref.MachineID).coverage = services
		d.mu.Unlock()
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
	b.firstTry = b.gold == nil && !d.machineLocked(ref.MachineID).goldenOff && !d.cfg.NoGoldenData && b.sp == nil
	d.mu.Unlock()
	if b.reset == nil && b.sp == nil {
		b.gold = nil
	}
	if b.gold != nil {
		b.opts.DataVolumes = b.gold.dataVolumes()
	}
	var err error
	b.project, b.canonical, err = b.renderProject()
	if err != nil && b.sp != nil {
		return err // a spare fails, and the machine keeps its golden data
	}
	if err != nil && b.gold != nil {
		d.goldenOff(ctx, ref.MachineID, "render: "+err.Error())
		b.gold, b.opts.DataVolumes = nil, nil
		b.project, b.canonical, err = b.renderProject()
	}
	if err != nil {
		return err
	}
	b.rec, _ = recipe.Load(b.projectDir) // read and refused by the agent already
	if b.reset == nil && b.sp == nil {
		warnUnapplied(d.log(), ref.MachineID, b.rec)
	}
	b.seedAtInit = seedRunsAtInit(b.canonical, b.abs, b.rec)
	b.plan, b.why = planGolden(b.canonical, b.composeFile, b.abs, b.rec, b.seedAtInit, b.opts.DataVolumes)
	if b.gold != nil && (b.plan == nil || b.plan.sum != b.gold.sum) && b.sp != nil {
		return errors.New("dockergvisor: the golden data's inputs changed")
	}
	if b.gold != nil && (b.plan == nil || b.plan.sum != b.gold.sum) {
		// What the copy was made from changed: recreate, as before it.
		d.goldenOff(ctx, ref.MachineID, "inputs changed")
		b.gold, b.opts.DataVolumes = nil, nil
		_ = os.Remove(b.project.File)
		if b.project, _, err = b.renderProject(); err != nil {
			return err
		}
	}
	return nil
}

// pull makes present every image compose will run that the cell did not
// build (sandbox.PullImages): compose runs with pull_policy never, so the
// cell pulls each itself, anonymously and within the cell's image bound
// (F3-01); an image already here only as a registry served it (N10). The golden first boot's partial up needs them too.
func (b *projectBoot) pull() error {
	refs, err := sandbox.PullImages(b.canonical, b.opts)
	if err != nil {
		return err
	}
	own := b.d.cellRepositories()
	for _, ref := range refs {
		if err := b.d.d.PullServiceImage(b.ctx, ref, b.d.maxImageBytes(), own[dockercli.ImageRepository(ref)]); err != nil {
			return err
		}
	}
	return nil
}

// cellRepositories are the repositories of the cell's own images, which the
// host may hold from a pull with the cell's login: a service image of one
// is pulled anonymously even when here (N10).
func (d *Driver) cellRepositories() map[string]bool {
	out := map[string]bool{}
	for _, ref := range append([]string{d.cfg.HolderImage, d.cfg.BuilderImage, d.cfg.HelperImage, d.cfg.ObserverImage, d.cfg.SandboxImage, d.cfg.RegistryImage}, d.cfg.CellImages...) {
		if ref != "" && !strings.HasPrefix(ref, "sha256:") {
			out[dockercli.ImageRepository(ref)] = true
		}
	}
	return out
}

// data puts in place the data the app starts on: the machine's golden copy
// restored (a reset), a golden copy taken (a first boot whose plan allows
// one), and what the environment's bake kept.
func (b *projectBoot) data() error {
	d, ctx, ref := b.d, b.ctx, b.ref
	switch {
	case b.gold != nil && b.sp != nil:
		at := d.clock.Now()
		if err := d.restoreGolden(ctx, ref, b.name, b.gold); err != nil {
			return err
		}
		b.restoreMs = d.clock.Now().Sub(at).Milliseconds()
		b.seedInData = new(b.gold.seeded)
	case b.sp != nil:
		b.seedInData = new(false) // new volumes, as a reset's
	case b.gold != nil:
		at := d.clock.Now()
		if err := d.restoreGolden(ctx, ref, b.name, b.gold); err != nil {
			d.goldenOff(ctx, ref.MachineID, err.Error())
			b.opts.DataVolumes = nil
			_ = os.Remove(b.project.File)
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
	restored, err := d.restoreData(ctx, ref, b.name, b.keys)
	if err != nil {
		return fmt.Errorf("dockergvisor: data from the bake: %w", err)
	}
	b.restored = restored
	if restored > 0 {
		d.log().Info("data.restored", "machine", ref.MachineID, "volumes", restored)
	}
	return nil
}

// announce tells a spare's caller the addresses its containers will take
// (the claim's egress must list them before they start); the machine's
// own project keeps the addresses its policy has.
func (b *projectBoot) announce() error {
	if b.sp == nil || b.before == nil {
		return nil
	}
	var doc struct {
		Services map[string]json.RawMessage `json:"services"`
	}
	if err := json.Unmarshal(b.canonical, &doc); err != nil {
		return fmt.Errorf("dockergvisor: compose config: %w", err)
	}
	addrs, err := sandbox.ServiceAddressesIn(slices.Collect(maps.Keys(doc.Services)), b.subnet, b.block)
	if err != nil {
		return err
	}
	sources := make([]string, 0, len(addrs))
	for _, a := range addrs {
		sources = append(sources, a.String())
	}
	slices.Sort(sources)
	return b.before(sources)
}

// up starts the project and reads the containers that came up.
func (b *projectBoot) up() error {
	d, ctx := b.d, b.ctx
	b.upAt = d.clock.Now()
	if err := d.d.ComposeUp(ctx, b.project); err != nil {
		return err
	}
	b.upped = d.clock.Now()
	ids, err := d.d.IDs(ctx, dockercli.Filters{"label": {"com.docker.compose.project=" + b.name}})
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
	if b.sp != nil {
		return b.recordSpare()
	}
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
	timing.Phases = b.phases(&timing)
	b.keepPhases(timing.Phases)
	d.log().Info(timing.Kind+".timing", "machine", ref.MachineID, "totalMs", timing.TotalMs, "downMs", timing.DownMs, "buildMs", timing.BuildMs,
		"restoreMs", timing.RestoreMs, "upMs", timing.UpMs, "seedMs", timing.SeedMs, "readyMs", timing.ReadyMs)
	d.mu.Lock()
	d.machineLocked(ref.MachineID).boot = &claimBoot{claim: ref.Tags[driver.TagClaim], timing: timing}
	d.mu.Unlock()
	services := map[string]string{}
	containers := map[string]dockercli.Container{}
	for i := range b.cs {
		c := &b.cs[i]
		if ip := c.IP(b.network); ip != "" {
			b.sources = append(b.sources, ip)
			if svc := c.Labels["com.docker.compose.service"]; svc != "" {
				services[svc] = ip
				containers[svc] = *c
			}
		}
	}
	at, ok := execService(b.projectDir, containers)
	targets := make(map[string]execTarget, len(containers))
	for svc := range containers {
		targets[svc] = targetOf(containers[svc])
	}
	repoExec := map[string]execTarget{}
	for alias, svc := range repositoryServices(b.canonical, b.opts.Root, b.abs) {
		if t, ok := targets[svc]; ok {
			repoExec[alias] = t
		}
	}
	d.mu.Lock()
	m := d.machineLocked(ref.MachineID)
	m.services, m.exec, m.targets, m.repoExec = services, nil, targets, repoExec
	m.built = maps.Clone(b.opts.Built)
	if ok {
		m.exec = &at
	}
	// Every data volume came from the bake: its seed is in them already.
	m.restoredData = len(b.keys) > 0 && b.restored == len(b.keys)
	m.seedAtInit = b.seedAtInit
	m.dataPlan, m.dataWhy = planDataReset(b.canonical, b.rec, b.opts.Built)
	if b.seedInData != nil {
		m.seedInData = *b.seedInData
	}
	d.mu.Unlock()
	return nil
}

// recordSpare keeps what a spare's boot found in the spare: the machine
// takes it at the swap.
func (b *projectBoot) recordSpare() error {
	sp := b.sp
	sp.services, sp.targets, sp.repoExec, sp.sources = map[string]string{}, map[string]execTarget{}, map[string]execTarget{}, nil
	containers := map[string]dockercli.Container{}
	for i := range b.cs {
		c := &b.cs[i]
		if ip := c.IP(b.network); ip != "" {
			sp.sources = append(sp.sources, ip)
			if svc := c.Labels["com.docker.compose.service"]; svc != "" {
				sp.services[svc] = ip
				containers[svc] = *c
				sp.targets[svc] = targetOf(*c)
			}
		}
	}
	if at, ok := execService(b.projectDir, containers); ok {
		sp.exec = &at
	}
	for alias, svc := range repositoryServices(b.canonical, b.opts.Root, b.abs) {
		if t, ok := sp.targets[svc]; ok {
			sp.repoExec[alias] = t
		}
	}
	sp.restoredData = len(b.keys) > 0 && b.restored == len(b.keys)
	sp.seedAtInit = b.seedAtInit
	if b.seedInData != nil {
		sp.seedInData = *b.seedInData
	}
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
		_ = os.Remove(f.Name())
		return dockercli.ComposeProject{}, nil, err
	}
	if _, err := f.Write(out); err != nil {
		_ = f.Close()
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
	for i := range cs {
		c := &cs[i]
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
