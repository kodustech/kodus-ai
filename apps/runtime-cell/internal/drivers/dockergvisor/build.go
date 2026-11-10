package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/bakecatalog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildfingerprint"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildprogress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildstate"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// ErrNoBuilder: the project has a build section and this cell has no
// builder image (-gvisor-builder-image).
var ErrNoBuilder = errors.New("dockergvisor: the project builds images and this cell has no image builder")

// builderHost is the builder's fixed address in the claim subnet: below
// the services' (sandbox), so the claim's policy can name it before Up.
const builderHost = 9

func builderAddress(subnet netip.Prefix) netip.Addr {
	a := subnet.Masked().Addr()
	for range builderHost {
		a = a.Next()
	}
	return a
}

func builtTag(machine, service string) string {
	return "kodus-build/" + machine + "-" + service + ":claim"
}

// builtImage is one service's image a machine holds under its claim tag,
// and the fingerprint of the build that made it ("" when it has none).
type builtImage struct {
	service, tag, fp string
	// cache is the build cache this build wrote (a setup machine's), or "".
	cache string
}

// build gives every build section of the project an image under the
// machine's claim tag. A build whose fingerprint matches an image the
// environment baked from its default branch takes that image (a new name
// for it, so a later bake can drop the old one without touching this
// claim); any other runs in the sandbox, one after the other at the
// builder's address, and is loaded. What the machine holds is removed with
// it, unless a bake pinned it first.
// It also says where the builds that ran spent their time (BuildSteps).
func (d *Driver) build(ctx context.Context, ref driver.MachineRef, builds []sandbox.Build, network, resolv string, subnet netip.Prefix) (map[string]string, driver.BuildSteps, error) {
	var steps driver.BuildSteps
	d.machineOutput(ref.MachineID)
	if len(builds) == 0 {
		return nil, steps, nil
	}
	var selected *bakecatalog.Generation
	if generationPin(ref.ImageID) {
		g, release, err := d.holdGeneration(ctx, ref)
		if err != nil {
			return nil, steps, err
		}
		defer release()
		selected = &g
	}
	built := map[string]string{}
	for _, b := range builds {
		tag := builtTag(ref.MachineID, b.Service)
		fp, err := buildfingerprint.Of(b, d.cfg.BuilderImage)
		if err != nil {
			d.log().Warn("build.fingerprint.failed", "machine", ref.MachineID, "service", b.Service, "err", err)
			fp = ""
		}
		// A reset brings the same checkout up again: the machine's own image
		// of this build stands, as long as the input is still the same.
		if fp != "" && d.hasBuilt(ref.MachineID, b.Service, fp) {
			d.log().Info("build.done", "machine", ref.MachineID, "service", b.Service, "reused", true, "source", "machine", "fingerprint", short(fp))
			built[b.Service] = tag
			continue
		}
		reused := false
		if selected != nil && fp != "" {
			from := selected.Images[fp]
			var reuseErr error
			if from == "" {
				reuseErr = dockercli.ErrNoSuchImage
			} else {
				reuseErr = d.d.TagImage(ctx, from, tag)
			}
			if selected != nil && from != "" && errors.Is(reuseErr, dockercli.ErrNoSuchImage) {
				return nil, steps, ErrBakeDataUnavailable
			}
			switch err := reuseErr; {
			case err == nil:
				reused = true
			case !errors.Is(err, dockercli.ErrNoSuchImage):
				return nil, steps, fmt.Errorf("dockergvisor: baked image for %s: %w", b.Service, err)
			}
		}
		cache := ""
		if !reused {
			var err error
			var ran buildprogress.Summary
			cache, ran, err = d.runBuild(ctx, ref, b, tag, network, resolv, subnet)
			steps = addBuildSteps(steps, b.Service, ran)
			if err != nil {
				return nil, steps, err
			}
		}
		source := "build"
		if reused {
			source = "environment"
		}
		d.log().Info("build.done", "machine", ref.MachineID, "service", b.Service, "reused", reused, "source", source, "fingerprint", short(fp))
		o := d.machineOutput(ref.MachineID)
		d.mu.Lock()
		o.images = append(o.images, builtImage{service: b.Service, tag: tag, fp: fp, cache: cache})
		d.mu.Unlock()
		built[b.Service] = tag
	}
	return built, steps, nil
}

// addBuildSteps adds one service's build to a boot's steps: the counts, and
// its slowest steps among the boot's slowest (at most slowestSteps).
func addBuildSteps(acc driver.BuildSteps, service string, s buildprogress.Summary) driver.BuildSteps {
	acc.Steps += s.Steps
	acc.Done += s.Done
	acc.Cached += s.Cached
	acc.Errored += s.Errored
	svc, _ := redact.Clip(service, maxServiceName)
	for _, st := range s.Slowest {
		acc.Slowest = append(acc.Slowest, driver.BuildStep{Service: svc, Name: st.Name, Ms: st.Ms})
	}
	sort.SliceStable(acc.Slowest, func(i, j int) bool { return acc.Slowest[i].Ms > acc.Slowest[j].Ms })
	if len(acc.Slowest) > slowestSteps {
		acc.Slowest = acc.Slowest[:slowestSteps]
	}
	return acc
}

// maxServiceName bounds a service name in claim.ready timing.buildSteps.
const maxServiceName = 128

// hasBuilt reports whether the machine already holds its image of the
// service's build at this fingerprint.
func (d *Driver) hasBuilt(machine, service, fp string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.machines[machine]
	if m == nil || m.output == nil {
		return false
	}
	for _, im := range m.output.images {
		if im.service == service && im.fp == fp {
			return true
		}
	}
	return false
}

// runBuild runs one build section in the sandbox and loads its image as
// tag. It reads the environment's build cache, and a setup machine's build
// writes its own (returned), for a bake to make the environment's.
func (d *Driver) runBuild(ctx context.Context, ref driver.MachineRef, b sandbox.Build, tag, network, resolv string, subnet netip.Prefix) (string, buildprogress.Summary, error) {
	var none buildprogress.Summary
	if d.cfg.BuilderImage == "" {
		return "", none, ErrNoBuilder
	}
	// The builder's alone (hostdirs.go): the cell loads the image it finds
	// there, so nobody else may write it.
	out := filepath.Join(d.workDir(), "builds", ref.MachineID, b.Service)
	defer os.RemoveAll(out)
	if err := d.dirs.builderDir(out); err != nil {
		return "", none, err
	}
	// The mirror's address goes to every build; the project's own value wins.
	args := maps.Clone(b.Args)
	if d.cfg.MirrorGoProxy != "" {
		if args == nil {
			args = map[string]string{}
		}
		if _, set := args["GOPROXY"]; !set {
			args["GOPROXY"] = d.cfg.MirrorGoProxy
		}
	}
	parent, err := d.parentFor(ctx, ref)
	if err != nil {
		return "", none, err
	}
	mem, cpus := d.limits(ref.MachineID)
	run := dockercli.BuildRun{
		CgroupParent: parent,
		Image:        d.cfg.BuilderImage, Runtime: d.cfg.Runtime, Network: network, Address: builderAddress(subnet).String(), Resolv: resolv,
		Context: b.Context, Dockerfile: b.Dockerfile, Target: b.Target, Args: args, Tag: tag, Out: out,
		PidsLimit: d.cfg.PidsLimit, MemLimit: mem, CPUs: cpus, RegistryMirror: d.cfg.MirrorRegistry,
		Labels: toLabels(map[string]string{driver.TagCell: d.cfg.CellID, driver.TagClaim: ref.Tags[driver.TagClaim], driver.TagHardExpires: ref.Tags[driver.TagHardExpires]}),
	}
	m := d.peek(ref.MachineID)
	setup, seeds := m.setup, m.seeds
	// The environment's BuildKit state, when the cell keeps one: the build
	// finds its layers and cache mounts there, and needs no exported cache.
	// The exported cache is then only the fallback of a build that cannot
	// mount the state: exporting it too would cost the seeding setup minutes.
	req := buildstate.Request{Machine: ref.MachineID, Service: b.Service, Org: ref.Tags[driver.TagOrg], Env: ref.Tags[driver.TagEnv], Seeds: setup && seeds}
	cacheInput := "cold"
	if st, ok := d.states.Acquire(ctx, req); ok {
		defer d.states.Release(st)
		run.StateDir, run.GCKeepStorage = st.Dir, d.cfg.BuildStateKeep
		cacheInput = "state_overlay"
		if st.Mode == buildstate.ModeSeed {
			cacheInput = "state_seed"
		}
		d.log().Info("build.state", "machine", ref.MachineID, "service", b.Service, "mode", st.Mode)
	} else {
		// Held for the whole build: a promotion meanwhile adds a generation
		// and leaves this one where the builder mounted it.
		gen, release := d.caches.Acquire(d.envCacheDir(ref.Tags[driver.TagOrg], ref.Tags[driver.TagEnv], b.Service))
		defer release()
		run.CacheFrom = gen
		if gen != "" {
			cacheInput = "exported"
		}
		if setup {
			dir, err := d.writableCache(ref.MachineID, b.Service)
			if err != nil {
				return "", none, err
			}
			run.CacheTo = dir
		}
	}
	// A cache input need not contain a matching layer or compiler cache.
	// BuildKit's reported layer hits remain in build.steps.cached.
	d.log().Info("build.cache.input", "machine", ref.MachineID, "service", b.Service, "mode", cacheInput)
	at := time.Now()
	steps := buildprogress.New()
	err = d.d.RunBuild(driver.WithOutput(ctx, alsoTo(driver.OutputFrom(ctx), steps.Line)), run)
	built := time.Since(at)
	ran := steps.Summary(slowestSteps)
	d.logBuildSteps(ref.MachineID, b.Service, ran, err)
	oom := err != nil && ctx.Err() == nil && killedAtMemoryLimit(err)
	outcome := "build_failed"
	var loaded time.Duration
	var imageBytes any // nil means unavailable, not a measured zero-byte image.
	loadAttempted := err == nil
	if err == nil {
		tarball := filepath.Join(out, dockercli.BuildTarball)
		// Metadata only: never follow a builder's symlink or open a FIFO.
		if info, statErr := os.Lstat(tarball); statErr == nil && info.Mode().IsRegular() {
			imageBytes = info.Size()
		}
		at = time.Now()
		err = d.d.LoadImage(ctx, tarball)
		loaded = time.Since(at)
		outcome = "load_failed"
	}
	switch {
	case err == nil:
		outcome = "success"
	case oom:
		outcome = "out_of_memory"
	case ctx.Err() != nil:
		outcome = "canceled"
	}
	// The build's export is in the builder's own output (its last step); the
	// load into this Docker is the cell's, so it is told apart here.
	d.log().Info("build.timing", "machine", ref.MachineID, "service", b.Service, "buildMs", built.Milliseconds(), "loadMs", loaded.Milliseconds(),
		"outcome", outcome, "loadAttempted", loadAttempted, "imageTarBytes", imageBytes)
	if oom {
		return "", ran, fmt.Errorf("%w: build %s passed %s (%v)", driver.ErrOutOfMemory, b.Service, mem, err)
	}
	if err != nil {
		return "", ran, fmt.Errorf("dockergvisor: build %s: %w", b.Service, err)
	}
	if sink := driver.OutputFrom(ctx); sink != nil {
		sink(fmt.Sprintf("kodus: %s built in %s, image loaded in %s", b.Service, built.Round(time.Second), loaded.Round(time.Second)))
	}
	if seeds && run.CacheTo != "" {
		// The default branch's build: its layers are the environment's now, so a
		// setup that fails after this (boot, health, its ceiling) leaves the next
		// one a warm build. Nothing is left for a bake to promote.
		if err := d.promoteCache(run.CacheTo, ref.Tags[driver.TagOrg], ref.Tags[driver.TagEnv], b.Service); err != nil {
			d.log().Warn("build.cache.promote.failed", "machine", ref.MachineID, "service", b.Service, "err", err)
			return run.CacheTo, ran, nil
		}
		d.log().Info("build.cache.promoted", "machine", ref.MachineID, "service", b.Service)
		return "", ran, nil
	}
	return run.CacheTo, ran, nil
}

// slowestSteps is how many of a build's steps build.steps names.
const slowestSteps = 8

// logBuildSteps logs where a build's time went, step by step (BuildKit's
// own measure), the slowest first: a build that took minutes says which
// step did, and whether the cache answered the rest. Names are redacted
// and bounded (buildprogress); no output of a step is kept.
func (d *Driver) logBuildSteps(machine, service string, s buildprogress.Summary, err error) {
	if s.Steps == 0 {
		return
	}
	d.log().Info("build.steps", "machine", machine, "service", service, "ok", err == nil,
		"steps", s.Steps, "done", s.Done, "cached", s.Cached, "errored", s.Errored, "canceled", s.Canceled, "slowest", s.Slowest)
}

// alsoTo is a line sink that hands each line to next too, when there is one.
func alsoTo(next, also func(string)) func(string) {
	if next == nil {
		return also
	}
	return func(line string) {
		also(line)
		next(line)
	}
}

// killedAtMemoryLimit reports whether the builder's container was SIGKILLed
// (docker run exits with the container's status). The cell's own stop of a
// build cancels its context, which the caller rules out first, so what is
// left is the kernel's OOM killer at --memory. The container's OOMKilled
// state would say it outright, but the builder runs --rm and is gone when
// docker run returns: reading it would mean keeping every builder to inspect.
func killedAtMemoryLimit(err error) bool {
	code, ok := dockercli.ExitCode(err)
	return ok && code == dockercli.ExitKilled
}

// output is what a machine holds beyond its containers.
type output struct {
	images []builtImage
	// volumes are the keys of the project volumes a bake copies: set when
	// the recipe keeps data in named volumes (data.reset: snapshot).
	volumes []string
}

// machineOutput is the machine's output, made on its first boot. Known to
// have booted, even with nothing to build: a bake of it is a bake of
// nothing, not of a machine the driver never saw.
func (d *Driver) machineOutput(machine string) *output {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.machineLocked(machine)
	if m.output == nil {
		m.output = &output{}
	}
	return m.output
}

// removeBuilt drops the images a machine holds (none once a bake pinned them).
func (d *Driver) removeBuilt(ctx context.Context, machine string) error {
	d.mu.Lock()
	var o *output
	if m := d.machines[machine]; m != nil {
		o, m.output = m.output, nil
	}
	d.mu.Unlock()
	if o == nil {
		return nil
	}
	return d.removeImages(ctx, o.images)
}

func (d *Driver) removeImages(ctx context.Context, imgs []builtImage) error {
	var errs []error
	for _, i := range imgs {
		errs = append(errs, d.d.RemoveImage(ctx, i.tag))
	}
	return errors.Join(errs...)
}

func short(fp string) string {
	if len(fp) > 12 {
		return fp[:12]
	}
	return fp
}

func (d *Driver) workDir() string {
	if d.cfg.WorkDir == "" {
		return os.TempDir()
	}
	return d.cfg.WorkDir
}
