package dockergvisor

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// fakeDataOps records the steps of a data-only reset and fails the ones a
// case names, the first `times` calls of each.
type fakeDataOps struct {
	calls     []string
	failFirst map[string]int
	unhealthy bool
	healthErr error
}

func (f *fakeDataOps) step(name string) error {
	f.calls = append(f.calls, name)
	if f.failFirst[name] > 0 {
		f.failFirst[name]--
		return errors.New(name + " failed")
	}
	return nil
}
func (f *fakeDataOps) stopData(context.Context) error    { return f.step("stop") }
func (f *fakeDataOps) restoreData(context.Context) error { return f.step("restore") }
func (f *fakeDataOps) startData(context.Context) error   { return f.step("start") }
func (f *fakeDataOps) awaitData(context.Context) error   { return f.step("await-data") }
func (f *fakeDataOps) restartApp(context.Context) error  { return f.step("restart-app") }
func (f *fakeDataOps) awaitApp(context.Context) error    { return f.step("await-app") }
func (f *fakeDataOps) appHealthy(context.Context) (bool, error) {
	f.calls = append(f.calls, "app-healthy")
	return !f.unhealthy, f.healthErr
}

// A data-only reset stops the data services, restores them, starts them,
// waits for them, asks the app whether it is healthy, and restarts only an
// app that is not; any step that fails sends the reset to the next mode,
// restart-app, which restarts the app whatever its health says, and then to
// recreate, which tries nothing.
func TestADataResetFollowsItsModesInOrder(t *testing.T) {
	data := []string{"stop", "restore", "start", "await-data"}
	join := func(parts ...[]string) []string {
		var out []string
		for _, p := range parts {
			out = append(out, p...)
		}
		return out
	}
	for _, tc := range []struct {
		name      string
		from      driver.DataResetMode
		ops       fakeDataOps
		want      driver.DataResetMode
		calls     []string
		failedNum int
	}{
		{name: "a healthy app is left alone", from: driver.ResetModeData, want: driver.ResetModeData,
			calls: join(data, []string{"app-healthy"})},
		{name: "an app that lost its connections is restarted, and the mode stays data", from: driver.ResetModeData, ops: fakeDataOps{unhealthy: true}, want: driver.ResetModeData,
			calls: join(data, []string{"app-healthy", "restart-app", "await-app"})},
		{name: "a data service that does not start falls back to restart-app, which redoes the data steps", from: driver.ResetModeData, ops: fakeDataOps{failFirst: map[string]int{"await-data": 1}},
			want: driver.ResetModeRestartApp, failedNum: 1,
			calls: join(data, data, []string{"restart-app", "await-app"})},
		{name: "a failed health check falls back to restart-app", from: driver.ResetModeData, ops: fakeDataOps{healthErr: errors.New("docker")},
			want: driver.ResetModeRestartApp, failedNum: 1,
			calls: join(data, []string{"app-healthy"}, data, []string{"restart-app", "await-app"})},
		{name: "an app that never comes back after its restart falls back to restart-app, then to recreate", from: driver.ResetModeData, ops: fakeDataOps{unhealthy: true, failFirst: map[string]int{"await-app": 2}},
			want: driver.ResetModeRecreate, failedNum: 2,
			calls: join(data, []string{"app-healthy", "restart-app", "await-app"}, data, []string{"restart-app", "await-app"})},
		{name: "a restore that always fails ends in recreate after two tries", from: driver.ResetModeData, ops: fakeDataOps{failFirst: map[string]int{"restore": 9}},
			want: driver.ResetModeRecreate, failedNum: 2,
			calls: []string{"stop", "restore", "stop", "restore"}},
		{name: "a stop that fails is not followed by a restore", from: driver.ResetModeData, ops: fakeDataOps{failFirst: map[string]int{"stop": 9}},
			want: driver.ResetModeRecreate, failedNum: 2,
			calls: []string{"stop", "stop"}},
		{name: "an environment known to need restart-app starts there and never asks the app", from: driver.ResetModeRestartApp, want: driver.ResetModeRestartApp,
			calls: join(data, []string{"restart-app", "await-app"})},
		{name: "restart-app failing is recreate", from: driver.ResetModeRestartApp, ops: fakeDataOps{failFirst: map[string]int{"restart-app": 1}}, want: driver.ResetModeRecreate, failedNum: 1,
			calls: join(data, []string{"restart-app"})},
		{name: "an environment known to need recreate tries nothing", from: driver.ResetModeRecreate, want: driver.ResetModeRecreate},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ops := tc.ops
			got, failed := runDataReset(context.Background(), &ops, tc.from)
			if got != tc.want || len(failed) != tc.failedNum {
				t.Fatalf("mode %s with %d failures (%v), want %s with %d", got, len(failed), failed, tc.want, tc.failedNum)
			}
			if !slices.Equal(ops.calls, tc.calls) {
				t.Fatalf("steps\n got %v\nwant %v", ops.calls, tc.calls)
			}
		})
	}
}

// A data reset whose context ended stops trying modes and says recreate with
// the context's error, so the caller can tell a cancelled step from a failed one.
func TestACancelledDataResetTriesNoMoreModes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ops := &fakeDataOps{}
	got, failed := runDataReset(ctx, ops, driver.ResetModeData)
	if got != driver.ResetModeRecreate || len(failed) != 1 || !errors.Is(failed[0], context.Canceled) || len(ops.calls) != 0 {
		t.Fatalf("mode %s, failures %v, steps %v", got, failed, ops.calls)
	}
}

const dataPlanCompose = `{"services":{
 "web":{"image":"x","depends_on":{"db":{}}, "build":{"context":"."}},
 "db":{"image":"postgres:16","environment":{"POSTGRES_USER":"shop"},"volumes":[{"type":"volume","source":"pg","target":"/var/lib/postgresql/data"}]},
 "cache":{"image":"redis:7"},
 "minio":{"image":"minio/minio","volumes":[{"type":"volume","source":"blobs","target":"/data"}]},
 "mailer":{"image":"mailhog/mailhog"},
 "worker":{"image":"app:1","depends_on":{"db":{}},"volumes":[{"type":"volume","source":"w","target":"/w"}]}
},"volumes":{"pg":{},"blobs":{}}}`

// The services a data-only reset restores are the recipe's data.services
// when it names them, else every image-only non-public service that mounts a
// named volume or is a known database; it refuses a recipe that names a
// built or public service, a service that is not there, a data service that
// depends on the app, and a project with no data service.
func TestPlanDataResetChoosesTheDataServices(t *testing.T) {
	head := "version: 1\nservices:\n  compose: { files: [docker-compose.yml], public: web }\n  expose: [{ service: web, port: 80, kind: http }]\ndata:\n  reset: data-only\n"
	for _, tc := range []struct {
		name, recipe, compose string
		built                 map[string]string
		want                  []string
		why                   string
	}{
		{name: "inferred from image-only services with a volume or a database image", recipe: head, compose: dataPlanCompose,
			built: map[string]string{"worker": "kodus-built/worker"}, want: []string{"cache", "db", "minio"}},
		{name: "an image-only service with a volume is data unless the cell built it", recipe: head, compose: dataPlanCompose, want: []string{"cache", "db", "minio", "worker"}},
		{name: "named by the recipe", recipe: head + "  services: [db, minio]\n", compose: dataPlanCompose, want: []string{"db", "minio"}},
		{name: "a named service that is not in the project", recipe: head + "  services: [nope]\n", compose: dataPlanCompose, why: "not a service of the project"},
		{name: "a named service that is built", recipe: head + "  services: [db]\n", compose: dataPlanCompose, built: map[string]string{"db": "img"}, why: "built or public"},
		{name: "a data service that depends on a non-data service", recipe: head + "  services: [db, worker]\n", compose: strings.Replace(dataPlanCompose, `"worker":{"image":"app:1","depends_on":{"db":{}}`, `"worker":{"image":"app:1","depends_on":{"web":{}}`, 1), why: "depends on web"},
		{name: "no data service", recipe: head, compose: `{"services":{"web":{"image":"x"}}}`, why: "no data service"},
		{name: "a recipe that is not data-only", recipe: strings.Replace(head, "data-only", "snapshot", 1), compose: dataPlanCompose, why: "not data-only"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			writeFile(t, filepath.Join(dir, recipe.Path), tc.recipe)
			rec, err := recipe.Load(dir)
			if err != nil {
				t.Fatal(err)
			}
			p, why := planDataReset([]byte(tc.compose), rec, tc.built)
			if tc.why != "" {
				if p != nil || !strings.Contains(why, tc.why) {
					t.Fatalf("plan %+v, why %q, want a refusal naming %q", p, why, tc.why)
				}
				return
			}
			if p == nil || !slices.Equal(p.services, tc.want) {
				t.Fatalf("plan %+v (%s), want %v", p, why, tc.want)
			}
			if p.pgUser["db"] != "shop" || len(p.pgUser) != 1 {
				t.Fatalf("postgres users %v", p.pgUser)
			}
		})
	}
}

// An environment whose data reset fell back is remembered at the mode that
// worked for six hours, a success of the data mode forgets it, and another
// environment is not affected.
func TestTheModeThatWorkedIsRememberedPerEnvironment(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC))
	d := &Driver{clock: clk}
	a, b := machine("claim-1", "env-a"), machine("claim-2", "env-b")
	if got := d.learnedDataMode(a); got != driver.ResetModeData {
		t.Fatalf("a new environment starts at %s", got)
	}
	d.learnDataMode(a, driver.ResetModeData, driver.ResetModeRestartApp)
	if got := d.learnedDataMode(a); got != driver.ResetModeRestartApp {
		t.Fatalf("after a fallback %s", got)
	}
	if got := d.learnedDataMode(b); got != driver.ResetModeData {
		t.Fatalf("another environment is at %s", got)
	}
	d.learnDataMode(a, driver.ResetModeRestartApp, driver.ResetModeRecreate)
	if got := d.learnedDataMode(a); got != driver.ResetModeRecreate {
		t.Fatalf("after a second fallback %s", got)
	}
	clk.Advance(dataModeTTL + time.Minute)
	if got := d.learnedDataMode(a); got != driver.ResetModeData {
		t.Fatalf("after the demotion expired %s", got)
	}
	d.learnDataMode(a, driver.ResetModeData, driver.ResetModeRestartApp)
	d.learnDataMode(a, driver.ResetModeRestartApp, driver.ResetModeData)
	if got := d.learnedDataMode(a); got != driver.ResetModeData {
		t.Fatalf("after data worked again %s", got)
	}
}

// dataMachine is a driver with a created machine whose project runs a
// postgres (db, an anonymous data volume) and an app, planned for a
// data-only reset, as Up and RunRecipe leave it.
func dataMachine(t *testing.T) (*Driver, *memDocker, driver.MachineRef) {
	t.Helper()
	d, docker := withEgress(t)
	d.clock = clock.NewFake(time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC))
	ctx := context.Background()
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	if err != nil {
		t.Fatal(err)
	}
	spec := drivertest.BaseSpec("cell-1", "claim-1", n)
	spec.ExpiresAt, spec.HardExpiresAt = time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
	ref, err := d.Create(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	cell := dockercli.LabelFromTag(driver.TagCell)
	plant := func(id, svc string, mounts ...dockercli.Mount) {
		docker.plant(dockercli.Container{ID: id, Name: ref.MachineID + "-" + svc, Labels: map[string]string{
			cell: "cell-1", "com.docker.compose.project": ref.MachineID, "com.docker.compose.service": svc}, Mounts: mounts})
	}
	plant("cdb", "db", dockercli.Mount{Type: "volume", Name: "anon-1", Destination: "/var/lib/postgresql/data"})
	plant("capp", "app")
	docker.volumes["anon-1"] = memVolume{data: "migrated and seeded"}
	rec, err := recipe.Parse([]byte("version: 1\nservices: { compose: { public: app } }\ndata: { reset: data-only }\n"))
	if err != nil {
		t.Fatal(err)
	}
	canonical := `{"services":{"app":{"image":"x","build":{}},"db":{"image":"postgres:16"}}}`
	plan, why := planDataReset([]byte(canonical), rec, nil)
	if plan == nil {
		t.Fatal(why)
	}
	d.mu.Lock()
	m := d.machineLocked(ref.MachineID)
	m.dataPlan = plan
	m.targets = map[string]execTarget{"db": {container: "cdb"}, "app": {container: "capp"}}
	m.services = map[string]string{"app": "10.0.0.10", "db": "10.0.0.11"}
	d.mu.Unlock()
	return d, docker, ref
}

// The first boot's copy stops only the data service, copies its anonymous
// volume to a volume labelled for the reaper, starts it again and leaves a
// healthy app alone.
func TestTheFirstBootCopiesTheDataServicesAndKeepsTheApp(t *testing.T) {
	d, docker, ref := dataMachine(t)
	if err := d.takeDataCopy(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	m := d.peek(ref.MachineID)
	if m.dataCopy == nil || len(m.dataCopy.vols) != 1 || m.dataOff {
		t.Fatalf("copy %+v off %v", m.dataCopy, m.dataOff)
	}
	if want := []string{"stop db", "start db"}; !slices.Equal(docker.svcOps, want) {
		t.Fatalf("compose verbs %v, want %v", docker.svcOps, want)
	}
	v := docker.volumes[m.dataCopy.vols[0].copy]
	if v.data != "migrated and seeded" || v.labels[labelGoldenOf] != ref.MachineID {
		t.Fatalf("copy %+v", v)
	}
}

// A copy that cannot be made costs the machine its data resets, removes what
// it half copied, brings the data service back, and does not fail the boot.
func TestACopyThatFailsEndsTheDataResetsButNotTheBoot(t *testing.T) {
	d, docker, ref := dataMachine(t)
	delete(docker.volumes, "anon-1") // the source is gone: the copy fails
	if err := d.takeDataCopy(context.Background(), ref); err != nil {
		t.Fatalf("the boot failed: %v", err)
	}
	if m := d.peek(ref.MachineID); !m.dataOff || m.dataCopy != nil {
		t.Fatalf("off %v copy %+v", m.dataOff, m.dataCopy)
	}
	if want := []string{"stop db", "start db"}; !slices.Equal(docker.svcOps, want) {
		t.Fatalf("compose verbs %v, want %v", docker.svcOps, want)
	}
	got, err := d.ResetData(context.Background(), ref)
	if err != nil || got.Mode != driver.ResetModeRecreate {
		t.Fatalf("reset %+v, %v", got, err)
	}
}

// A data service that does not come back after the copy fails the boot,
// since the machine is broken.
func TestADataServiceThatDoesNotComeBackFailsTheCopy(t *testing.T) {
	d, docker, ref := dataMachine(t)
	docker.svcErr = map[string]error{"start": errors.New("no such container")}
	if err := d.takeDataCopy(context.Background(), ref); err == nil {
		t.Fatal("the boot went on with a stopped database")
	}
}

// A reset after the first boot restores the data service's volume over the
// live one, in place, runs the cheap health check and, finding the app
// running, restarts nothing: only the data service is stopped and started.
func TestAResetRestoresTheDataAndLeavesAHealthyAppAlone(t *testing.T) {
	d, docker, ref := dataMachine(t)
	if err := d.takeDataCopy(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	docker.svcOps = nil
	docker.volumes["anon-1"] = memVolume{data: "what the round wrote"}
	got, err := d.ResetData(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	if got.Mode != driver.ResetModeData || !slices.Equal(got.Sources, []string{"10.0.0.10", "10.0.0.11"}) {
		t.Fatalf("reset %+v", got)
	}
	if v := docker.volumes["anon-1"]; v.data != "migrated and seeded" {
		t.Fatalf("the data is %q", v.data)
	}
	if want := []string{"stop db", "start db"}; !slices.Equal(docker.svcOps, want) {
		t.Fatalf("compose verbs %v, want %v", docker.svcOps, want)
	}
}

// An app that reports itself unhealthy after the data came back is the only
// thing restarted, and the mode is still data.
func TestAnAppThatLostItsConnectionsIsRestartedAlone(t *testing.T) {
	d, docker, ref := dataMachine(t)
	if err := d.takeDataCopy(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	docker.svcOps = nil
	docker.health = map[string]string{"capp": "unhealthy"}
	// It reports healthy once restarted.
	docker.onRestart = func() { docker.health = nil }
	got, err := d.ResetData(context.Background(), ref)
	if err != nil || got.Mode != driver.ResetModeData {
		t.Fatalf("reset %+v, %v", got, err)
	}
	if want := []string{"stop db", "start db", "restart app"}; !slices.Equal(docker.svcOps, want) {
		t.Fatalf("compose verbs %v, want %v", docker.svcOps, want)
	}
}

// When every mode fails the reset says recreate, with the reasons, and the
// environment is remembered at recreate, so the next machine of it asks
// nothing of Docker.
func TestAResetThatFailsEverywhereSaysRecreateAndIsRemembered(t *testing.T) {
	d, docker, ref := dataMachine(t)
	if err := d.takeDataCopy(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	docker.svcOps = nil
	docker.svcErr = map[string]error{"start": errors.New("daemon says no")}
	got, err := d.ResetData(context.Background(), ref)
	if err != nil || got.Mode != driver.ResetModeRecreate || !strings.Contains(got.Why, "daemon says no") {
		t.Fatalf("reset %+v, %v", got, err)
	}
	docker.svcOps = nil
	again, err := d.ResetData(context.Background(), ref)
	if err != nil || again.Mode != driver.ResetModeRecreate || len(docker.svcOps) != 0 {
		t.Fatalf("second reset %+v, %v, verbs %v", again, err, docker.svcOps)
	}
}

// A machine the data reset cannot serve, with no plan, no copy or an app
// instrumented for coverage, is told to recreate without touching Docker.
func TestAMachineWithNothingToRestoreRecreates(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*machineState)
		why  string
	}{
		{"no plan", func(m *machineState) { m.dataPlan, m.dataWhy = nil, "no data service" }, "no data service"},
		{"no copy", func(m *machineState) { m.dataCopy = nil }, "no data copy"},
		{"copy off", func(m *machineState) { m.dataOff = true }, "off"},
		{"coverage", func(m *machineState) { m.coverage = []string{"app"} }, "coverage"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, docker, ref := dataMachine(t)
			d.mu.Lock()
			m := d.machineLocked(ref.MachineID)
			m.dataCopy = &dataCopy{vols: []dataVolume{{service: "db", target: "/var/lib/postgresql/data", copy: "c"}}}
			tc.edit(m)
			d.mu.Unlock()
			got, err := d.ResetData(context.Background(), ref)
			if err != nil || got.Mode != driver.ResetModeRecreate || !strings.Contains(got.Why, tc.why) || len(docker.svcOps) != 0 {
				t.Fatalf("reset %+v, %v, verbs %v", got, err, docker.svcOps)
			}
		})
	}
}
