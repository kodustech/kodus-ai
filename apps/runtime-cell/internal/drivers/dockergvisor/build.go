package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"math"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/bakecatalog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildfingerprint"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildmirror"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildprogress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildstate"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/registry"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// ErrNoBuilder means the project has a build section and this cell has no
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
func (d *Driver) build(ctx context.Context, ref driver.MachineRef, builds []sandbox.Build, network, resolv string, subnet netip.Prefix, secrets map[string]string, shared []driver.SharedImage) (map[string]string, driver.BuildSteps, error) {
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
	// Services that name the same build (one Dockerfile and target for an
	// api and its worker) share the image this call made for the first of
	// them: same fingerprint and the same secrets asked for (S-28).
	madeHere := map[string]string{}
	for _, b := range builds {
		tag := builtTag(ref.MachineID, b.Service)
		fp, err := buildfingerprint.Of(b, d.cfg.BuilderImage)
		if err != nil {
			d.log().Warn("build.fingerprint.failed", "machine", ref.MachineID, "service", b.Service, "err", err)
			fp = ""
		}
		key := sharedBuildKey(fp, b.Secrets)
		if from, ok := madeHere[key]; ok && key != "" {
			// A failed tag only costs this service its own build.
			if err := d.d.TagImage(ctx, from, tag); err != nil {
				d.log().Warn("build.share.failed", "machine", ref.MachineID, "service", b.Service, "err", err)
			} else {
				d.log().Info("build.done", "machine", ref.MachineID, "service", b.Service, "reused", true, "source", "service", "fingerprint", short(fp))
				o := d.machineOutput(ref.MachineID)
				d.mu.Lock()
				o.images = append(o.images, builtImage{service: b.Service, tag: tag, fp: fp})
				d.mu.Unlock()
				built[b.Service] = tag
				continue
			}
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
			if from != "" && errors.Is(reuseErr, dockercli.ErrNoSuchImage) {
				return nil, steps, ErrBakeDataUnavailable
			}
			switch err := reuseErr; {
			case err == nil:
				reused = true
			case !errors.Is(err, dockercli.ErrNoSuchImage):
				return nil, steps, fmt.Errorf("dockergvisor: baked image for %s: %w", b.Service, err)
			}
		}
		// Another cell of the org baked this build (UpRequest.SharedImages):
		// its image by the hub's digest, before building it here.
		fromShare := false
		if !reused && fp != "" {
			if digest := sharedDigest(shared, fp); digest != "" {
				fromShare = d.takeShared(ctx, ref, b.Service, fp, digest, tag, shared)
				reused = fromShare
			}
		}
		cache := ""
		if !reused {
			var err error
			var ran buildprogress.Summary
			cache, ran, err = d.runBuild(ctx, ref, b, tag, network, resolv, subnet, secrets)
			steps = addBuildSteps(steps, b.Service, ran)
			if err != nil {
				return nil, steps, err
			}
		}
		source := "build"
		switch {
		case fromShare:
			source = "shared"
		case reused:
			source = "environment"
		}
		d.log().Info("build.done", "machine", ref.MachineID, "service", b.Service, "reused", reused, "source", source, "fingerprint", short(fp))
		o := d.machineOutput(ref.MachineID)
		d.mu.Lock()
		o.images = append(o.images, builtImage{service: b.Service, tag: tag, fp: fp, cache: cache})
		d.mu.Unlock()
		built[b.Service] = tag
		if key != "" {
			madeHere[key] = tag
		}
	}
	return built, steps, nil
}

// sharedBuildKey is what two services' builds must agree on to share one
// image: the build's fingerprint (context, Dockerfile, target, args, the
// builder) and the secrets it asks for. "" (no fingerprint): never shared.
func sharedBuildKey(fp string, secrets map[string]string) string {
	if fp == "" {
		return ""
	}
	ids := slices.Sorted(maps.Keys(secrets))
	var sb strings.Builder
	sb.WriteString(fp)
	for _, id := range ids {
		sb.WriteString("\x00")
		sb.WriteString(id)
		sb.WriteString("=")
		sb.WriteString(secrets[id])
	}
	return sb.String()
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
	phases := make([]driver.BootPhase, 0, len(s.Phases))
	for _, p := range s.Phases {
		phases = append(phases, driver.BootPhase{Name: p.Name, Ms: p.Ms, Running: p.Running})
	}
	acc.Phases = driver.MergePhases(-1, acc.Phases, phases)
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

// mirrorBuildArgs are the build's args with the cell mirror's addresses
// added (buildmirror.Mirror.Args): a build reaches registries only through
// the read-only mirror (G1), and the project's own value of each wins.
func mirrorBuildArgs(project map[string]string, cfg Config) map[string]string {
	return buildmirror.Mirror{GoProxy: cfg.MirrorGoProxy, NPM: cfg.MirrorNPM, PyPI: cfg.MirrorPyPI}.Args(project)
}

// builderTrusted reports whether the builds' RUN steps trust the cell CA:
// the cell's own builder, given the cell's trust files.
func (d *Driver) builderTrusted() bool {
	return d.cfg.BuilderImage != "" && d.cfg.BuilderTrustsCellCA && d.cfg.Trust.Set()
}

// buildRun is how one service's build runs: the builder's limits and
// address on the claim network, and the build's args. A trusted builder
// (builderTrusted) also gets the cell's trust bundle and, of the claim's
// secrets (driver.UpRequest.BuildSecrets), those the build asked for
// (sandbox.Build.Secrets), placeholders only. It also returns the memory
// limit, for the error of a build that passed it.
func (d *Driver) buildRun(ctx context.Context, ref driver.MachineRef, b sandbox.Build, tag, network, resolv string, subnet netip.Prefix, secrets map[string]string, out string, push *dockercli.BuildPush) (dockercli.BuildRun, string, error) {
	args := mirrorBuildArgs(b.Args, d.cfg)
	parent, err := d.parentFor(ctx, ref)
	if err != nil {
		return dockercli.BuildRun{}, "", err
	}
	mem, cpus := d.limits(ref.MachineID)
	run := dockercli.BuildRun{
		CgroupParent: parent,
		Image:        d.cfg.BuilderImage, Runtime: d.cfg.Runtime, Network: network, Address: builderAddress(subnet).String(), Resolv: resolv,
		Context: b.Context, Dockerfile: b.Dockerfile, Target: b.Target, Args: args, Tag: tag, Out: out,
		PidsLimit: d.cfg.PidsLimit, MemLimit: mem, CPUs: cpus, RegistryMirror: d.cfg.MirrorRegistry, DiskSize: d.cfg.ContainerDiskSize,
		Labels: toLabels(map[string]string{driver.TagCell: d.cfg.CellID, driver.TagClaim: ref.Tags[driver.TagClaim], driver.TagHardExpires: ref.Tags[driver.TagHardExpires]}),
		Push:   push,
	}
	if d.builderTrusted() {
		run.CABundle, run.Secrets = d.cfg.Trust.Bundle, askedSecrets(secrets, b.Secrets)
	}
	return run, mem, nil
}

// askedSecrets are the claim's secrets a build asked for (sandbox.Build
// Secrets, id to secret name), by the id it reads them under: a build that
// asked for none gets none, and one the claim does not hold is left out.
func askedSecrets(claim, asked map[string]string) map[string]string {
	var out map[string]string
	for id, name := range asked {
		if v, ok := claim[name]; ok {
			if out == nil {
				out = make(map[string]string, len(asked))
			}
			out[id] = v
		}
	}
	return out
}

// buildCacheInput picks what the build starts from and sets it on run: the
// environment's BuildKit state when the cell keeps one and the build may
// hold it, else the environment's exported cache (and, for a setup, a cache
// of its own to write). release gives back what it holds, after the build.
// useState false leaves the environment's state out, for the build that runs
// again after one failed on it.
func (d *Driver) buildCacheInput(ctx context.Context, ref driver.MachineRef, b sandbox.Build, run *dockercli.BuildRun, useState bool) (seeds bool, cacheInput string, release func(), err error) {
	m := d.peek(ref.MachineID)
	setup := m.setup
	seeds = m.seeds
	// The environment's BuildKit state, when the cell keeps one: the build
	// finds its layers and cache mounts there. The exported cache is the
	// fallback of a build that cannot mount the state, or finds it evicted:
	// the seeding setup exports it too (P2, docs/runtime/build-cache.md), so
	// eviction under the disk floor leaves the next builds warm, not cold.
	req := buildstate.Request{Machine: ref.MachineID, Service: b.Service, Org: ref.Tags[driver.TagOrg], Env: ref.Tags[driver.TagEnv], Seeds: setup && seeds}
	cacheInput = "cold"
	var st buildstate.State
	held := false
	if useState {
		st, held = d.states.Acquire(ctx, req)
	}
	org, env := ref.Tags[driver.TagOrg], ref.Tags[driver.TagEnv]
	cacheDir := d.envCacheDir(org, env, b.Service)
	if held {
		release = func() { d.states.Release(st) }
		run.StateDir, run.GCKeepStorage = st.Dir, d.cfg.BuildStateKeep
		cacheInput = stateOverlay
		if st.Mode == buildstate.ModeSeed {
			cacheInput = "state_seed"
		}
		if st.Mode == buildstate.ModeSeed && setup {
			if st.Fresh {
				// A new state (never seeded, or evicted) starts from the
				// environment's exported cache: this cell's, else the store's
				// off the cell (cache_remote.go).
				gen, releaseCache := d.caches.Acquire(cacheDir)
				pulled := false
				if gen == "" && d.remote != nil {
					releaseCache()
					pulled = d.pullRemote(ctx, ref.MachineID, org, env, b.Service)
					gen, releaseCache = d.caches.Acquire(cacheDir)
				}
				if gen != "" {
					run.CacheFrom = gen
					cacheInput = "state_seed_exported"
					if pulled {
						cacheInput = "state_seed_remote"
					}
					prev := release
					release = func() { releaseCache(); prev() }
				} else {
					releaseCache()
				}
			}
			dir, err := d.writableCache(ref.MachineID, b.Service)
			if err != nil {
				release()
				return false, "", nil, err
			}
			run.CacheTo = dir
		}
		d.log().Info("build.state", "machine", ref.MachineID, "service", b.Service, "mode", st.Mode, "fresh", st.Fresh)
	} else {
		// Held for the whole build: a promotion meanwhile adds a generation
		// and leaves this one where the builder mounted it.
		gen, releaseCache := d.caches.Acquire(cacheDir)
		pulled := false
		if gen == "" && d.remote != nil {
			// Neither the state nor an exported cache on this cell: the
			// environment's cache off the cell, when its setup pushed one.
			releaseCache()
			pulled = d.pullRemote(ctx, ref.MachineID, org, env, b.Service)
			gen, releaseCache = d.caches.Acquire(cacheDir)
		}
		release = releaseCache
		run.CacheFrom = gen
		if gen != "" {
			cacheInput = "exported"
			if pulled {
				cacheInput = "remote"
			}
		}
		if setup {
			dir, err := d.writableCache(ref.MachineID, b.Service)
			if err != nil {
				release()
				return false, "", nil, err
			}
			run.CacheTo = dir
		}
	}
	return seeds, cacheInput, release, nil
}

// runBuild runs one build section in the sandbox and loads its image as
// tag. It reads the environment's build cache, and a setup machine's build
// writes its own (returned), for a bake to make the environment's.
func (d *Driver) runBuild(ctx context.Context, ref driver.MachineRef, b sandbox.Build, tag, network, resolv string, subnet netip.Prefix, secrets map[string]string) (string, buildprogress.Summary, error) {
	var none buildprogress.Summary
	if d.cfg.BuilderImage == "" {
		return "", none, ErrNoBuilder
	}
	waitAt := time.Now()
	freeSlot, err := d.waitBuildSlot(ctx)
	if err != nil {
		return "", none, err
	}
	defer freeSlot()
	if waited := time.Since(waitAt); waited > time.Second {
		d.log().Info("build.slot.waited", "machine", ref.MachineID, "service", b.Service, "waitedMs", waited.Milliseconds(), "slots", cap(d.buildSlots))
	}
	// The builder's alone (hostdirs.go): the cell loads the image it finds
	// there, so nobody else may write it.
	out := filepath.Join(d.workDir(), "builds", ref.MachineID, b.Service)
	defer func() { _ = os.RemoveAll(out) }()
	// The registry path (registry.go): the build pushes to a registry of its
	// own, which this Docker pulls from by digest, instead of a tarball.
	// A build that would not seed the environment's registry and finds it never
	// seeded sends a tarball instead (registry.ErrUnseeded).
	var reg *registry.Registry
	var extra []buildprogress.Phase
	transfer := TransferTarball
	if d.registryMode() {
		m := d.peek(ref.MachineID)
		at := time.Now()
		var err error
		switch reg, err = d.registries.Start(ctx, ref, b.Service, network, subnet, m.setup && m.seeds); {
		case errors.Is(err, registry.ErrUnseeded):
			d.log().Info("build.registry.unseeded", "machine", ref.MachineID, "service", b.Service, "transfer", TransferTarball)
			reg = nil
		case err != nil:
			return "", none, err
		default:
			defer reg.Stop(ctx)
			transfer = TransferRegistry
			extra = append(extra, buildprogress.Phase{Name: "start registry", Ms: time.Since(at).Milliseconds()})
		}
	}
	a, err := d.buildOnce(ctx, ref, b, tag, network, resolv, subnet, secrets, out, true, reg)
	if err != nil {
		return "", none, err
	}
	// Held for the whole build, whichever it is.
	release := a.release
	defer func() { release() }()
	built := a.took
	// The environment's state read through an overlay is a cache: it may make
	// a build faster, never decide how it ends. A build that fails in a way the
	// overlay can cause runs again without it, so a failure that remains is
	// the code's, not the cache's (a pull request is never blamed for what the
	// overlay refused).
	stateFallback := false
	if a.err != nil && !a.oom && !a.overDisk && ctx.Err() == nil && a.cacheInput == stateOverlay {
		if why, again := d.overlayRetry(ctx, a); !again {
			d.log().Info("build.state.fallback.skipped", "machine", ref.MachineID, "service", b.Service, "reason", why)
		} else {
			// The error itself starts with the docker command; what failed is
			// the step BuildKit named and the lines it printed (redacted).
			step, lines := "", []string(nil)
			if f, failed := a.steps.Failure(); failed {
				step, lines = f.Step, f.Lines
			}
			d.log().Warn("build.state.fallback", "machine", ref.MachineID, "service", b.Service, "reason", why,
				"step", step, "lines", lines, "err", firstLine(a.err))
			release()
			release = func() {}
			first := a
			if a, err = d.buildOnce(ctx, ref, b, tag, network, resolv, subnet, secrets, out, false, reg); err != nil {
				return "", withPhases(first.ran, extra...), err
			}
			release = a.release
			stateFallback = true
			built += a.took
			// The try on the state was time spent too: it is a phase of its own.
			extra = append(extra, buildprogress.Phase{Name: "failed try on state", Ms: first.took.Milliseconds()})
		}
	}
	err = a.err
	if a.overDisk && reg != nil {
		// What it pushed is the bound's: never sealed into the seed.
		reg.Discard()
	}
	if err != nil && !a.oom && !a.overDisk && ctx.Err() == nil {
		err = buildFailure(a.steps, err)
		// BuildKit named no step: what is left to say why is buildkitd's own log.
		if errors.Is(err, driver.ErrBuilderFailed) && len(a.daemon.Tail) > 0 {
			err = fmt.Errorf("%w\n%s", err, a.daemon.String(builderLogLines))
		}
	}
	outcome := "build_failed"
	var loaded time.Duration
	var imageBytes any // nil means unavailable, not a measured zero-byte image.
	var pushedBytes any
	loadAttempted := err == nil
	phase := "docker load"
	if err == nil {
		at := time.Now()
		if reg != nil {
			phase = "pull image"
			if err = checkBuildOutput(out, d.maxImageBytes()); err == nil {
				var added int64
				added, err = reg.Pull(ctx, out, tag, d.maxImageBytes())
				pushedBytes = added
			}
		} else {
			tarball := filepath.Join(out, dockercli.BuildTarball)
			// Metadata only: never follow a builder's symlink or open a FIFO.
			if info, statErr := os.Lstat(tarball); statErr == nil && info.Mode().IsRegular() {
				imageBytes = info.Size()
			}
			if err = checkBuildOutput(out, d.maxImageBytes()); err == nil {
				err = d.d.LoadImage(ctx, dockercli.ImageLoad{Tarball: tarball, Tag: tag, MaxBytes: d.maxImageBytes()})
			}
		}
		loaded = time.Since(at)
		outcome = "load_failed"
		extra = append(extra, buildprogress.Phase{Name: phase, Ms: loaded.Milliseconds()})
	}
	ran := withPhases(a.ran, extra...)
	switch {
	case err == nil:
		outcome = "success"
	case a.oom:
		outcome = "out_of_memory"
	case ctx.Err() != nil:
		outcome = "canceled"
	case errors.Is(err, driver.ErrImageTooLarge):
		outcome = "image_too_large"
	}
	// The build's export is in the builder's own output (its last step); the
	// load into this Docker is the cell's, so it is told apart here.
	// transfer is how the image reached this Docker (tarball also when the
	// cell's mode is registry and the registry was never seeded); registryAddedBytes what
	// the build added to its registry (the layers it pushed), the measure of
	// what the registry path saved.
	d.log().Info("build.timing", "machine", ref.MachineID, "service", b.Service, "buildMs", built.Milliseconds(), "loadMs", loaded.Milliseconds(),
		"outcome", outcome, "loadAttempted", loadAttempted, "imageTarBytes", imageBytes, "stateFallback", stateFallback,
		"transfer", transfer, "registryAddedBytes", pushedBytes, "phases", ran.Phases)
	if a.oom {
		return "", ran, fmt.Errorf("%w: build %s passed %s (%w)", driver.ErrOutOfMemory, b.Service, a.mem, err)
	}
	if err != nil {
		return "", ran, fmt.Errorf("dockergvisor: build %s: %w", b.Service, err)
	}
	if sink := dockercli.OutputFrom(ctx); sink != nil {
		verb := "loaded"
		if reg != nil {
			verb = "pulled"
		}
		sink(fmt.Sprintf("kodus: %s built in %s, image %s in %s", b.Service, built.Round(time.Second), verb, loaded.Round(time.Second)))
	}
	org, env := ref.Tags[driver.TagOrg], ref.Tags[driver.TagEnv]
	if a.seeds && a.run.CacheTo != "" {
		// The default branch's build: its layers are the environment's now, so a
		// setup that fails after this (boot, health, its ceiling), or a state the
		// disk floor evicts, leaves the next build warm. Nothing is left for a
		// bake to promote.
		if err := d.promoteCache(a.run.CacheTo, org, env, b.Service); err != nil {
			d.log().Warn("build.cache.promote.failed", "machine", ref.MachineID, "service", b.Service, "err", err)
			return a.run.CacheTo, ran, nil
		}
		d.log().Info("build.cache.promoted", "machine", ref.MachineID, "service", b.Service)
		// The environment's exported cache off the cell too, held while it goes.
		if d.remote != nil {
			gen, release := d.caches.Acquire(d.envCacheDir(org, env, b.Service))
			if gen != "" {
				d.pushRemote(ref.MachineID, org, env, b.Service, gen, release)
			} else {
				release()
			}
		}
		return "", ran, nil
	}
	return a.run.CacheTo, ran, nil
}

// withPhases is a build's summary with the cell's own phases added (moving
// the image into Docker, a try that failed), slowest first.
func withPhases(s buildprogress.Summary, extra ...buildprogress.Phase) buildprogress.Summary {
	if len(extra) == 0 {
		return s
	}
	all := append(append([]buildprogress.Phase(nil), s.Phases...), extra...)
	sort.SliceStable(all, func(i, j int) bool { return all[i].Ms > all[j].Ms })
	s.Phases = all
	return s
}

// buildAttempt is one run of the builder for a service and what BuildKit said
// of it. release gives back the cache input it held.
type buildAttempt struct {
	run        dockercli.BuildRun
	mem        string
	seeds      bool
	cacheInput string
	release    func()
	steps      *buildprogress.Tracker
	ran        buildprogress.Summary
	took       time.Duration
	// started is when it began on the driver's clock (overlayRetry).
	started time.Time
	// err is the builder's own failure; oom that it passed its memory limit;
	// overDisk that the cell stopped it for writing past the image bound
	// (watchBuildDisk), err then saying so.
	err      error
	oom      bool
	overDisk bool
	// daemon is what buildkitd's own log said of the attempt.
	daemon dockercli.BuilderLogSummary
}

// buildOnce runs the builder once into a fresh out: the build's run, its
// cache input (useState false leaves the environment's state out), the run
// itself and the steps it reported. Its error is the attempt's setup; the
// build's own failure is in the attempt.
func (d *Driver) buildOnce(ctx context.Context, ref driver.MachineRef, b sandbox.Build, tag, network, resolv string, subnet netip.Prefix, secrets map[string]string, out string, useState bool, reg *registry.Registry) (*buildAttempt, error) {
	if err := os.RemoveAll(out); err != nil {
		return nil, fmt.Errorf("dockergvisor: build %s: %w", b.Service, err)
	}
	if err := d.dirs.builderDir(out); err != nil {
		return nil, err
	}
	var push *dockercli.BuildPush
	if reg != nil {
		push = reg.Push()
	}
	run, mem, err := d.buildRun(ctx, ref, b, tag, network, resolv, subnet, secrets, out, push)
	if err != nil {
		return nil, err
	}
	a := &buildAttempt{run: run, mem: mem}
	if a.seeds, a.cacheInput, a.release, err = d.buildCacheInput(ctx, ref, b, &a.run, useState); err != nil {
		return nil, err
	}
	// A cache input need not contain a matching layer or compiler cache.
	// BuildKit's reported layer hits remain in build.steps.cached.
	// A build that runs without its environment's state because the disk
	// floor took it says so: it is the cold boot the hub hears of
	// (heartbeat evictedBuildStates), not a slow pull request.
	inputAttrs := []any{"machine", ref.MachineID, "service", b.Service, "mode", a.cacheInput}
	if at, evicted := d.states.EvictedAt(ref.Tags[driver.TagOrg], ref.Tags[driver.TagEnv]); evicted && a.run.StateDir == "" {
		inputAttrs = append(inputAttrs, "stateEvictedAt", at)
	}
	d.log().Info("build.cache.input", inputAttrs...)
	at := time.Now()
	a.started = d.clock.Now()
	a.steps = buildprogress.New()
	bctx, unwatch := d.watchBuildDisk(ctx, out, reg, a.run.StateDir)
	a.err = d.d.RunBuild(dockercli.WithOutput(bctx, alsoTo(dockercli.OutputFrom(ctx), a.steps.Line)), a.run)
	if over := unwatch(); over != nil {
		a.err, a.overDisk = over, true
		d.log().Warn("build.disk.stopped", "machine", ref.MachineID, "service", b.Service, "err", over)
	}
	a.took = time.Since(at)
	a.ran = a.steps.Summary(slowestSteps)
	d.logBuildSteps(ref.MachineID, b.Service, a.ran, a.err)
	a.daemon = d.logBuilderLog(ref.MachineID, b.Service, out, a.err)
	a.oom = a.err != nil && !a.overDisk && ctx.Err() == nil && killedAtMemoryLimit(a.err)
	return a, nil
}

// defaultBuildDiskEvery is how often watchBuildDisk measures a running build.
const defaultBuildDiskEvery = 2 * time.Second

// watchBuildDisk bounds, while a build runs, what it writes outside its
// container's disk (Config.ContainerDiskSize caps only that): its output
// directory, the bind where the tarball lands, and on the registry path what
// it adds to its registry's storage. Both are checked against the image bound
// once the build ends; measured only then, a build could fill the host's disk
// first. Past the bound the build is stopped (its context canceled: RunBuild
// removes the builder) with driver.ErrImageTooLarge. Once the cell's disks
// are under the margin above their floor (diskShort), the running build that
// wrote the most is stopped with driver.ErrDiskCapacity, one at a time
// (buildWriters, F1-01): what a build writes into its BuildKit state view is
// measured by no image bound, and the other claims' builds run on. view is
// the build's state view ("" for none). unwatch ends the watch and returns
// why it stopped the build, nil when it did not.
func (d *Driver) watchBuildDisk(ctx context.Context, out string, reg *registry.Registry, view string) (context.Context, func() error) {
	ctx, cancel := context.WithCancelCause(ctx)
	every := time.Duration(0)
	if d.hooks != nil {
		every = d.hooks.buildDiskEvery
	}
	if every <= 0 {
		every = defaultBuildDiskEvery
	}
	w := &buildWriter{out: out, reg: reg, upper: viewUpper(view), stop: cancel}
	d.writers.add(w)
	done, finished := make(chan struct{}), make(chan struct{})
	var over error
	go func() {
		defer close(finished)
		tick := time.NewTicker(every)
		defer tick.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-tick.C:
			}
			if over = d.pastDiskBound(out, reg); over != nil {
				cancel(over)
				return
			}
			if short := d.diskShort(ctx); short != nil {
				d.writers.stopLargest(short, d.clock.Now(), 5*every)
			}
		}
	}()
	return ctx, func() error {
		close(done)
		<-finished
		d.writers.remove(w)
		if cause := context.Cause(ctx); over == nil && errors.Is(cause, driver.ErrDiskCapacity) {
			over = cause
		}
		cancel(nil)
		return over
	}
}

// buildWriter is one running build, as the disk margin weighs it.
type buildWriter struct {
	out   string
	reg   *registry.Registry
	upper string
	stop  context.CancelCauseFunc
}

// maxWriterEntries bounds the walk that weighs a running build under the
// margin; a tree past it counts as the most written.
const maxWriterEntries = 100_000

// written is what the build wrote on the cell's disks: its output, what it
// pushed to its registry, and its state view's upper directory (what it
// added over the environment's state). A seed writes into the state itself,
// which is not weighed.
func (w *buildWriter) written() int64 {
	var total int64
	for _, dir := range []string{w.out, w.upper} {
		if dir == "" {
			continue
		}
		n, err := registry.TreeBytes(dir, "a build's writes", maxWriterEntries)
		var many registry.EntriesError
		if errors.As(err, &many) {
			return math.MaxInt64
		}
		total += n
	}
	if w.reg != nil {
		if n, err := w.reg.Pushed(); err == nil {
			total += n
		}
	}
	return total
}

// viewUpper is the upper directory of a state view mounted at view
// (buildstate: <base>/merged over <base>/upper), "" for none.
func viewUpper(view string) string {
	if view == "" || filepath.Base(view) != "merged" {
		return ""
	}
	return filepath.Join(filepath.Dir(view), "upper")
}

// buildWriters are the builds running on the cell.
type buildWriters struct {
	mu   sync.Mutex
	set  map[*buildWriter]struct{}
	last time.Time // the last stop
}

func (b *buildWriters) add(w *buildWriter) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.set == nil {
		b.set = map[*buildWriter]struct{}{}
	}
	b.set[w] = struct{}{}
}

func (b *buildWriters) remove(w *buildWriter) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.set, w)
}

// stopLargest stops, with why, the running build that wrote the most,
// unless one was stopped within grace: its writes go with it, and the disk
// gets that long to come back before another is weighed.
func (b *buildWriters) stopLargest(why error, now time.Time, grace time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.last.IsZero() && now.Sub(b.last) < grace {
		return
	}
	var top *buildWriter
	most := int64(-1)
	for w := range b.set {
		if n := w.written(); n > most {
			top, most = w, n
		}
	}
	if top == nil {
		return
	}
	b.last = now
	delete(b.set, top)
	top.stop(why)
}

// pastDiskBound says why a running build is past the image bound, or nil: its
// output passed it, or what it added to its registry's storage did. A tree too
// large to walk (past its bound on entries) cannot be measured, so it counts
// as past. A walk that fails otherwise is nil: the next one measures again,
// and the build's end checks it all.
func (d *Driver) pastDiskBound(out string, reg *registry.Registry) error {
	limit := d.maxImageBytes()
	past := func(what string, size int64, err error) error {
		var many registry.EntriesError
		switch {
		case errors.As(err, &many):
			return fmt.Errorf("%w: the build was stopped while it ran: %s holds more than %d files", driver.ErrImageTooLarge, what, many.Max)
		case err == nil && size > limit:
			return fmt.Errorf("%w: the build was stopped while it ran: %s passed %d bytes", driver.ErrImageTooLarge, what, limit)
		}
		return nil
	}
	size, err := registry.TreeBytes(out, "the build's output", maxBuildOutputEntries)
	if over := past("its output", size, err); over != nil || reg == nil {
		return over
	}
	pushed, err := reg.Pushed()
	return past("what it pushed", pushed, err)
}

// overlayRetry says whether a build that failed on the state overlay runs
// again without it, and why. What the overlay holds (BuildKit's snapshots and
// the RUN --mount=type=cache directories) can fail the builder or the solve
// around the steps, or a step that mounts a cache; it cannot make a step
// that mounts none exit with an error, so that failure is the code's and is
// not built twice. Nor is a build whose claim would end before a second,
// cold run as long as the first could finish.
func (d *Driver) overlayRetry(ctx context.Context, a *buildAttempt) (string, bool) {
	if f, failed := a.steps.Failure(); failed && f.ProcessExit && !f.CacheMount {
		return "step_failed", false
	}
	if deadline, ok := ctx.Deadline(); ok {
		took := d.clock.Now().Sub(a.started)
		if deadline.Sub(d.clock.Now()) < took {
			return "no_time", false
		}
	}
	return "overlay_may_cause", true
}

// buildkitSaysSolveFailed is a builder whose stderr carries BuildKit's own
// "failed to solve" line: the build's failure, though no step was tracked.
func buildkitSaysSolveFailed(err error) bool {
	return strings.Contains(err.Error(), "failed to solve")
}

// buildFailure says how a build that ran failed: docker could not run the
// builder (exit 125 to 127), or the builder ended without BuildKit saying a
// step or the solve failed (driver.ErrBuilderFailed, the platform's); else the
// step that failed and the first lines it printed that say why, ahead of the
// docker command around it.
func buildFailure(steps *buildprogress.Tracker, err error) error {
	if code, ok := dockercli.ExitCode(err); ok && code >= 125 && code <= 127 {
		return fmt.Errorf("%w: docker could not run the builder (exit %d): %w", driver.ErrBuilderFailed, code, err)
	}
	f, failed := steps.Failure()
	if !failed {
		if !steps.SolveFailed() && !buildkitSaysSolveFailed(err) {
			return fmt.Errorf("%w: the builder ended with no step failed: %w", driver.ErrBuilderFailed, err)
		}
		return err
	}
	var lead strings.Builder
	fmt.Fprintf(&lead, "step %s failed:", f.Step)
	for _, l := range f.Lines {
		lead.WriteString("\n  " + l)
	}
	return fmt.Errorf("%s\n%w", lead.String(), err)
}

// maxBuildOutputEntries bounds what checkBuildOutput walks: the builder
// leaves its tarball and its config there, nothing else.
const maxBuildOutputEntries = 64

// checkBuildOutput bounds what the builder left in out before the cell
// loads from it: a build that wrote past maxBytes (driver.ErrImageTooLarge),
// or more entries than a build leaves (driver.ErrImageLoad), is refused. It
// never follows a link the builder made.
func checkBuildOutput(out string, maxBytes int64) error {
	var total int64
	entries := 0
	err := filepath.WalkDir(out, func(path string, e os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entries++; entries > maxBuildOutputEntries {
			return fmt.Errorf("%w: the build left more than %d entries", driver.ErrImageLoad, maxBuildOutputEntries)
		}
		if !e.Type().IsRegular() {
			return nil
		}
		info, err := e.Info()
		if err != nil {
			return err
		}
		if total += info.Size(); total > maxBytes {
			return fmt.Errorf("%w: the build left more than %d bytes", driver.ErrImageTooLarge, maxBytes)
		}
		return nil
	})
	if err != nil && !errors.Is(err, driver.ErrImageLoad) && !errors.Is(err, driver.ErrImageTooLarge) {
		return fmt.Errorf("%w: build output: %w", driver.ErrImageLoad, err)
	}
	return err
}

func (d *Driver) maxImageBytes() int64 {
	if d.cfg.MaxImageBytes > 0 {
		return d.cfg.MaxImageBytes
	}
	return dockercli.DefaultMaxImageBytes
}

// slowestSteps is how many of a build's steps build.steps names.
const slowestSteps = 8

// stateOverlay names the cache input of a build that reads the environment's
// BuildKit state through a disposable overlay.
const stateOverlay = "state_overlay"

// firstLine is an error's first line, bounded, for a log field.
func firstLine(err error) string {
	s := err.Error()
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

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

// logBuilderLog logs what buildkitd's own log said of a build
// (build.builder_log): its warning and error counts, and how many layers the
// overlay differ could not compute, each then exported by walking the whole
// tree, which slows a build without failing it. The redacted tail goes with a
// failed build or one buildkitd warned of; the event is a warning when
// buildkitd fell back or logged an error.
func (d *Driver) logBuilderLog(machine, service, out string, err error) dockercli.BuilderLogSummary {
	s, rerr := dockercli.ReadBuilderLog(out)
	if rerr != nil {
		d.log().Warn("build.builder_log.unreadable", "machine", machine, "service", service, "err", rerr)
		return s
	}
	if s.Lines == 0 {
		return s
	}
	attrs := []any{
		"machine", machine, "service", service, "ok", err == nil, "lines", s.Lines, "warnings", s.Warnings,
		"errors", s.Errors, "overlayDifferFallbacks", s.OverlayDifferFallbacks, "truncated", s.Truncated,
	}
	if err != nil || s.Warnings > 0 || s.Errors > 0 {
		attrs = append(attrs, "tail", s.Tail)
	}
	if s.OverlayDifferFallbacks > 0 || s.Errors > 0 {
		d.log().Warn("build.builder_log", attrs...)
	} else {
		d.log().Info("build.builder_log", attrs...)
	}
	return s
}

// builderLogLines is how many of buildkitd's last lines the error of a build
// carries when BuildKit named no step that failed.
const builderLogLines = 8

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

// slots is the cell's build slots, MaxBuilds wide (half the host's CPUs,
// at least one, when 0).
func (d *Driver) slots() chan struct{} {
	d.slotsOnce.Do(func() {
		n := d.cfg.MaxBuilds
		if n <= 0 {
			n = max(1, runtime.NumCPU()/2)
		}
		d.buildSlots = make(chan struct{}, n)
	})
	return d.buildSlots
}

// waitBuildSlot takes one of the cell's build slots, waiting while every
// one is taken; the wait ends with ctx.
func (d *Driver) waitBuildSlot(ctx context.Context) (func(), error) {
	slots := d.slots()
	select {
	case slots <- struct{}{}:
		return func() { <-slots }, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("dockergvisor: waiting for one of the cell's %d build slots: %w", cap(slots), ctx.Err())
	}
}

// buildSlot takes a slot without waiting on a context (tests).
func (d *Driver) buildSlot() func() {
	release, _ := d.waitBuildSlot(context.Background())
	return release
}
