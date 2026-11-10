package dockergvisor

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/checkoutfs"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// The recipe's boot steps (docs §6: setup, data.migrate, data.seed) run in
// the project once it is up, in this order, through the exec the agent's
// steps take: inside a service container, under runsc on the claim
// network, never on the cell host (S-10). The forms Runo runs on its VM's
// host (setup, data.migrate, a data.seed string) run in the public service
// (execService), which has the app's toolchain and reaches the other
// services by name; a data.seed mapping runs in the service it names.
//
// So a setup here is a command in the booted app, not a step before the
// build: what has to be in the image belongs in its Dockerfile. A Runo
// setup that prepares the checkout for compose (an .env, a docker network)
// does nothing a cell's boot reads.
//
// Every Up runs them again, the reset's too (agent: RunRecipe after each Up):
// a reset is down -v, so the containers and the data volumes are new, and
// only running the steps again gives every round the first boot's state.
// What a round can skip is data.seed when it is already in the data: after
// the environment's baked volumes were copied in (data.reset: snapshot; the
// bake was taken after the setup's own seed), or when the compose file binds
// the same SQL file into postgres's initdb directory, which runs it on every
// new volume as part of the database's own start (seedRunsAtInit). data.migrate still runs there, since the bake is the
// default branch's and a PR's migrations are not in it; a migration tool
// applies only what is pending. A recipe with no steps costs a round nothing.

// recipeStepTimeout bounds each setup, migrate and seed command: a build
// step may take minutes, a hung one must not hold the claim to its ceiling.
const recipeStepTimeout = 10 * time.Minute

// maxSeedBytes is the largest data.seed.sql file the cell pipes to psql.
const maxSeedBytes = 64 << 20

// seedPoll is how often a seed asks postgres whether it answers over TCP.
const seedPoll = 200 * time.Millisecond

// seedScript waits for postgres to answer on 127.0.0.1 (during initdb the
// image's temporary server listens on its socket only, then restarts),
// then pipes its input to psql. $1 user, $2 database, $3 polls: positional
// parameters, never spliced into the script. 127.0.0.1 is trusted by the
// postgres images' pg_hba, as for local-docker's seed.
const seedScript = `n=0; until pg_isready -q -h 127.0.0.1 -U "$1" -d "$2"; do n=$((n+1)); if [ "$n" -ge "$3" ]; then echo "postgres never answered on 127.0.0.1" >&2; exit 3; fi; sleep 0.2; done; exec psql -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$1" -d "$2"`

// RunRecipe runs the recipe's setup, data.migrate and data.seed in the
// project the machine's last Up brought up, in the containers that Up found
// (each carried this cell's label then). Each command's output goes to the
// boot's output (claim.progress) and its time to the boot's seed phase. A
// failed step is a driver.RecipeStepError naming it.
func (d *Driver) RunRecipe(ctx context.Context, ref driver.MachineRef, projectDir string) error {
	rec, err := recipe.Load(projectDir)
	if err != nil {
		return driver.WorkloadRecipeRefused(fmt.Errorf("dockergvisor: %w", err))
	}
	if rec == nil || !rec.HasBootSteps() {
		return nil
	}
	m := d.peek(ref.MachineID)
	start := d.clock.Now()
	var setupMs, migrateMs, seedMs int64
	for i, c := range rec.Setup {
		at := d.clock.Now()
		if err := d.runStep(ctx, m.exec, "setup", fmt.Sprintf("setup[%d]", i), c); err != nil {
			return err
		}
		setupMs += d.clock.Now().Sub(at).Milliseconds()
	}
	if rec.Data.Migrate != "" {
		at := d.clock.Now()
		if err := d.runStep(ctx, m.exec, "migrate", "data.migrate", rec.Data.Migrate); err != nil {
			return err
		}
		migrateMs = d.clock.Now().Sub(at).Milliseconds()
	}
	seeded := false
	if s := rec.Data.Seed; !s.IsZero() && !m.restoredData && !m.seedAtInit && !m.seedInData {
		at := d.clock.Now()
		if err := d.seed(ctx, m, projectDir, rec); err != nil {
			return err
		}
		seedMs, seeded = d.clock.Now().Sub(at).Milliseconds(), true
	}
	now := d.clock.Now()
	d.mu.Lock()
	if b := d.machineLocked(ref.MachineID).boot; b != nil {
		// The data getting ready is the seed phase; the boot ends here.
		b.timing.SeedMs += now.Sub(start).Milliseconds()
		b.timing.TotalMs = now.Sub(b.timing.At).Milliseconds()
	}
	d.mu.Unlock()
	d.log().Info("recipe.steps", "machine", ref.MachineID, "setup", len(rec.Setup), "setupMs", setupMs, "migrateMs", migrateMs,
		"seedMs", seedMs, "seeded", seeded, "seedFromBake", !rec.Data.Seed.IsZero() && m.restoredData, "seedAtInit", m.seedAtInit, "seedInData", m.seedInData)
	return nil
}

func (d *Driver) seed(ctx context.Context, m machineState, projectDir string, rec *recipe.Recipe) error {
	s := rec.Data.Seed
	if s.Service == "" {
		return d.runStep(ctx, m.exec, "seed", "data.seed", s.Command)
	}
	at, ok := m.targets[s.Service]
	if !ok {
		return &driver.RecipeStepError{Step: "seed", Field: "data.seed", Err: fmt.Errorf("service %q is not in the compose project", s.Service)}
	}
	if s.Command != "" {
		return d.runStep(ctx, &at, "seed", "data.seed", s.Command)
	}
	sql, err := checkoutfs.Read(projectDir, s.SQL, maxSeedBytes)
	if err != nil {
		return &driver.RecipeStepError{Step: "seed", Field: "data.seed.sql", Err: err}
	}
	user, db := s.User, s.Database
	if user == "" {
		user = "postgres"
	}
	if db == "" {
		db = user
	}
	wait := rec.HealthTimeout()
	polls := max(int(wait/seedPoll), 1)
	sctx, cancel := context.WithTimeout(ctx, wait+recipeStepTimeout)
	defer cancel()
	say(ctx, "$ data.seed: "+s.SQL+" into "+s.Service)
	if _, err := d.d.ExecInput(sctx, at.container, sql, "/bin/sh", "-c", seedScript, "kodus-seed", user, db, strconv.Itoa(polls)); err != nil {
		return &driver.RecipeStepError{Step: "seed", Field: "data.seed", Err: err}
	}
	return nil
}

// runStep runs one recipe command in at and gives its output to the boot.
func (d *Driver) runStep(ctx context.Context, at *execTarget, step, field, command string) error {
	if at == nil {
		return &driver.RecipeStepError{Step: step, Field: field, Err: ErrNoExecService}
	}
	say(ctx, "$ "+field+": "+command)
	res := d.execIn(ctx, *at, kodyexec.Request{Command: command, TimeoutMs: recipeStepTimeout.Milliseconds()})
	for _, out := range []string{res.Stdout, res.Stderr} {
		for _, l := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
			if l != "" {
				say(ctx, l)
			}
		}
	}
	switch {
	case res.TimedOut:
		return &driver.RecipeStepError{Step: step, Field: field, Err: fmt.Errorf("%q ran past %s", command, recipeStepTimeout)}
	case res.ExitCode != 0:
		return &driver.RecipeStepError{Step: step, Field: field, Err: fmt.Errorf("%q exited %d: %s", command, res.ExitCode, lastLines(res.Stderr, res.Stdout))}
	}
	return nil
}

// say gives a line to the boot's output, when the caller asked for it.
func say(ctx context.Context, line string) {
	if sink := driver.OutputFrom(ctx); sink != nil {
		sink(line)
	}
}

// lastLines is the end of what a failed command printed, stderr first: what
// the blocker shows. The agent redacts and clips the reason.
func lastLines(stderr, stdout string) string {
	out := strings.TrimSpace(stderr)
	if out == "" {
		out = strings.TrimSpace(stdout)
	}
	if len(out) > 1000 {
		out = "..." + out[len(out)-1000:]
	}
	if out == "" {
		return "no output"
	}
	return out
}

// initdbDir is where the postgres images run *.sql files on a new data
// directory, before the server first answers over TCP.
const initdbDir = "/docker-entrypoint-initdb.d"

// seedRunsAtInit: the compose project already binds the recipe's
// data.seed.sql into its seed service's initdb directory (the file itself,
// or a directory holding it), as the sample app does for local-docker and
// plain compose. Postgres then runs it in its own init, before its
// healthcheck passes and before the app starts, on every new data volume:
// on the first boot and after every reset's down -v. Piping it to psql
// again would only repeat it each round. canonical is compose config's JSON
// (binds with absolute sources).
func seedRunsAtInit(canonical []byte, projectDir string, rec *recipe.Recipe) bool {
	if rec == nil || rec.Data.Seed.SQL == "" {
		return false
	}
	var doc struct {
		Services map[string]struct {
			Volumes []struct {
				Type   string `json:"type"`
				Source string `json:"source"`
				Target string `json:"target"`
			} `json:"volumes"`
		} `json:"services"`
	}
	if json.Unmarshal(canonical, &doc) != nil {
		return false
	}
	file := filepath.Join(projectDir, rec.Data.Seed.SQL)
	for _, v := range doc.Services[rec.Data.Seed.Service].Volumes {
		if v.Type != "bind" {
			continue
		}
		src, target := filepath.Clean(v.Source), path.Clean(v.Target)
		if (src == file && path.Dir(target) == initdbDir && strings.HasSuffix(target, ".sql")) ||
			(target == initdbDir && filepath.Dir(file) == src && strings.HasSuffix(file, ".sql")) {
			return true
		}
	}
	return false
}

// warnUnapplied logs, once per boot, the recipe keys this cell boots as if
// they were absent (the product says so on the setup, from its own parse).
func warnUnapplied(log *slog.Logger, machine string, rec *recipe.Recipe) {
	if rec == nil {
		return
	}
	if keys := rec.Unapplied(); len(keys) > 0 {
		log.Warn("recipe.unapplied", "machine", machine, "keys", strings.Join(keys, ","))
	}
}
