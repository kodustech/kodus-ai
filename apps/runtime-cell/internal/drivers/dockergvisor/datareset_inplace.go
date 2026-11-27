package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// The in-place paths of a data-only reset (docs/runtime/persistent-state.md
// section 11). They run before the volume restore and never stop the data
// services, which is most of what a volume restore costs:
//
//   - Postgres: after the first seeded boot, each database the app uses gets a
//     golden template, <db>_kodus_golden. A reset closes the app's
//     connections, drops <db> and makes it again from the template.
//   - Firebase emulators, when the recipe declares them (data.in_place.
//     firebase): exported after the seed into the directory the service's
//     command imports, and restarted on a reset so they read it again.
//
// A mode only covers a machine whose every data service it covers: a project
// with a Postgres and a Redis keeps the volume restore, which restores both.
// Whatever fails falls back to that restore (the golden databases are in the
// copied volumes, so a recreate does not lose them), then to restart-app, then
// to recreate.

// goldenSuffix names the template of a database.
const goldenSuffix = "_kodus_golden"

// inPlacePlan is what the in-place mode acts on.
type inPlacePlan struct {
	pg       []pgInPlace
	firebase *firebaseInPlace
}

type pgInPlace struct {
	service, user string
	databases     []string
}

type firebaseInPlace struct{ service, importDir, project string }

// planInPlace says what the in-place mode covers, or why it cannot be used.
// Postgres is found by image (the plan's pgUser) or by the recipe's hint; the
// database is the hint's, else the seed's, else POSTGRES_DB, else the user's
// (the image's own default).
func planInPlace(rec *recipe.Recipe, services map[string]canonicalService, p *dataResetPlan) (*inPlacePlan, string) {
	hint := rec.Data.InPlace
	if hint.Off {
		return nil, "data.in_place.off"
	}
	hints := map[string][]string{}
	for _, h := range hint.Postgres {
		if !slices.Contains(p.services, h.Service) {
			return nil, "data.in_place.postgres names " + h.Service + ", which is not a data service"
		}
		hints[h.Service] = h.Databases
	}
	plan := &inPlacePlan{}
	for _, svc := range p.services {
		user, ok := p.pgUser[svc]
		if !ok {
			return nil, "the data service " + svc + " is not Postgres, so only the volume restore covers it"
		}
		dbs := hints[svc]
		if len(dbs) == 0 && rec.Data.Seed.Service == svc && rec.Data.Seed.Database != "" {
			dbs = []string{rec.Data.Seed.Database}
		}
		if len(dbs) == 0 {
			if v := services[svc].Environment["POSTGRES_DB"]; v != nil && *v != "" {
				dbs = []string{*v}
			} else {
				dbs = []string{user}
			}
		}
		for _, db := range dbs {
			if len(db)+len(goldenSuffix) > 63 {
				return nil, "the database " + db + " has a name too long for its golden copy"
			}
		}
		plan.pg = append(plan.pg, pgInPlace{service: svc, user: user, databases: dbs})
	}
	if f := hint.Firebase; f != nil {
		if _, ok := services[f.Service]; !ok {
			return nil, "data.in_place.firebase names " + f.Service + ", not a service of the project"
		}
		plan.firebase = &firebaseInPlace{service: f.Service, importDir: f.ImportDir, project: f.Project}
	}
	return plan, ""
}

// pgGoldenSQL makes <db>_kodus_golden from <db>: new connections to <db> are
// refused, the open ones ended (a template copy needs none), the copy made
// with the owner of <db>, and <db> opens again. psql variables db and g.
const pgGoldenSQL = `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = :'db' \gset
ALTER DATABASE :"db" ALLOW_CONNECTIONS false;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'db' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS :"g" WITH (FORCE);
CREATE DATABASE :"g" TEMPLATE :"db" OWNER :"owner" ALLOW_CONNECTIONS false;
ALTER DATABASE :"db" ALLOW_CONNECTIONS true;
`

// pgResetSQL gives <db> back what its golden copy holds. The first statement
// fails, before anything is dropped, when there is no golden copy (a division
// by zero is how a psql script stops on a missing row). New connections are
// refused while the old ones are ended, and the database made again from the
// template is the app's, with the golden copy's owner.
const pgResetSQL = `SELECT 1 / count(*) FROM pg_database WHERE datname = :'g';
SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = :'g' \gset
ALTER DATABASE :"db" ALLOW_CONNECTIONS false;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'db' AND pid <> pg_backend_pid();
DROP DATABASE :"db" WITH (FORCE);
CREATE DATABASE :"db" TEMPLATE :"g" OWNER :"owner";
`

func (o *dockerDataOps) inPlace() bool { return o.golden && o.plan.inPlace != nil }

// psql runs sql against the maintenance database of a Postgres service.
func (o *dockerDataOps) psql(ctx context.Context, pg pgInPlace, db, sql string) error {
	pctx, cancel := context.WithTimeout(ctx, o.plan.wait)
	defer cancel()
	_, err := o.d.d.ExecInput(pctx, o.targets[pg.service].container, []byte(sql),
		"psql", "-qtAX", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", pg.user, "-d", "postgres",
		"-v", "db="+db, "-v", "g="+db+goldenSuffix)
	return err
}

// reopen lets the app connect to db again after a script that stopped half
// way, best effort: the caller already has an error to report.
func (o *dockerDataOps) reopen(ctx context.Context, pg pgInPlace, db string) {
	_ = o.psql(context.WithoutCancel(ctx), pg, db, `ALTER DATABASE :"db" ALLOW_CONNECTIONS true;`+"\n")
}

// makeGolden is the first boot's half of the in-place mode: the golden
// databases, then the emulators' export.
func (o *dockerDataOps) makeGolden(ctx context.Context) error {
	ip := o.plan.inPlace
	for _, pg := range ip.pg {
		for _, db := range pg.databases {
			if err := o.psql(ctx, pg, db, pgGoldenSQL); err != nil {
				o.reopen(ctx, pg, db)
				return fmt.Errorf("golden %s: %w", db, err)
			}
		}
	}
	if f := ip.firebase; f != nil {
		argv := []string{"firebase", "emulators:export", f.importDir, "--force"}
		if f.project != "" {
			argv = append(argv, "--project", f.project)
		}
		pctx, cancel := context.WithTimeout(ctx, o.plan.wait)
		defer cancel()
		if _, err := o.d.d.ExecInput(pctx, o.targets[f.service].container, nil, argv...); err != nil {
			return fmt.Errorf("export %s: %w", f.service, err)
		}
	}
	return nil
}

func (o *dockerDataOps) swapPostgres(ctx context.Context) error {
	for _, pg := range o.plan.inPlace.pg {
		for _, db := range pg.databases {
			if err := o.psql(ctx, pg, db, pgResetSQL); err != nil {
				o.reopen(ctx, pg, db)
				return fmt.Errorf("reset %s: %w", db, err)
			}
		}
	}
	return nil
}

// reimportFirebase restarts the emulators, whose command imports the export,
// and waits until they run.
func (o *dockerDataOps) reimportFirebase(ctx context.Context) error {
	f := o.plan.inPlace.firebase
	if f == nil {
		return nil
	}
	if err := o.d.d.ComposeRestartServices(ctx, o.project, f.service); err != nil {
		return fmt.Errorf("restart %s: %w", f.service, err)
	}
	return o.await(ctx, []string{f.service})
}

// takeInPlaceGolden is takeDataCopy's first step: true when the in-place
// mode is ready. A failure only costs the machine that mode, never the boot.
func (d *Driver) takeInPlaceGolden(ctx context.Context, ref driver.MachineRef, ops *dockerDataOps) bool {
	m := d.peek(ref.MachineID)
	if m.dataPlan == nil || m.dataPlan.inPlace == nil {
		if m.dataPlan != nil {
			d.log().Info("data.inplace.off", "machine", ref.MachineID, "reason", m.dataPlan.inPlaceWhy)
		}
		return false
	}
	at := d.clock.Now()
	if err := ops.makeGolden(ctx); err != nil {
		d.log().Warn("data.inplace.off", "machine", ref.MachineID, "reason", errors.Join(err).Error())
		return false
	}
	d.log().Info("data.inplace.taken", "machine", ref.MachineID, "ms", d.clock.Now().Sub(at).Milliseconds())
	return true
}
