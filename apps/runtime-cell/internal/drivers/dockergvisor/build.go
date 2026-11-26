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
	"sync/atomic"
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

// builderHost is the first builder's fixed address in the claim subnet,
// and the one below it its registry's: below the services' (sandbox), so the
// claim's policy can name it before Up. A builder that runs beside another
// of its claim (a lane, buildLanes) takes the next pair down: lane 1 the
// hosts 6 and 7, lane 2 the 4 and 5, lane 3 the 2 and 3; the gateway is 1.
const builderHost = 9

// maxClaimBuilds is how many builders of one claim the addresses below the
// services hold.
const maxClaimBuilds = 4

func laneAddress(subnet netip.Prefix, host, lane int) netip.Addr {
	a := subnet.Masked().Addr()
	for range host - 2*lane {
		a = a.Next()
	}
	return a
}

func builderAddress(subnet netip.Prefix, lane int) netip.Addr {
	return laneAddress(subnet, builderHost, lane)
}

// registryAddress is where a build's registry sits on the claim network:
// next to its builder, one address below.
func registryAddress(subnet netip.Prefix, lane int) netip.Addr {
	return laneAddress(subnet, builderHost-1, lane)
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
// claim); any other runs in the sandbox, at a builder address of its own,
// and is loaded. Builds that need the builder run side by side (buildLanes
// says how many); services that name the same build make one image. What the
// machine holds is removed with it, unless a bake pinned it first.
// It also says where the builds that ran spent their time (BuildSteps).
//
// A build that fails stops the builds after it in the project's order and
// leaves the ones before it running: the error is the first failing service
// in that order, whatever the timing, as when they ran one after the other.
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
	// Services that name the same build (one Dockerfile and target for an
	// api and its worker) share the image the first of them made: same
	// fingerprint and the same secrets asked for (S-28). The first is the
	// leader; the others wait for it, then tag its image.
	units := make([]*buildUnit, len(builds))
	leaders := map[string]*buildUnit{}
	for i, b := range builds {
		u := &buildUnit{b: b, tag: builtTag(ref.MachineID, b.Service), done: make(chan struct{})}
		var err error
		if u.fp, err = buildfingerprint.Of(b, d.cfg.BuilderImage); err != nil {
			d.log().Warn("build.fingerprint.failed", "machine", ref.MachineID, "service", b.Service, "err", err)
			u.fp = ""
		}
		u.key = sharedBuildKey(u.fp, b.Secrets)
		if lead, ok := leaders[u.key]; ok && u.key != "" {
			u.leader = lead
		} else {
			leaders[u.key] = u
		}
		units[i] = u
	}
	lanes := d.newBuildLanes(ref, len(leaders))
	// Each build has a context of its own: one that fails ends the builds
	// after it, never the ones before it.
	ctxs := make([]context.Context, len(units))
	cancels := make([]context.CancelCauseFunc, len(units))
	for i := range units {
		ctxs[i], cancels[i] = context.WithCancelCause(ctx)
	}
	defer func() {
		for _, cancel := range cancels {
			cancel(nil)
		}
	}()
	var wg sync.WaitGroup
	for i, u := range units {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer close(u.done)
			u.err = d.buildUnit(ctxs[i], ref, u, selected, lanes, network, resolv, subnet, secrets, shared)
			if u.err != nil {
				for _, cancel := range cancels[i+1:] {
					cancel(errSiblingBuildFailed)
				}
			}
		}()
	}
	wg.Wait()
	built := map[string]string{}
	var first error
	for _, u := range units {
		if len(u.pulled) > 0 {
			steps.Phases = driver.MergePhases(-1, steps.Phases, u.pulled)
		}
		if u.ranBuild {
			steps = addBuildSteps(steps, u.b.Service, u.ran)
		}
		if u.err != nil && first == nil {
			first = u.err
		}
		built[u.b.Service] = u.tag
	}
	if first != nil {
		return nil, steps, first
	}
	return built, steps, nil
}

// errSiblingBuildFailed is why a build was stopped: an earlier service's
// build failed (the cause of its context).
var errSiblingBuildFailed = errors.New("dockergvisor: an earlier service's build failed")

// buildUnit is one service's build section in a call to build: what it is,
// and what came of it.
type buildUnit struct {
	b       sandbox.Build
	tag     string
	fp, key string
	// leader is the first service that names this same build; nil for that
	// one, and for a build nobody shares.
	leader *buildUnit
	done   chan struct{}
	// What came of it, read once done is closed.
	err      error
	ran      buildprogress.Summary
	ranBuild bool
	pulled   []driver.BootPhase
}

// buildUnit gets one service's image: from its leader's, the machine's own,
// the environment's bake, another cell's, or a build of its own.
func (d *Driver) buildUnit(ctx context.Context, ref driver.MachineRef, u *buildUnit, selected *bakecatalog.Generation, lanes *buildLanes, network, resolv string, subnet netip.Prefix, secrets map[string]string, shared []driver.SharedImage) error {
	b, tag, fp := u.b, u.tag, u.fp
	if u.leader != nil {
		select {
		case <-u.leader.done:
		case <-ctx.Done():
			return context.Cause(ctx)
		}
		if u.leader.err != nil {
			return u.leader.err
		}
		// A failed tag only costs this service its own build.
		if err := d.d.TagImage(ctx, u.leader.tag, tag); err != nil {
			d.log().Warn("build.share.failed", "machine", ref.MachineID, "service", b.Service, "err", err)
		} else {
			d.log().Info("build.done", "machine", ref.MachineID, "service", b.Service, "reused", true, "source", "service", "fingerprint", short(fp))
			d.recordBuilt(ref, builtImage{service: b.Service, tag: tag, fp: fp})
			return nil
		}
	}
	// A reset brings the same checkout up again: the machine's own image
	// of this build stands, as long as the input is still the same.
	if fp != "" && d.hasBuilt(ref.MachineID, b.Service, fp) {
		d.log().Info("build.done", "machine", ref.MachineID, "service", b.Service, "reused", true, "source", "machine", "fingerprint", short(fp))
		return nil
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
			return ErrBakeDataUnavailable
		}
		switch err := reuseErr; {
		case err == nil:
			reused = true
		case !errors.Is(err, dockercli.ErrNoSuchImage):
			return fmt.Errorf("dockergvisor: baked image for %s: %w", b.Service, err)
		}
	}
	// Another cell of the org baked this build (UpRequest.SharedImages):
	// its image by the hub's digest, before building it here.
	fromShare := false
	if !reused && fp != "" {
		if digest := sharedDigest(shared, fp); digest != "" {
			at := d.clock.Now()
			fromShare = d.takeShared(ctx, ref, b.Service, fp, digest, tag, shared)
			u.pulled = []driver.BootPhase{{Name: PhasePullShared, Ms: d.clock.Now().Sub(at).Milliseconds()}}
			reused = fromShare
		}
	}
	cache := ""
	if !reused {
		lane, release, err := lanes.take(ctx)
		if err != nil {
			return err
		}
		defer release()
		bctx := prefixedOutput(withBuildLane(ctx, lane, lanes.size), lanes.size, b.Service)
		var ran buildprogress.Summary
		cache, ran, err = d.runBuild(bctx, ref, b, tag, network, resolv, subnet, secrets)
		u.ran, u.ranBuild = ran, true
		if err != nil {
			return err
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
	d.recordBuilt(ref, builtImage{service: b.Service, tag: tag, fp: fp, cache: cache})
	return nil
}

// recordBuilt adds an image to what the machine holds.
func (d *Driver) recordBuilt(ref driver.MachineRef, im builtImage) {
	o := d.machineOutput(ref.MachineID)
	d.mu.Lock()
	o.images = append(o.images, im)
	d.mu.Unlock()
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
	return buildmirror.Mirror{GoProxy: cfg.MirrorGoProxy, NPM: cfg.MirrorNPM, PyPI: cfg.MirrorPyPI, Artifacts: cfg.MirrorArtifacts}.Args(project)
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
	lane, lanes := buildLane(ctx)
	mem = laneMemory(mem, lanes)
	dockerfileDir, err := declaredDockerfile(b, args, out)
	if err != nil {
		return dockercli.BuildRun{}, "", err
	}
	run := dockercli.BuildRun{
		CgroupParent: parent, DockerfileDir: dockerfileDir,
		Image: d.cfg.BuilderImage, Runtime: d.cfg.Runtime, Network: network, Address: builderAddress(subnet, lane).String(), Resolv: resolv,
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

// dockerfileSuffix names the directory beside a build's out that holds its
// Dockerfile with the mirror's build args declared (declaredDockerfile).
const dockerfileSuffix = ".dockerfile"

// declaredDockerfile writes the build's Dockerfile with the mirror's build
// args declared in every stage (buildmirror.DeclareArgs) beside out, and
// returns its directory: a team's own Dockerfile then reaches the mirror's
// Prisma engines, MongoDB binaries and Cypress app as Kody's does. Empty when
// the cell adds no arg, or the Dockerfile is not a plain file of the context
// (the build then reads the context's, as before).
func declaredDockerfile(b sandbox.Build, args map[string]string, out string) (string, error) {
	var names []string
	for k := range args {
		if _, own := b.Args[k]; !own {
			names = append(names, k)
		}
	}
	if len(names) == 0 || b.Dockerfile == "" || filepath.IsAbs(b.Dockerfile) || strings.Contains(b.Dockerfile, "..") {
		return "", nil
	}
	sort.Strings(names)
	src := filepath.Join(b.Context, b.Dockerfile)
	if fi, err := os.Lstat(src); err != nil || !fi.Mode().IsRegular() || fi.Size() > 1<<20 {
		return "", nil
	}
	text, err := os.ReadFile(src)
	if err != nil {
		return "", nil
	}
	dir := out + dockerfileSuffix
	if err := os.RemoveAll(dir); err != nil {
		return "", fmt.Errorf("dockergvisor: build %s: %w", b.Service, err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("dockergvisor: build %s: %w", b.Service, err)
	}
	if err := os.WriteFile(filepath.Join(dir, filepath.Base(b.Dockerfile)), buildmirror.DeclareArgs(text, names), 0o644); err != nil {
		return "", fmt.Errorf("dockergvisor: build %s: %w", b.Service, err)
	}
	return dir, nil
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
func (d *Driver) buildCacheInput(ctx context.Context, ref driver.MachineRef, b sandbox.Build, run *dockercli.BuildRun, useState bool, prep *[]buildprogress.Phase) (seeds bool, cacheInput string, release func(), err error) {
	// note records how long a part of getting the cache ready took.
	note := func(name string, since time.Time) {
		*prep = append(*prep, buildprogress.Phase{Name: name, Ms: d.clock.Now().Sub(since).Milliseconds()})
	}
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
		at := d.clock.Now()
		st, held = d.states.Acquire(ctx, req)
		note(PhaseCacheState, at)
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
					at := d.clock.Now()
					pulled = d.pullRemote(ctx, ref.MachineID, org, env, b.Service)
					note(PhaseCachePull, at)
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
			at := d.clock.Now()
			pulled = d.pullRemote(ctx, ref.MachineID, org, env, b.Service)
			note(PhaseCachePull, at)
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
	// late are the phases of what runs after the build's result is known (the
	// registry's stop, the cache's release, the output's removal): they end in
	// defers, so the inner call cannot return them.
	var late []buildprogress.Phase
	cache, ran, err := d.runBuildPhases(ctx, ref, b, tag, network, resolv, subnet, secrets, &late)
	return cache, withPhases(ran, late...), err
}

// Phase names the cell's own parts of a build carry, next to BuildKit's
// (buildprogress): the time between a claim asking for a build and the image
// being in Docker that no BuildKit step names. Short and stable, the Run
// page lists them as they are.
const (
	PhaseBuildSlot   = "build slot"
	PhaseCacheState  = "cache state"
	PhaseCachePull   = "cache pull"
	PhaseBuilderBoot = "builder start"
	PhaseCachePromo  = "cache promote"
	PhaseStopReg     = "stop registry"
	PhaseReleaseHold = "release cache"
	PhaseCleanOut    = "clean output"
	PhasePullShared  = "pull shared image"
)

func laneIndex(ctx context.Context) int {
	i, _ := buildLane(ctx)
	return i
}

func (d *Driver) runBuildPhases(ctx context.Context, ref driver.MachineRef, b sandbox.Build, tag, network, resolv string, subnet netip.Prefix, secrets map[string]string, late *[]buildprogress.Phase) (string, buildprogress.Summary, error) {
	var none buildprogress.Summary
	if d.cfg.BuilderImage == "" {
		return "", none, ErrNoBuilder
	}
	// since adds a phase that ended now.
	since := func(name string, at time.Time) buildprogress.Phase {
		return buildprogress.Phase{Name: name, Ms: d.clock.Now().Sub(at).Milliseconds()}
	}
	var extra []buildprogress.Phase
	waitAt := time.Now()
	slotAt := d.clock.Now()
	freeSlot, err := d.waitBuildSlot(ctx)
	if err != nil {
		// The claim's ceiling stopped it waiting: this is where it was.
		p := since(PhaseBuildSlot, slotAt)
		p.Running = true
		return "", withPhases(none, p), err
	}
	defer freeSlot()
	extra = append(extra, since(PhaseBuildSlot, slotAt))
	if waited := time.Since(waitAt); waited > time.Second {
		d.log().Info("build.slot.waited", "machine", ref.MachineID, "service", b.Service, "waitedMs", waited.Milliseconds(), "slots", cap(d.buildSlots))
	}
	// The builder's alone (hostdirs.go): the cell loads the image it finds
	// there, so nobody else may write it.
	out := filepath.Join(d.workDir(), "builds", ref.MachineID, b.Service)
	defer func() {
		at := d.clock.Now()
		_ = os.RemoveAll(out)
		_ = os.RemoveAll(out + dockerfileSuffix)
		*late = append(*late, since(PhaseCleanOut, at))
	}()
	// The registry path (registry.go): the build pushes to a registry of its
	// own, which this Docker pulls from by digest, instead of a tarball.
	// A build that would not seed the environment's registry and finds it never
	// seeded sends a tarball instead (registry.ErrUnseeded).
	var reg *registry.Registry
	transfer := TransferTarball
	if d.registryMode() {
		m := d.peek(ref.MachineID)
		at := d.clock.Now()
		var err error
		switch reg, err = d.registries.Start(ctx, ref, b.Service, network, registryAddress(subnet, laneIndex(ctx)), m.setup && m.seeds); {
		case errors.Is(err, registry.ErrUnseeded):
			d.log().Info("build.registry.unseeded", "machine", ref.MachineID, "service", b.Service, "transfer", TransferTarball)
			reg = nil
		case err != nil:
			return "", none, err
		default:
			defer func() {
				at := d.clock.Now()
				reg.Stop(ctx)
				*late = append(*late, since(PhaseStopReg, at))
			}()
			transfer = TransferRegistry
			extra = append(extra, since("start registry", at))
		}
	}
	a, err := d.buildOnce(ctx, ref, b, tag, network, resolv, subnet, secrets, out, true, reg)
	if err != nil {
		return "", none, err
	}
	// Held for the whole build, whichever it is.
	release := a.release
	defer func() {
		at := d.clock.Now()
		release()
		*late = append(*late, since(PhaseReleaseHold, at))
	}()
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
			// What the failed try spent getting its cache ready is time too.
			extra = append(extra, first.prep...)
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
	if err != nil && !a.oom && !a.overDisk && !a.stalled && ctx.Err() == nil {
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
		at := d.clock.Now()
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
		loaded = d.clock.Now().Sub(at)
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
		promoteAt := d.clock.Now()
		err := d.promoteCache(a.run.CacheTo, org, env, b.Service)
		ran = withPhases(ran, since(PhaseCachePromo, promoteAt))
		if err != nil {
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
	// prep are the cell's own phases of the attempt (the cache's state and
	// pull, the builder's start): already in ran, kept apart for the try that
	// ran again.
	prep []buildprogress.Phase
	// err is the builder's own failure; oom that it passed its memory limit;
	// overDisk that the cell stopped it for writing past the image bound
	// (watchBuildDisk), err then saying so.
	err      error
	oom      bool
	overDisk bool
	// stalled: the cell stopped the builder for printing nothing outside the
	// project's steps (watchBuildStall); err then says so.
	stalled bool
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
	if a.seeds, a.cacheInput, a.release, err = d.buildCacheInput(ctx, ref, b, &a.run, useState, &a.prep); err != nil {
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
	bctx, unstall := d.watchBuildStall(bctx, a.steps)
	// The builder's container and buildkitd start before BuildKit prints a
	// line: the time to the first one is the builder's start.
	var firstLine atomic.Int64
	bootAt := d.clock.Now()
	mark := func(string) { firstLine.CompareAndSwap(0, d.clock.Now().UnixNano()) }
	a.err = d.d.RunBuild(dockercli.WithOutput(bctx, alsoTo(alsoTo(dockercli.OutputFrom(ctx), a.steps.Line), mark)), a.run)
	if stall := unstall(); stall != nil && a.err != nil {
		a.err, a.stalled = stall, true
		d.log().Warn("build.stalled", "machine", ref.MachineID, "service", b.Service, "err", stall)
	}
	if over := unwatch(); over != nil {
		a.err, a.overDisk = over, true
		d.log().Warn("build.disk.stopped", "machine", ref.MachineID, "service", b.Service, "err", over)
	}
	a.took = time.Since(at)
	if n := firstLine.Load(); n != 0 {
		a.prep = append(a.prep, buildprogress.Phase{Name: PhaseBuilderBoot, Ms: max(n-bootAt.UnixNano(), 0) / int64(time.Millisecond)})
	}
	a.ran = withPhases(a.steps.Summary(slowestSteps), a.prep...)
	d.logBuildSteps(ref.MachineID, b.Service, a.ran, a.err)
	a.daemon = d.logBuilderLog(ref.MachineID, b.Service, out, a.err)
	a.oom = a.err != nil && !a.overDisk && ctx.Err() == nil && killedAtMemoryLimit(a.err)
	return a, nil
}

// defaultBuildStallAfter is how long a builder may print nothing while no
// step of the project runs, and defaultBuildStallEvery how often that is
// looked at (watchBuildStall). BuildKit's own steps (loading the Dockerfile
// and the base image's metadata, resolving the frontend) print within seconds.
const (
	defaultBuildStallAfter = 5 * time.Minute
	defaultBuildStallEvery = 15 * time.Second
)

// watchBuildStall stops a build whose builder printed nothing for the stall
// limit while no step of the project was running: a builder that hangs
// between BuildKit's own steps (on dev, a host disk restored lazily stalled
// under it for over ten minutes) is the cell's, and without this it waited
// out the worker's boot limit, which reads as the pull request's boot_timeout.
// Silence inside a project step (a RUN, a COPY) is the project's and never
// stops it. The returned func ends the watch and says why it stopped the
// build: driver.ErrBuilderFailed, the platform's (builder_failed); nil when
// it did not.
func (d *Driver) watchBuildStall(ctx context.Context, steps *buildprogress.Tracker) (context.Context, func() error) {
	ctx, cancel := context.WithCancelCause(ctx)
	after, every := defaultBuildStallAfter, defaultBuildStallEvery
	if d.hooks != nil && d.hooks.buildStallAfter > 0 {
		after = d.hooks.buildStallAfter
	}
	if d.hooks != nil && d.hooks.buildStallEvery > 0 {
		every = d.hooks.buildStallEvery
	}
	// The wall clock, as the tracker's lines are stamped (buildprogress.New).
	started := time.Now()
	done, finished := make(chan struct{}), make(chan struct{})
	var stalled error
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
			last := steps.LastLine()
			if last.IsZero() {
				last = started
			}
			if quiet := time.Since(last); quiet >= after && !steps.ProjectStepRunning() {
				stalled = fmt.Errorf("%w: the builder printed nothing for %s outside the project's steps", driver.ErrBuilderFailed, quiet.Round(time.Second))
				cancel(stalled)
				return
			}
		}
	}()
	return ctx, func() error {
		close(done)
		<-finished
		cancel(nil)
		return stalled
	}
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
