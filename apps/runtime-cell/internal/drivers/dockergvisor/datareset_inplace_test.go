package dockergvisor

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

const inPlaceHead = "version: 1\nservices:\n  compose: { files: [docker-compose.yml], public: web }\n  expose: [{ service: web, port: 80, kind: http }]\ndata:\n  reset: data-only\n"

const inPlaceCompose = `{"services":{
 "web":{"image":"x","build":{"context":"."}},
 "emu":{"image":"x","build":{"context":"."}},
 "db":{"image":"postgres:16","environment":{"POSTGRES_USER":"shop","POSTGRES_DB":"shopdb"}},
 "audit":{"image":"acme/custom-db:1","volumes":[{"type":"volume","source":"a","target":"/var/lib/postgresql/data"}]},
 "cache":{"image":"redis:7","volumes":[{"type":"volume","source":"c","target":"/data"}]}
}}`

// The in-place mode covers a project only when every data service is
// Postgres, found by image or by the recipe's hint; the database is the
// hint's, else the seed's, else POSTGRES_DB, else the user's. It refuses a
// plan with a data service it cannot template (redis), a hint for a service
// that is not a data service, an off switch, a database name too long for its
// golden copy, and an emulator service that is not in the project.
func TestPlanInPlaceChoosesWhatItCovers(t *testing.T) {
	for _, tc := range []struct {
		name, data, compose string
		want                []pgInPlace
		firebase            *firebaseInPlace
		why                 string
	}{
		{name: "a postgres image with POSTGRES_DB", data: "  services: [db]\n",
			want: []pgInPlace{{service: "db", user: "shop", databases: []string{"shopdb"}}}},
		{name: "the database defaults to the user", data: "  services: [db]\n",
			compose: `{"services":{"web":{"image":"x","build":{}},"db":{"image":"postgres:16"}}}`,
			want:    []pgInPlace{{service: "db", user: "postgres", databases: []string{"postgres"}}}},
		{name: "the seed's database beats POSTGRES_DB", data: "  services: [db]\n  seed: { service: db, sql: seed.sql, database: seeded }\n",
			want: []pgInPlace{{service: "db", user: "shop", databases: []string{"seeded"}}}},
		{name: "a hint beats everything and makes an unknown image a postgres", data: "  services: [db, audit]\n  in_place:\n    postgres: [{ service: audit, databases: [a1, a2] }]\n",
			want: []pgInPlace{{service: "audit", user: "postgres", databases: []string{"a1", "a2"}}, {service: "db", user: "shop", databases: []string{"shopdb"}}}},
		{name: "the emulators ride along", data: "  services: [db]\n  in_place:\n    firebase: { service: emu, import_dir: /fb, project: demo-x }\n",
			want:     []pgInPlace{{service: "db", user: "shop", databases: []string{"shopdb"}}},
			firebase: &firebaseInPlace{service: "emu", importDir: "/fb", project: "demo-x"}},
		{name: "a redis next to the postgres keeps the volume restore", data: "  services: [db, cache]\n", why: "cache is not Postgres"},
		{name: "a hint for a service that is not a data service", data: "  services: [db]\n  in_place:\n    postgres: [{ service: audit }]\n", why: "audit, which is not a data service"},
		{name: "off", data: "  services: [db]\n  in_place: { off: true }\n", why: "data.in_place.off"},
		{name: "a database name too long for its golden copy (the compose file's, which the recipe cannot bound)", data: "  services: [db]\n",
			compose: `{"services":{"web":{"image":"x","build":{}},"db":{"image":"postgres:16","environment":{"POSTGRES_DB":"` + strings.Repeat("d", 51) + `"}}}}`, why: "too long"},
		{name: "emulators that are not in the project", data: "  services: [db]\n  in_place:\n    firebase: { service: nope, import_dir: /fb }\n", why: "not a service of the project"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec, err := recipe.Parse([]byte(inPlaceHead + tc.data))
			if err != nil {
				t.Fatal(err)
			}
			compose := orElse(tc.compose, inPlaceCompose)
			p, why := planDataReset([]byte(compose), rec, nil)
			if p == nil {
				t.Fatal(why)
			}
			if tc.why != "" {
				if p.inPlace != nil || !strings.Contains(p.inPlaceWhy, tc.why) {
					t.Fatalf("plan %+v, why %q, want a refusal with %q", p.inPlace, p.inPlaceWhy, tc.why)
				}
				return
			}
			if p.inPlace == nil {
				t.Fatalf("not planned: %s", p.inPlaceWhy)
			}
			if !slices.EqualFunc(p.inPlace.pg, tc.want, func(a, b pgInPlace) bool {
				return a.service == b.service && a.user == b.user && slices.Equal(a.databases, b.databases)
			}) {
				t.Fatalf("postgres %+v, want %+v", p.inPlace.pg, tc.want)
			}
			if (p.inPlace.firebase == nil) != (tc.firebase == nil) || (tc.firebase != nil && *p.inPlace.firebase != *tc.firebase) {
				t.Fatalf("firebase %+v, want %+v", p.inPlace.firebase, tc.firebase)
			}
		})
	}
}

// The SQL that makes a golden copy refuses new connections, ends the open
// ones, templates the database with its owner and opens it again; the one
// that resets fails before dropping anything when the golden copy is missing,
// and makes the database again from the template with the golden's owner.
func TestThePostgresScriptsAreSafeAboutConnectionsAndMissingCopies(t *testing.T) {
	order := func(sql string, parts ...string) {
		t.Helper()
		at := -1
		for _, p := range parts {
			i := strings.Index(sql, p)
			if i <= at {
				t.Fatalf("%q is missing or out of order in\n%s", p, sql)
			}
			at = i
		}
	}
	order(pgGoldenSQL, "ALLOW_CONNECTIONS false", "pg_terminate_backend", `CREATE DATABASE :"g" TEMPLATE :"db"`, "ALLOW_CONNECTIONS true")
	order(pgResetSQL, "1 / count(*)", "ALLOW_CONNECTIONS false", "pg_terminate_backend", `DROP DATABASE :"db"`, `CREATE DATABASE :"db" TEMPLATE :"g" OWNER :"owner"`)
}

// inPlaceMachine is dataMachine with the in-place mode on and emulators.
func inPlaceMachine(t *testing.T, data string) (*Driver, *memDocker, driver.MachineRef) {
	t.Helper()
	d, docker, ref := dataMachineWith(t, "data: { reset: data-only"+data+" }")
	cell := dockercli.LabelFromTag(driver.TagCell)
	docker.plant(dockercli.Container{ID: "cemu", Name: ref.MachineID + "-emu", Labels: map[string]string{
		cell: "cell-1", "com.docker.compose.project": ref.MachineID, "com.docker.compose.service": "emu"}})
	rec, err := recipe.Parse([]byte("version: 1\nservices: { compose: { public: app } }\ndata: { reset: data-only" + data + " }\n"))
	if err != nil {
		t.Fatal(err)
	}
	plan, why := planDataReset([]byte(`{"services":{"app":{"image":"x","build":{}},"emu":{"image":"x","build":{}},"db":{"image":"postgres:16"}}}`), rec, nil)
	if plan == nil {
		t.Fatal(why)
	}
	d.mu.Lock()
	m := d.machineLocked(ref.MachineID)
	m.dataPlan = plan
	m.targets["emu"] = execTarget{container: "cemu"}
	d.mu.Unlock()
	return d, docker, ref
}

func (m *memDocker) inputsWith(sub string) []memInput {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []memInput
	for _, in := range m.inputs {
		if strings.Contains(in.stdin, sub) || slices.ContainsFunc(in.argv, func(a string) bool { return strings.Contains(a, sub) }) {
			out = append(out, in)
		}
	}
	return out
}

// The first boot makes the golden database before the volume copy (so the
// copy holds it too) and exports the emulators; the machine is then ready for
// the in-place mode.
func TestTheFirstBootMakesTheGoldenCopiesBeforeTheVolumeCopy(t *testing.T) {
	d, docker, ref := inPlaceMachine(t, ", in_place: { firebase: { service: emu, import_dir: /fb, project: demo-x } }")
	if err := d.takeDataCopy(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	if !d.peek(ref.MachineID).inPlaceReady {
		t.Fatal("not ready for in-place")
	}
	golden := docker.inputsWith("CREATE DATABASE :\"g\"")
	if len(golden) != 1 || golden[0].container != "cdb" || !slices.Contains(golden[0].argv, "db=postgres") || !slices.Contains(golden[0].argv, "g=postgres_kodus_golden") {
		t.Fatalf("golden %+v", golden)
	}
	export := docker.inputsWith("emulators:export")
	if len(export) != 1 || export[0].container != "cemu" || !slices.Equal(export[0].argv, []string{"firebase", "emulators:export", "/fb", "--force", "--project", "demo-x"}) {
		t.Fatalf("export %+v", export)
	}
	if want := []string{"stop db", "start db"}; !slices.Equal(docker.svcOps, want) {
		t.Fatalf("compose verbs %v, want %v", docker.svcOps, want)
	}
}

// A reset in place never stops the data service: it swaps the database from
// its golden copy, restarts only the emulators, and leaves a healthy app alone.
func TestAnInPlaceResetNeverStopsTheDataServices(t *testing.T) {
	d, docker, ref := inPlaceMachine(t, ", in_place: { firebase: { service: emu, import_dir: /fb } }")
	if err := d.takeDataCopy(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	docker.svcOps, docker.inputs = nil, nil
	got, err := d.ResetData(context.Background(), ref)
	if err != nil || got.Mode != driver.ResetModeInPlace {
		t.Fatalf("reset %+v, %v", got, err)
	}
	if want := []string{"restart emu"}; !slices.Equal(docker.svcOps, want) {
		t.Fatalf("compose verbs %v, want %v", docker.svcOps, want)
	}
	swap := docker.inputsWith(`DROP DATABASE :"db"`)
	if len(swap) != 1 || swap[0].container != "cdb" || !slices.Contains(swap[0].argv, "g=postgres_kodus_golden") {
		t.Fatalf("swap %+v", swap)
	}
}

// A swap that fails falls back to the volume restore, which does stop the
// data service, and the environment is remembered at that mode, so the next
// reset does not try the swap again.
func TestAFailedSwapFallsBackToTheVolumeRestoreAndIsRemembered(t *testing.T) {
	d, docker, ref := inPlaceMachine(t, "")
	if err := d.takeDataCopy(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	docker.svcOps, docker.inputs = nil, nil
	docker.inputFor = func(in memInput) error {
		if strings.Contains(in.stdin, `DROP DATABASE :"db"`) {
			return errors.New("no golden copy")
		}
		return nil
	}
	got, err := d.ResetData(context.Background(), ref)
	if err != nil || got.Mode != driver.ResetModeData {
		t.Fatalf("reset %+v, %v", got, err)
	}
	if want := []string{"stop db", "start db"}; !slices.Equal(docker.svcOps, want) {
		t.Fatalf("compose verbs %v, want %v", docker.svcOps, want)
	}
	// The failed script lets the app connect again.
	if len(docker.inputsWith("ALLOW_CONNECTIONS true;")) != 1 {
		t.Fatalf("the database was left closed: %+v", docker.inputs)
	}
	docker.inputs = nil
	if again, err := d.ResetData(context.Background(), ref); err != nil || again.Mode != driver.ResetModeData || len(docker.inputsWith(`DROP DATABASE :"db"`)) != 0 {
		t.Fatalf("second reset %+v, %v", again, err)
	}
}

// A golden copy that cannot be made costs the machine only the in-place mode:
// the volume copy is still taken and the reset restores from it.
func TestAGoldenCopyThatFailsLeavesTheVolumeRestore(t *testing.T) {
	d, docker, ref := inPlaceMachine(t, "")
	docker.inputFor = func(in memInput) error {
		if strings.Contains(in.stdin, `CREATE DATABASE :"g"`) {
			return errors.New("permission denied to create database")
		}
		return nil
	}
	if err := d.takeDataCopy(context.Background(), ref); err != nil {
		t.Fatalf("the boot failed: %v", err)
	}
	if m := d.peek(ref.MachineID); m.inPlaceReady || m.dataCopy == nil || m.dataOff {
		t.Fatalf("ready %v copy %+v off %v", m.inPlaceReady, m.dataCopy, m.dataOff)
	}
	docker.svcOps = nil
	got, err := d.ResetData(context.Background(), ref)
	if err != nil || got.Mode != driver.ResetModeData {
		t.Fatalf("reset %+v, %v", got, err)
	}
}
