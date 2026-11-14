package dockergvisor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

const stepsRecipe = `version: 1
setup: [make assets, echo ready]
services:
  compose: { files: [docker-compose.yml], public: app }
data:
  migrate: npm run migrate
  seed: { service: db, sql: db/seed.sql, user: shop, database: shop }
`

// stepsDriver is a driver whose machine is up with app (the public service,
// in /app) and db, as Up leaves it, on a fake clock each exec moves by 1 s.
func stepsDriver(t *testing.T, recipeText string) (*Driver, *memDocker, driver.MachineRef, string, *clock.Fake) {
	t.Helper()
	d, docker := withEgress(t)
	clk := clock.NewFake(time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC))
	d.clock = clk
	docker.execFor = func(memExec) kodyexec.Result {
		clk.Advance(time.Second)
		return kodyexec.Result{Stdout: "did it\n"}
	}
	dir := t.TempDir()
	if recipeText != "" {
		writeFile(t, filepath.Join(dir, recipe.Path), recipeText)
	}
	writeFile(t, filepath.Join(dir, "db", "seed.sql"), "INSERT INTO orders VALUES (1);\n")
	ref := machine("claim-1", "env")
	app, db := execTarget{container: "capp", dir: "/app"}, execTarget{container: "cdb", dir: "/"}
	m := d.machineLocked(ref.MachineID)
	m.exec, m.targets = &app, map[string]execTarget{"app": app, "db": db}
	m.boot = &claimBoot{claim: "claim-1", timing: driver.BootTiming{Kind: "boot", At: clk.Now().Add(-10 * time.Second), TotalMs: 10_000, SeedMs: 500}}
	return d, docker, ref, dir, clk
}

func commands(docker *memDocker) []string {
	var out []string
	for _, e := range docker.execs {
		out = append(out, e.spec.Container+":"+e.spec.Dir+" "+e.req.Command)
	}
	return out
}

// setup, then data.migrate in the public service, then the SQL seed piped
// into the db service; each command's output goes to the boot's output, and
// their time to its seed phase.
func TestRecipeStepsRunInOrderWhereTheRecipeSays(t *testing.T) {
	d, docker, ref, dir, _ := stepsDriver(t, stepsRecipe)
	var lines []string
	ctx := driver.WithOutput(context.Background(), func(l string) { lines = append(lines, l) })
	if err := d.RunRecipe(ctx, ref, dir); err != nil {
		t.Fatal(err)
	}
	if got, want := commands(docker), []string{"capp:/app make assets", "capp:/app echo ready", "capp:/app npm run migrate"}; !slices.Equal(got, want) {
		t.Fatalf("ran %q, want %q", got, want)
	}
	for _, e := range docker.execs {
		if e.req.TimeoutMs != recipeStepTimeout.Milliseconds() || e.host.TimeoutMs != e.req.TimeoutMs+execGrace {
			t.Fatalf("a step without its timeout: %+v", e)
		}
	}
	if len(docker.inputs) != 1 {
		t.Fatalf("seeds %+v", docker.inputs)
	}
	in := docker.inputs[0]
	// 120 s (the default health timeout) of polls every 200 ms.
	if in.container != "cdb" || in.stdin != "INSERT INTO orders VALUES (1);\n" || !slices.Equal(in.argv[3:], []string{"kodus-seed", "shop", "shop", "600"}) || in.argv[2] != seedScript {
		t.Fatalf("seed ran as %+v", in)
	}
	for _, want := range []string{"$ setup[0]: make assets", "did it", "$ data.migrate: npm run migrate", "$ data.seed: db/seed.sql into db"} {
		if !slices.Contains(lines, want) {
			t.Errorf("boot output %q has no %q", lines, want)
		}
	}
	tm, _ := d.BootTiming("claim-1")
	if tm.SeedMs != 3500 || tm.TotalMs != 13_000 {
		t.Fatalf("timing %+v: the steps' 3 s are not in the seed phase and the total", tm)
	}
}

// The other seed forms: a command in the service it names, a string in the
// public service.
func TestASeedCommandRunsInItsServiceAndAStringInThePublicOne(t *testing.T) {
	for seed, want := range map[string]string{
		"{ service: db, command: ./seed.sh }": "cdb:/ ./seed.sh",
		"npm run seed":                        "capp:/app npm run seed",
	} {
		d, docker, ref, dir, _ := stepsDriver(t, "version: 1\nservices: { compose: { public: app } }\ndata: { seed: "+seed+" }\n")
		if err := d.RunRecipe(context.Background(), ref, dir); err != nil {
			t.Fatal(err)
		}
		if got := commands(docker); !slices.Equal(got, []string{want}) || len(docker.inputs) != 0 {
			t.Errorf("seed %s ran %q", seed, got)
		}
	}
}

// After the environment's baked volumes were copied in (data.reset:
// snapshot) the seed is in them: it does not run again, the migrations do
// (the bake is the default branch's; a PR's migrations are not in it).
func TestAClaimOnTheBakedDataMigratesButDoesNotSeedAgain(t *testing.T) {
	d, docker, ref, dir, _ := stepsDriver(t, stepsRecipe)
	d.machineLocked(ref.MachineID).restoredData = true
	if err := d.RunRecipe(context.Background(), ref, dir); err != nil {
		t.Fatal(err)
	}
	if got := commands(docker); !slices.Contains(got, "capp:/app npm run migrate") || len(docker.inputs) != 0 {
		t.Fatalf("on baked data ran %q and seeded %d times", got, len(docker.inputs))
	}
}

// A failed step stops the boot there, as the repository's failure, named.
func TestAFailedRecipeStepIsTheRepositorysNamedFailure(t *testing.T) {
	d, docker, ref, dir, _ := stepsDriver(t, stepsRecipe)
	docker.execFor = func(e memExec) kodyexec.Result {
		if e.req.Command == "echo ready" {
			return kodyexec.Result{ExitCode: 2, Stderr: "make: *** no rule\n"}
		}
		return kodyexec.Result{}
	}
	err := d.RunRecipe(context.Background(), ref, dir)
	var step *driver.RecipeStepError
	if !errors.As(err, &step) || step.Step != "setup" || step.Field != "setup[1]" || !errors.Is(err, driver.ErrWorkloadBoot) || !strings.Contains(err.Error(), "no rule") {
		t.Fatalf("err %v", err)
	}
	if len(docker.execs) != 2 || len(docker.inputs) != 0 {
		t.Fatalf("steps after the failed one ran: %q", commands(docker))
	}

	d, docker, ref, dir, _ = stepsDriver(t, stepsRecipe)
	docker.execFor = func(e memExec) kodyexec.Result {
		if e.req.Command == "npm run migrate" {
			return kodyexec.Result{ExitCode: 137, DurationMs: e.req.TimeoutMs}
		}
		return kodyexec.Result{}
	}
	if err := d.RunRecipe(context.Background(), ref, dir); !errors.As(err, &step) || step.Step != "migrate" || !strings.Contains(err.Error(), "ran past") {
		t.Fatalf("a migrate killed at its deadline: %v", err)
	}

	d, docker, ref, dir, _ = stepsDriver(t, stepsRecipe)
	docker.inputErr = errors.New("psql: ERROR: relation \"orders\" does not exist")
	if err := d.RunRecipe(context.Background(), ref, dir); !errors.As(err, &step) || step.Step != "seed" || !strings.Contains(err.Error(), "orders") {
		t.Fatalf("a failed seed: %v", err)
	}
}

// With no service to run in, or a seed naming one the project lacks, the
// boot fails saying so instead of skipping the step.
func TestAStepWithNowhereToRunFailsInsteadOfBeingSkipped(t *testing.T) {
	d, _, ref, dir, _ := stepsDriver(t, stepsRecipe)
	d.machineLocked(ref.MachineID).exec = nil
	if err := d.RunRecipe(context.Background(), ref, dir); !errors.Is(err, ErrNoExecService) {
		t.Fatalf("setup with no public service: %v", err)
	}
	d, _, ref, dir, _ = stepsDriver(t, "version: 1\ndata: { seed: { service: postgres, sql: db/seed.sql } }\n")
	if err := d.RunRecipe(context.Background(), ref, dir); err == nil || !strings.Contains(err.Error(), `"postgres" is not in the compose project`) {
		t.Fatalf("a seed into a missing service: %v", err)
	}
}

// The seed file is read inside the checkout only: a symlink the PR planted
// to a file of the cell's never reaches its database.
func TestASeedFilePlantedAsASymlinkIsNotRead(t *testing.T) {
	d, docker, ref, dir, _ := stepsDriver(t, stepsRecipe)
	outside := filepath.Join(t.TempDir(), "cell-secret")
	writeFile(t, outside, "the cell's")
	_ = os.Remove(filepath.Join(dir, "db", "seed.sql"))
	if err := os.Symlink(outside, filepath.Join(dir, "db", "seed.sql")); err != nil {
		t.Fatal(err)
	}
	if err := d.RunRecipe(context.Background(), ref, dir); err == nil || len(docker.inputs) != 0 {
		t.Fatalf("seeded through a planted symlink: %v %+v", err, docker.inputs)
	}
}

// A recipe without steps, or no recipe, runs nothing and costs a round nothing.
func TestNoStepsRunNothing(t *testing.T) {
	for _, text := range []string{"", "version: 1\nservices: { compose: { public: app } }\ndata: { reset: snapshot }\n"} {
		d, docker, ref, dir, _ := stepsDriver(t, text)
		if err := d.RunRecipe(context.Background(), ref, dir); err != nil || len(docker.execs) != 0 || len(docker.inputs) != 0 {
			t.Fatalf("%q: %v, ran %q", text, err, commands(docker))
		}
	}
}

// Through the real docker argv: Up finds the containers, RunRecipe runs
// the migration in the public one (sandboxed, under timeout) and pipes the
// seed into the db one with docker exec -i, the file as its input.
func TestUpThenRecipeStepsThroughTheDockerCLI(t *testing.T) {
	r := &recorder{answers: map[string]string{"info": `{"runsc":{}}`, "run": "c0ffee\n", "inspect": holderJSON, "network subnet": "10.213.5.0/24 \n", "version": "1.52\n"}}
	var execs [][]string
	run := func(ctx context.Context, stdin []byte, bin string, args ...string) ([]byte, error) {
		if strings.Contains(strings.Join(args, " "), " up ") {
			now := time.Now()
			r.answers["inspect"] = containersJSON(now, now)
		}
		return r.run(ctx, stdin, bin, args...)
	}
	cli := dockercli.CLI{Run: run, ExecRun: func(_ context.Context, args []string, _ kodyexec.Request) kodyexec.Result {
		execs = append(execs, args)
		return kodyexec.Result{}
	}}
	d, err := New(context.Background(), cli, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	ref, err := d.Create(context.Background(), spec())
	if err != nil {
		t.Fatal(err)
	}
	ref.Tags[driver.TagOrg], ref.Tags[driver.TagRole] = "", ""
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, recipe.Path), "version: 1\nservices: { compose: { public: app } }\ndata:\n  migrate: npm run migrate\n  seed: { service: db, sql: seed.sql, user: shop }\n")
	writeFile(t, filepath.Join(dir, "seed.sql"), "SELECT 1;\n")
	r.answers["compose config"] = canonicalDBAndApp()
	r.answers["ps"] = "s1\ns2\n"
	if _, err := d.Up(context.Background(), ref, []byte(dbAndApp), dir); err != nil {
		t.Fatal(err)
	}
	if err := d.RunRecipe(context.Background(), ref, dir); err != nil {
		t.Fatal(err)
	}
	if len(execs) != 1 || !slices.Contains(execs[0], "s2") || execs[0][len(execs[0])-1] != "npm run migrate" {
		t.Fatalf("the migration ran as %q", execs)
	}
	var seed call
	for _, c := range r.calls {
		if len(c.args) > 2 && c.args[0] == "exec" && c.args[1] == "-i" {
			seed = c
		}
	}
	if strings.Join(seed.args[:3], " ") != "exec -i s1" || string(seed.stdin) != "SELECT 1;\n" || !slices.Equal(seed.args[len(seed.args)-3:len(seed.args)-1], []string{"shop", "shop"}) {
		t.Fatalf("the seed ran as %q with %q", seed.args, seed.stdin)
	}
}

// A compose file that binds the recipe's seed file into postgres's initdb
// directory (the sample app, for plain compose) seeds every new volume in
// the database's own start: the recipe's seed is not piped in again.
func TestASeedTheDatabaseRunsAtItsInitIsNotRepeated(t *testing.T) {
	rec, err := recipe.Parse([]byte("version: 1\ndata: { seed: { service: db, sql: db/seed.sql } }\n"))
	if err != nil {
		t.Fatal(err)
	}
	canonical := func(svc, typ, source, target string) []byte {
		return []byte(`{"services":{"` + svc + `":{"volumes":[{"type":"` + typ + `","source":"` + source + `","target":"` + target + `","read_only":true}]}}}`)
	}
	for name, tc := range map[string]struct {
		doc  []byte
		want bool
	}{
		"the file":             {canonical("db", "bind", "/w/app/db/seed.sql", "/docker-entrypoint-initdb.d/seed.sql"), true},
		"its directory":        {canonical("db", "bind", "/w/app/db", "/docker-entrypoint-initdb.d"), true},
		"another file":         {canonical("db", "bind", "/w/app/db/other.sql", "/docker-entrypoint-initdb.d/other.sql"), false},
		"elsewhere in the db":  {canonical("db", "bind", "/w/app/db/seed.sql", "/seed.sql"), false},
		"in another service":   {canonical("app", "bind", "/w/app/db/seed.sql", "/docker-entrypoint-initdb.d/seed.sql"), false},
		"a volume, not a bind": {canonical("db", "volume", "pgdata", "/docker-entrypoint-initdb.d"), false},
	} {
		if got := seedRunsAtInit(tc.doc, "/w/app", rec); got != tc.want {
			t.Errorf("%s: %v, want %v", name, got, tc.want)
		}
	}
	d, docker, ref, dir, _ := stepsDriver(t, stepsRecipe)
	d.machineLocked(ref.MachineID).seedAtInit = true
	if err := d.RunRecipe(context.Background(), ref, dir); err != nil || len(docker.inputs) != 0 || !slices.Contains(commands(docker), "capp:/app npm run migrate") {
		t.Fatalf("seeded again at init: %v %+v", err, docker.inputs)
	}
}
