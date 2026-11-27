package dockergvisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// Data-only reset (data.reset: data-only; docs/runtime/persistent-state.md
// section 11). A reset that recreates the project pays the app's whole start
// again, 4 to 7 minutes of a slow app under gVisor. When the recipe opts in,
// the first boot, once its setup, migrate and seed ran, keeps a copy of the
// data services' volumes (disk only, never memory), and a reset gives them
// back that copy while the app container keeps running:
//
//  1. stop the data services only, copy their volumes back over the live
//     ones, start them and wait for their health;
//  2. ask the app's containers whether they are running and healthy; when
//     they are not (they lost their connections), restart only the app.
//
// Any step failing falls back, in order: restart-app (the same steps, then
// the app restarted whatever its health check said), then recreate, which is
// the reset the cell always had (the caller runs it: Reset, Up, the recipe's
// steps). The mode that worked is remembered per environment, so an
// environment whose app cannot take a data reset does not try it each round.
//
// What a copy never holds: the app's memory, the files of the app's own
// containers, a bind mount. A recipe whose app keeps round state in its
// process or its own disk keeps recreate.

const (
	// dataPoll is how often a wait asks Docker for the services' state.
	dataPoll = 500 * time.Millisecond
	// dataModeTTL is how long a demotion of an environment is remembered: a
	// transient failure must not cost it the fast path for good.
	dataModeTTL = 6 * time.Hour
)

// dataResetPlan is what a data-only reset acts on, from the recipe and what
// compose will run (planDataReset).
type dataResetPlan struct {
	// services are the data services, sorted.
	services []string
	// pgUser is the superuser of each one whose image is postgres: the
	// server answers over TCP only once its init is over.
	pgUser map[string]string
	// wait bounds each wait for health.
	wait time.Duration
	// inPlace is the faster reset that never stops the data services
	// (datareset_inplace.go); nil, with inPlaceWhy, when it cannot be used.
	inPlace    *inPlacePlan
	inPlaceWhy string
}

// planDataReset says which services a data-only reset copies and restores,
// or why none: the recipe's data.services when it names them, else every
// image-only non-public service that mounts a named volume or is a known
// database (its image keeps its data in an anonymous volume). The copied
// services must depend on each other only: starting them never starts the
// app. built are the services the cell built (they are the app).
func planDataReset(canonical []byte, rec *recipe.Recipe, built map[string]string) (*dataResetPlan, string) {
	if rec == nil || rec.ResetStrategy() != recipe.ResetDataOnly {
		return nil, "data.reset is not data-only"
	}
	var doc canonicalProject
	if err := json.Unmarshal(canonical, &doc); err != nil {
		return nil, "compose config: " + err.Error()
	}
	public := rec.Services.Compose.Public
	imageOnly := func(name string) bool {
		s, ok := doc.Services[name]
		return ok && s.Image != "" && len(s.Build) == 0 && built[name] == "" && !slices.Contains(public, name)
	}
	chosen := map[string]bool{}
	if len(rec.Data.Services) > 0 {
		for _, name := range rec.Data.Services {
			if _, ok := doc.Services[name]; !ok {
				return nil, "data.services names " + name + ", not a service of the project"
			}
			if !imageOnly(name) {
				return nil, "data.services names " + name + ", which is built or public"
			}
			chosen[name] = true
		}
	} else {
		for name, s := range doc.Services {
			if imageOnly(name) && (hasNamedVolume(s) || postgresImages[imageName(s.Image)] || databaseImages[imageName(s.Image)]) {
				chosen[name] = true
			}
		}
	}
	if len(chosen) == 0 {
		return nil, "no data service"
	}
	for name := range chosen {
		for dep := range doc.Services[name].DependsOn {
			if !chosen[dep] {
				return nil, "the data service " + name + " depends on " + dep + ", which is not a data service"
			}
		}
	}
	p := &dataResetPlan{services: sortedSet(chosen), pgUser: map[string]string{}, wait: rec.HealthTimeout()}
	hinted := map[string]bool{}
	for _, h := range rec.Data.InPlace.Postgres {
		hinted[h.Service] = true
	}
	for _, name := range p.services {
		s := doc.Services[name]
		if !postgresImages[imageName(s.Image)] && !hinted[name] {
			continue
		}
		p.pgUser[name] = "postgres"
		if u := s.Environment["POSTGRES_USER"]; u != nil && *u != "" {
			p.pgUser[name] = *u
		}
	}
	p.inPlace, p.inPlaceWhy = planInPlace(rec, doc.Services, p)
	return p, ""
}

func hasNamedVolume(s canonicalService) bool {
	for _, v := range s.Volumes {
		if v.Type == "volume" {
			return true
		}
	}
	return false
}

// dataCopy is a machine's copy of its data services' volumes, taken after
// its first boot's recipe steps.
type dataCopy struct{ vols []dataVolume }

// dataVolume is one copied mount: where it goes back (the service's mount
// target, resolved to the live volume on each restore, since a recreate
// makes new anonymous volumes) and the volume holding the copy.
type dataVolume struct{ service, target, copy string }

// dataResetOps is what a data-only reset does to the machine's containers,
// one method per step, so the order and the fallbacks are tested apart from
// Docker (datareset_test.go).
type dataResetOps interface {
	// inPlace is true when the in-place mode can run: the golden copies exist.
	inPlace() bool
	swapPostgres(ctx context.Context) error
	reimportFirebase(ctx context.Context) error
	stopData(ctx context.Context) error
	restoreData(ctx context.Context) error
	startData(ctx context.Context) error
	awaitData(ctx context.Context) error
	appHealthy(ctx context.Context) (bool, error)
	restartApp(ctx context.Context) error
	awaitApp(ctx context.Context) error
}

// dataModeOrder is the modes from the fastest down; recreate, the last, is
// no attempt at all.
var dataModeOrder = []driver.DataResetMode{driver.ResetModeInPlace, driver.ResetModeData, driver.ResetModeRestartApp, driver.ResetModeRecreate}

func modeRank(m driver.DataResetMode) int { return slices.Index(dataModeOrder, m) }

// runDataReset tries the modes from `from` down: in-place, data,
// restart-app, and recreate, the last being no attempt at all. It returns the
// mode that worked, and what each failed mode said. In-place is skipped when
// the machine has no golden copy of its databases.
func runDataReset(ctx context.Context, ops dataResetOps, from driver.DataResetMode) (driver.DataResetMode, []error) {
	var failed []error
	for _, mode := range dataModeOrder[:3] {
		if modeRank(mode) < modeRank(from) || (mode == driver.ResetModeInPlace && !ops.inPlace()) {
			continue
		}
		if err := ctx.Err(); err != nil {
			return driver.ResetModeRecreate, append(failed, err)
		}
		if err := tryDataMode(ctx, ops, mode); err != nil {
			failed = append(failed, fmt.Errorf("%s: %w", mode, err))
			continue
		}
		return mode, failed
	}
	return driver.ResetModeRecreate, failed
}

type dataStep struct {
	name string
	run  func(context.Context) error
}

// tryDataMode runs one mode: the data services back (in place, or from the
// copy of their volumes), then the app as the mode says.
func tryDataMode(ctx context.Context, ops dataResetOps, mode driver.DataResetMode) error {
	steps := []dataStep{{"stop data", ops.stopData}, {"restore data", ops.restoreData}, {"start data", ops.startData}, {"await data", ops.awaitData}}
	if mode == driver.ResetModeInPlace {
		steps = []dataStep{{"swap postgres", ops.swapPostgres}, {"reimport firebase", ops.reimportFirebase}}
	}
	for _, step := range steps {
		if err := step.run(ctx); err != nil {
			return fmt.Errorf("%s: %w", step.name, err)
		}
	}
	if mode == driver.ResetModeData || mode == driver.ResetModeInPlace {
		ok, err := ops.appHealthy(ctx)
		if err != nil {
			return fmt.Errorf("app health: %w", err)
		}
		if ok {
			return nil
		}
	}
	return restartAppAndWait(ctx, ops)
}

func restartAppAndWait(ctx context.Context, ops dataResetOps) error {
	if err := ops.restartApp(ctx); err != nil {
		return fmt.Errorf("restart app: %w", err)
	}
	if err := ops.awaitApp(ctx); err != nil {
		return fmt.Errorf("await app: %w", err)
	}
	return nil
}

// dataModeFact is what the cell remembers of an environment: the mode that
// last worked after a fallback.
type dataModeFact struct {
	mode driver.DataResetMode
	at   time.Time
}

func dataModeKey(ref driver.MachineRef) string {
	return ref.Tags[driver.TagOrg] + "/" + ref.Tags[driver.TagEnv]
}

// learnedDataMode is the mode an environment starts from: in-place unless an
// earlier fallback demoted it less than dataModeTTL ago.
func (d *Driver) learnedDataMode(ref driver.MachineRef) driver.DataResetMode {
	d.mu.Lock()
	defer d.mu.Unlock()
	f, ok := d.dataModes[dataModeKey(ref)]
	if !ok || d.clock.Now().Sub(f.at) > dataModeTTL {
		delete(d.dataModes, dataModeKey(ref))
		return driver.ResetModeInPlace
	}
	return f.mode
}

// learnDataMode remembers a demotion (worked is below from) and forgets it
// when a faster mode than the remembered one worked.
func (d *Driver) learnDataMode(ref driver.MachineRef, from, worked driver.DataResetMode) {
	d.mu.Lock()
	defer d.mu.Unlock()
	key := dataModeKey(ref)
	switch {
	case worked == driver.ResetModeInPlace || modeRank(worked) < modeRank(from):
		delete(d.dataModes, key)
	case worked != from:
		if d.dataModes == nil {
			d.dataModes = map[string]dataModeFact{}
		}
		d.dataModes[key] = dataModeFact{mode: worked, at: d.clock.Now()}
	}
}

var _ driver.DataResetter = (*Driver)(nil)

// ResetData is driver.DataResetter: the machine's data services back from
// their copy with the app kept, or a mode that says the caller recreates.
func (d *Driver) ResetData(ctx context.Context, ref driver.MachineRef) (driver.DataReset, error) {
	if _, err := d.owned(ctx, ref.MachineID); err != nil {
		return driver.DataReset{}, err
	}
	m := d.peek(ref.MachineID)
	recreate := func(why string) (driver.DataReset, error) {
		d.log().Info("data.reset", "machine", ref.MachineID, "mode", driver.ResetModeRecreate, "why", why)
		return driver.DataReset{Mode: driver.ResetModeRecreate, Why: why}, nil
	}
	switch {
	case m.dataPlan == nil:
		return recreate(orElse(m.dataWhy, "no data-only plan"))
	case m.dataOff:
		return recreate("the machine's data copy is off")
	case m.dataCopy == nil:
		return recreate("no data copy was taken")
	case len(m.coverage) > 0:
		return recreate("the app is instrumented for coverage, which only its exit flushes")
	}
	from := d.learnedDataMode(ref)
	if from == driver.ResetModeInPlace && !m.inPlaceReady {
		from = driver.ResetModeData
	}
	if from == driver.ResetModeRecreate {
		return recreate("an earlier round of this environment fell back to recreate")
	}
	project, _ := d.projectOf(ref.MachineID)
	parent, err := d.parentFor(ctx, ref)
	if err != nil {
		return recreate("claim limits: " + err.Error())
	}
	ops := &dockerDataOps{d: d, project: project, plan: m.dataPlan, cp: m.dataCopy, targets: m.targets, parent: parent, golden: m.inPlaceReady}
	started := d.clock.Now()
	mode, failed := runDataReset(ctx, ops, from)
	if err := ctx.Err(); err != nil {
		return driver.DataReset{}, err
	}
	d.learnDataMode(ref, from, mode)
	for _, f := range failed {
		d.log().Warn("data.reset.fallback", "machine", ref.MachineID, "err", f)
	}
	if mode == driver.ResetModeRecreate {
		return recreate(orElse(errors.Join(failed...).Error(), "no mode left to try"))
	}
	d.log().Info("data.reset", "machine", ref.MachineID, "mode", mode, "ms", d.clock.Now().Sub(started).Milliseconds(), "fellBack", len(failed))
	return driver.DataReset{Mode: mode, Sources: slices.Sorted(maps.Values(m.services))}, nil
}

func orElse(a, b string) string {
	if a == "" || a == "<nil>" {
		return b
	}
	return a
}

// takeDataCopy keeps the first boot's data (RunRecipe, after the recipe's
// steps): the data services stop, their volumes are copied under labels the
// reaper takes with the machine, and they start again, the app restarted
// when it lost them. A copy that fails costs the machine its data resets,
// never the boot; only data services or an app that do not come back fail it.
func (d *Driver) takeDataCopy(ctx context.Context, ref driver.MachineRef) error {
	m := d.peek(ref.MachineID)
	if m.dataPlan == nil || m.dataCopy != nil || m.dataOff {
		return nil
	}
	project, _ := d.projectOf(ref.MachineID)
	parent, err := d.parentFor(ctx, ref)
	if err != nil {
		d.dataCopyOff(ctx, ref, nil, "claim limits: "+err.Error())
		return nil
	}
	ops := &dockerDataOps{d: d, project: project, plan: m.dataPlan, targets: m.targets, parent: parent}
	at := d.clock.Now()
	// The golden databases first: the volume copy below then holds them too,
	// so a volume restore (the fallback) brings them back after a recreate.
	golden := d.takeInPlaceGolden(ctx, ref, ops)
	var cp *dataCopy
	err = ops.stopData(ctx)
	if err == nil {
		cp, err = d.copyDataOut(ctx, ref, ops)
	}
	// The services come back whatever the copy said.
	back := errors.Join(ops.startData(ctx), ops.awaitData(ctx))
	if back == nil {
		if ok, herr := ops.appHealthy(ctx); herr != nil || !ok {
			back = restartAppAndWait(ctx, ops)
		}
	}
	if back != nil {
		d.dataCopyOff(ctx, ref, cp, "the services did not come back: "+back.Error())
		return fmt.Errorf("data copy: %w", back)
	}
	if err != nil {
		d.dataCopyOff(ctx, ref, cp, err.Error())
		return nil
	}
	d.mu.Lock()
	d.machineLocked(ref.MachineID).dataCopy = cp
	d.machineLocked(ref.MachineID).inPlaceReady = golden
	d.mu.Unlock()
	d.log().Info("data.copy.taken", "machine", ref.MachineID, "services", strings.Join(m.dataPlan.services, ","), "volumes", len(cp.vols), "ms", d.clock.Now().Sub(at).Milliseconds())
	return nil
}

// copyDataOut copies each mounted volume of the stopped data services to a
// volume of its own, named and labelled as the golden copies are (so
// Destroy and the reaper remove them: removeGolden).
func (d *Driver) copyDataOut(ctx context.Context, ref driver.MachineRef, ops *dockerDataOps) (*dataCopy, error) {
	cp := &dataCopy{}
	for _, svc := range ops.plan.services {
		mounts, err := ops.mountsOf(ctx, svc)
		if err != nil {
			return cp, err
		}
		for _, mnt := range mounts {
			key := goldenKey(svc, mnt.Destination)
			v := dataVolume{service: svc, target: strings.TrimSuffix(mnt.Destination, "/"), copy: goldenName(d.cfg.CellID, ref.MachineID, key)}
			labels := d.goldenLabels(ref)
			labels[labelGoldenOf], labels[labelGoldenKey] = ref.MachineID, key
			cp.vols = append(cp.vols, v)
			if err := d.copyVolume(ctx, mnt.Name, v.copy, labels, ops.parent); err != nil {
				return cp, fmt.Errorf("copy %s %s: %w", svc, mnt.Destination, err)
			}
		}
	}
	if len(cp.vols) == 0 {
		return cp, errors.New("the data services mount no volume")
	}
	return cp, nil
}

// dataCopyOff ends the machine's data resets and removes what it copied.
func (d *Driver) dataCopyOff(ctx context.Context, ref driver.MachineRef, cp *dataCopy, why string) {
	d.mu.Lock()
	m := d.machineLocked(ref.MachineID)
	m.dataOff, m.dataCopy = true, nil
	d.mu.Unlock()
	if cp != nil {
		names := make([]string, 0, len(cp.vols))
		for _, v := range cp.vols {
			names = append(names, v.copy)
		}
		if err := d.d.VolumeRemove(context.WithoutCancel(ctx), names...); err != nil {
			d.log().Warn("data.copy.drop.failed", "machine", ref.MachineID, "err", err)
		}
	}
	d.log().Info("data.copy.off", "machine", ref.MachineID, "reason", why)
}

// dockerDataOps is dataResetOps on the host's Docker.
type dockerDataOps struct {
	d       *Driver
	project string
	plan    *dataResetPlan
	cp      *dataCopy
	targets map[string]execTarget
	parent  string
	// golden is true when the first boot left the in-place copies.
	golden bool
}

func (o *dockerDataOps) apps() []string {
	var out []string
	for svc := range o.targets {
		if !slices.Contains(o.plan.services, svc) {
			out = append(out, svc)
		}
	}
	sort.Strings(out)
	return out
}

// mountsOf are the volumes the service's container mounts now: an anonymous
// one has the name Docker gave this container's.
func (o *dockerDataOps) mountsOf(ctx context.Context, svc string) ([]dockercli.Mount, error) {
	t, ok := o.targets[svc]
	if !ok {
		return nil, fmt.Errorf("%s is not in the project", svc)
	}
	cs, err := o.d.d.Inspect(ctx, t.container)
	if err != nil || len(cs) != 1 {
		return nil, errors.Join(fmt.Errorf("inspect %s", svc), err)
	}
	var out []dockercli.Mount
	for _, m := range cs[0].Mounts {
		if m.Type == "volume" {
			out = append(out, m)
		}
	}
	return out, nil
}

func (o *dockerDataOps) stopData(ctx context.Context) error {
	return o.d.d.ComposeStopServices(ctx, o.project, o.plan.services...)
}

func (o *dockerDataOps) startData(ctx context.Context) error {
	return o.d.d.ComposeStartServices(ctx, o.project, o.plan.services...)
}

func (o *dockerDataOps) restoreData(ctx context.Context) error {
	live := map[string]string{} // service + target -> the container's volume
	for _, svc := range o.plan.services {
		mounts, err := o.mountsOf(ctx, svc)
		if err != nil {
			return err
		}
		for _, m := range mounts {
			live[svc+"\x00"+strings.TrimSuffix(m.Destination, "/")] = m.Name
		}
	}
	for _, v := range o.cp.vols {
		to, ok := live[v.service+"\x00"+v.target]
		if !ok {
			return fmt.Errorf("%s no longer mounts a volume at %s", v.service, v.target)
		}
		// No labels: the live volume stays what it is, its contents are replaced.
		if err := o.d.copyVolume(ctx, v.copy, to, nil, o.parent); err != nil {
			return fmt.Errorf("restore %s %s: %w", v.service, v.target, err)
		}
	}
	return nil
}

func (o *dockerDataOps) awaitData(ctx context.Context) error {
	if err := o.await(ctx, o.plan.services); err != nil {
		return err
	}
	polls := strconv.Itoa(max(int(o.plan.wait/seedPoll), 1))
	for _, svc := range o.plan.services {
		user, ok := o.plan.pgUser[svc]
		if !ok {
			continue
		}
		pctx, cancel := context.WithTimeout(ctx, o.plan.wait+30*time.Second)
		_, err := o.d.d.ExecInput(pctx, o.targets[svc].container, nil, "/bin/sh", "-c", pgDataDir, "kodus-data-reset", polls, user)
		cancel()
		if err != nil {
			return fmt.Errorf("%s does not answer: %w", svc, err)
		}
	}
	return nil
}

// appHealthy: every app container runs and none reports itself unhealthy.
// It is the cheap check: a process that lost its connections and does not
// say so is what the rollout gate (persistent-state.md section 11) measures.
func (o *dockerDataOps) appHealthy(ctx context.Context) (bool, error) {
	running, err := o.state(ctx, "status", "running")
	if err != nil {
		return false, err
	}
	unhealthy, err := o.state(ctx, "health", "unhealthy")
	if err != nil {
		return false, err
	}
	for _, svc := range o.apps() {
		id := o.targets[svc].container
		if !running[id] || unhealthy[id] {
			return false, nil
		}
	}
	return true, nil
}

func (o *dockerDataOps) restartApp(ctx context.Context) error {
	apps := o.apps()
	if len(apps) == 0 {
		return nil
	}
	return o.d.d.ComposeRestartServices(ctx, o.project, apps...)
}

func (o *dockerDataOps) awaitApp(ctx context.Context) error { return o.await(ctx, o.apps()) }

// state is the project's containers with filter key=value, by id.
func (o *dockerDataOps) state(ctx context.Context, key, value string) (map[string]bool, error) {
	ids, err := o.d.d.IDs(ctx, dockercli.Filters{"label": {"com.docker.compose.project=" + o.project}, key: {value}})
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}

// await waits until every service's container runs and none is still
// starting or unhealthy, for at most the plan's wait.
func (o *dockerDataOps) await(ctx context.Context, services []string) error {
	if len(services) == 0 {
		return nil
	}
	deadline := o.d.clock.Now().Add(o.plan.wait)
	for {
		running, err := o.state(ctx, "status", "running")
		if err != nil {
			return err
		}
		starting, err := o.state(ctx, "health", "starting")
		if err != nil {
			return err
		}
		unhealthy, err := o.state(ctx, "health", "unhealthy")
		if err != nil {
			return err
		}
		waiting := ""
		for _, svc := range services {
			id := o.targets[svc].container
			switch {
			case !running[id]:
				waiting = svc + " is not running"
			case starting[id]:
				waiting = svc + " is still starting"
			case unhealthy[id]:
				waiting = svc + " is unhealthy"
			}
			if waiting != "" {
				break
			}
		}
		if waiting == "" {
			return nil
		}
		if !o.d.clock.Now().Before(deadline) {
			return fmt.Errorf("%s after %s", waiting, o.plan.wait)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-o.d.clock.After(dataPoll):
		}
	}
}
