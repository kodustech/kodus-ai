package dockergvisor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// Golden data (data.reset: recreate, the default). A reset is down -v and
// up, so every round used to initialize its database from nothing: initdb,
// the initdb scripts, the recipe's SQL seed, ~4–6 s of every reset under
// runsc. When the data a round starts from is made by the database alone,
// before the app ever runs, the machine's first boot keeps a copy of it
// (the golden volumes), and each reset gives the database a fresh copy of
// that instead of an empty volume. The containers are still new every
// round (the app process too); only the database's files start where the
// first boot's did, byte for byte.
//
// When it applies, all of it checked from the recipe and from what compose
// will run (planGolden); anything else keeps the reset as it was:
//
//   - data.reset is recreate (snapshot has its own path, reseed its own
//     meaning), and the recipe has no setup and no data.migrate. Both run
//     in the app's container, so the app is already up against the data
//     when they run: a copy taken after them would hold whatever the app
//     wrote at its start, and the next round's start would write it again.
//     (A copy taken after the machine's own migrate would hold the right
//     schema, the checkout being fixed for the claim, but not the app's
//     start.) A migrate the recipe runs keeps today's down -v.
//   - data.seed is absent, runs at init (the compose file binds the same
//     SQL file into postgres's initdb directory), or is a SQL file into a
//     postgres service: then the first boot runs it before the app starts,
//     and the copy holds it. A seed command (in the app or in a service)
//     keeps today's path: what it writes and where it lands is unknown.
//   - The copied services are postgres ones: the seed's service, and any
//     service whose image is postgres or a postgres image (pgvector,
//     postgis, timescaledb). Their data directory, as the server itself
//     reports it, must be inside one of their volumes. Other databases
//     (mysql, mariadb, mongo, redis) keep today's path: their volumes are
//     new each round, as they were on the first boot (nothing writes them
//     before the app does), and no cheap check here says their init is over.
//   - What a copied service depends on is a database too, never the app
//     (the first boot starts the copied services alone).
//   - The copy is taken once the server answers over TCP: the postgres
//     images run initdb's scripts on a server that listens on its socket
//     only, so the image's own healthcheck may pass before init is done.
//   - Its inputs are fixed: the compose file, the recipe, the seed file and
//     every file bound into a copied service are hashed with it, and a reset
//     whose inputs hash otherwise drops the copy and recreates as before.
//
// A copy failing (to take or to restore) costs that machine the fast path,
// never a round: the Up goes on as it would have without it.

const (
	// labelGoldenOf names the machine a golden volume is the copy of;
	// labelGoldenKey the project volume it goes back into. Compose does not
	// label it, so a reset's down -v never takes it; Destroy, the sweep and
	// the reaper do (removeGolden).
	labelGoldenOf  = "kodus.golden-of"
	labelGoldenKey = "kodus.golden-key"
	// goldenKeyPrefix starts the project volume key the cell mounts where
	// the image's data was an anonymous volume.
	goldenKeyPrefix = "kodus-golden-"
	// maxGoldenInputBytes bounds the files hashed into a copy's inputs.
	maxGoldenInputBytes = 64 << 20
)

// postgresImages are the images (last path component of the repository)
// whose server is postgres.
var postgresImages = map[string]bool{"postgres": true, "postgresql": true, "postgis": true, "pgvector": true, "timescaledb": true, "timescaledb-ha": true}

// databaseImages are the other known databases: a copied service may
// depend on one, and nothing of theirs is copied.
var databaseImages = map[string]bool{"mysql": true, "mariadb": true, "mongo": true, "redis": true}

// imageName is the last path component of an image reference, without its
// tag or digest: "pgvector/pgvector:pg16" is "pgvector".
func imageName(ref string) string {
	ref, _, _ = strings.Cut(ref, "@")
	if i := strings.LastIndex(ref, "/"); i >= 0 {
		ref = ref[i+1:]
	}
	ref, _, _ = strings.Cut(ref, ":")
	return strings.ToLower(ref)
}

// golden is a machine's copy of its first boot's data.
type golden struct {
	// sum is what the inputs hashed to when it was taken (planGolden).
	sum  string
	vols []goldenVolume
	// seeded: the copy holds the recipe's data.seed.
	seeded bool
}

type goldenVolume struct {
	service, target string
	// key is the project volume it goes back into; injected when the cell
	// mounts it (the image's anonymous volume), declared in the file when not.
	key      string
	injected bool
	name     string // the golden volume
}

// dataVolumes are the mounts a reset's compose file needs (Options.DataVolumes).
func (g *golden) dataVolumes() map[string]map[string]string {
	out := map[string]map[string]string{}
	for _, v := range g.vols {
		if !v.injected {
			continue
		}
		if out[v.service] == nil {
			out[v.service] = map[string]string{}
		}
		out[v.service][v.target] = v.key
	}
	return out
}

// goldenPlan is what a first boot copies: planGolden.
type goldenPlan struct {
	services []string
	// user is each service's superuser (POSTGRES_USER), who asks the
	// server where its data is.
	user map[string]string
	// named are the volumes the file itself mounts on each service, by target.
	named map[string]map[string]string
	// seed: data.seed.sql runs before the app, into the seed's service.
	seed bool
	sum  string
}

type canonicalService struct {
	Image       string             `json:"image"`
	Environment map[string]*string `json:"environment"`
	DependsOn   map[string]any     `json:"depends_on"`
	Volumes     []struct {
		Type   string `json:"type"`
		Source string `json:"source"`
		Target string `json:"target"`
	} `json:"volumes"`
}

// planGolden says what the machine's first boot can copy for its resets,
// or why nothing (see the top of this file). canonical is compose config's
// JSON of the file the cell runs; composeFile the file the agent gave Up;
// own the volumes the cell mounted in it (Options.DataVolumes), which are
// not the file's.
func planGolden(canonical, composeFile []byte, projectDir string, rec *recipe.Recipe, seedAtInit bool, own map[string]map[string]string) (*goldenPlan, string) {
	ownKeys := map[string]bool{}
	for _, mounts := range own {
		for _, k := range mounts {
			ownKeys[k] = true
		}
	}
	seed := recipe.Seed{}
	if rec != nil {
		switch {
		case rec.ResetStrategy() != recipe.ResetRecreate:
			return nil, "data.reset " + rec.ResetStrategy()
		case len(rec.Setup) > 0:
			return nil, "setup runs in the app"
		case rec.Data.Migrate != "":
			return nil, "data.migrate runs in the app"
		}
		seed = rec.Data.Seed
	}
	preAppSeed := false
	if !seed.IsZero() && !seedAtInit {
		if seed.Service == "" || seed.SQL == "" {
			return nil, "data.seed is a command"
		}
		preAppSeed = true
	}
	var doc struct {
		Services map[string]canonicalService `json:"services"`
		Volumes  map[string]any              `json:"volumes"`
	}
	if err := json.Unmarshal(canonical, &doc); err != nil {
		return nil, "compose config: " + err.Error()
	}
	for k := range doc.Volumes {
		if strings.HasPrefix(k, goldenKeyPrefix) && !ownKeys[k] {
			return nil, "the file declares a volume " + k
		}
	}
	copied := map[string]bool{}
	for name, s := range doc.Services {
		if postgresImages[imageName(s.Image)] {
			copied[name] = true
		}
	}
	if !seed.IsZero() {
		if _, ok := doc.Services[seed.Service]; !ok {
			return nil, "data.seed names no service of the project"
		}
		copied[seed.Service] = true
	}
	if len(copied) == 0 {
		return nil, "no postgres service"
	}
	if rec != nil {
		for _, p := range rec.Services.Compose.Public {
			if copied[p] {
				return nil, "the public service " + p + " is a database"
			}
		}
	}
	// Up of the copied services starts what they depend on: databases only.
	seen := map[string]bool{}
	queue := sortedSet(copied)
	for len(queue) > 0 {
		name := queue[0]
		queue = queue[1:]
		if seen[name] {
			continue
		}
		seen[name] = true
		s, ok := doc.Services[name]
		if !ok {
			return nil, "depends on " + name + ", not a service"
		}
		if !copied[name] && !databaseImages[imageName(s.Image)] && !postgresImages[imageName(s.Image)] {
			return nil, "a database depends on " + name
		}
		for dep := range s.DependsOn {
			queue = append(queue, dep)
		}
	}
	p := &goldenPlan{services: sortedSet(copied), user: map[string]string{}, named: map[string]map[string]string{}, seed: preAppSeed}
	var binds []string
	for _, name := range p.services {
		s := doc.Services[name]
		p.user[name] = "postgres"
		if u := s.Environment["POSTGRES_USER"]; u != nil && *u != "" {
			p.user[name] = *u
		}
		p.named[name] = map[string]string{}
		for _, v := range s.Volumes {
			switch v.Type {
			case "volume":
				if v.Source != "" && !ownKeys[v.Source] {
					p.named[name][path.Clean(v.Target)] = v.Source
				}
			case "bind":
				binds = append(binds, v.Source)
			}
		}
	}
	sum, err := goldenSum(composeFile, projectDir, seed.SQL, binds)
	if err != nil {
		return nil, "inputs: " + err.Error()
	}
	p.sum = sum
	return p, ""
}

// goldenSum hashes what the copy is made from: the compose file, the
// recipe, the seed file, and every file bound into a copied service (read
// inside the checkout only; the cell's own files, resolv.conf and the
// decoy, are the same for every boot of the machine and outside it).
func goldenSum(composeFile []byte, projectDir, seedSQL string, binds []string) (string, error) {
	root, err := os.OpenRoot(projectDir)
	if err != nil {
		return "", err
	}
	defer root.Close()
	h := sha256.New()
	fmt.Fprintf(h, "compose %d\n", len(composeFile))
	h.Write(composeFile)
	var total int64
	add := func(rel string) error {
		return fs.WalkDir(root.FS(), rel, func(p string, e fs.DirEntry, err error) error {
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					fmt.Fprintf(h, "absent %s\n", p)
					return nil
				}
				return err
			}
			switch {
			case e.IsDir():
				fmt.Fprintf(h, "dir %s\n", p)
			case e.Type()&fs.ModeSymlink != 0:
				target, err := root.Readlink(p)
				if err != nil {
					return err
				}
				fmt.Fprintf(h, "link %s %s\n", p, target)
			case e.Type().IsRegular():
				f, err := root.Open(p)
				if err != nil {
					return err
				}
				defer f.Close()
				fi, err := f.Stat()
				if err != nil {
					return err
				}
				if total += fi.Size(); total > maxGoldenInputBytes {
					return fmt.Errorf("more than %d bytes", maxGoldenInputBytes)
				}
				fmt.Fprintf(h, "file %s %d\n", p, fi.Size())
				if _, err := io.Copy(h, io.LimitReader(f, fi.Size())); err != nil {
					return err
				}
			default:
				fmt.Fprintf(h, "other %s %v\n", p, e.Type())
			}
			return nil
		})
	}
	inside := []string{recipe.Path}
	if seedSQL != "" {
		inside = append(inside, seedSQL)
	}
	for _, b := range binds {
		rel, err := filepath.Rel(projectDir, b)
		if err != nil || !filepath.IsLocal(rel) {
			continue // the cell's own file
		}
		inside = append(inside, rel)
	}
	for _, rel := range inside {
		if err := add(filepath.ToSlash(filepath.Clean(rel))); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// goldenKey is the project volume key for an anonymous volume of a service.
func goldenKey(service, target string) string {
	sum := sha256.Sum256([]byte(service + "\x00" + path.Clean(target)))
	return goldenKeyPrefix + hex.EncodeToString(sum[:8])
}

// goldenName names a machine's golden copy of a project volume.
func goldenName(cell, machine, key string) string {
	h := sha256.New()
	for _, p := range []string{cell, machine, key} {
		fmt.Fprintf(h, "%d:%s", len(p), p)
	}
	return "kodus-golden-" + hex.EncodeToString(h.Sum(nil))[:32]
}

func (d *Driver) goldenLabels(ref driver.MachineRef) map[string]string {
	return toLabels(map[string]string{
		driver.TagCell: d.cfg.CellID, driver.TagOrg: ref.Tags[driver.TagOrg], driver.TagClaim: ref.Tags[driver.TagClaim],
		driver.TagHardExpires: ref.Tags[driver.TagHardExpires],
	})
}

// pgDataDir waits for postgres to answer over TCP (the initdb scripts run
// on a server listening on its socket only, so this is the end of init),
// then prints where it keeps its data. $1 polls, $2 the superuser.
const pgDataDir = `n=0; until pg_isready -q -h 127.0.0.1; do n=$((n+1)); if [ "$n" -ge "$1" ]; then echo "postgres never answered on 127.0.0.1" >&2; exit 3; fi; sleep 0.2; done; exec psql -qtAX -h 127.0.0.1 -U "$2" -d postgres -c 'SHOW data_directory'`

// goldenSeedError is a seed that failed before the app: the boot fails
// as the recipe's seed would have.
type goldenSeedError struct{ err error }

func (e *goldenSeedError) Error() string { return e.err.Error() }
func (e *goldenSeedError) Unwrap() error { return e.err }

// takeGolden brings up the plan's services alone, waits for their init,
// runs the pre-app seed, stops them and copies their volumes. The caller
// brings the whole project up after it, whatever it returns. seeded is
// true once the seed ran, even when the copy then failed.
func (d *Driver) takeGolden(ctx context.Context, ref driver.MachineRef, project dockercli.ComposeProject, plan *goldenPlan, projectDir string, rec *recipe.Recipe) (g *golden, seeded bool, err error) {
	machine := ref.MachineID
	// Only the first boot: anything already there may have met the app.
	if ids, err := d.d.IDs(ctx, dockercli.Filters{"label": {"com.docker.compose.project=" + machine}}); err != nil || len(ids) > 0 {
		return nil, false, errors.Join(errors.New("the project already has containers"), err)
	}
	only := project
	only.Services = plan.services
	if err := d.d.ComposeUp(ctx, only); err != nil {
		return nil, false, fmt.Errorf("up %s: %w", strings.Join(plan.services, ","), err)
	}
	ids, err := d.d.IDs(ctx, dockercli.Filters{"label": {"com.docker.compose.project=" + machine}})
	if err != nil {
		return nil, false, err
	}
	cs, err := d.d.Inspect(ctx, ids...)
	if err != nil {
		return nil, false, err
	}
	byService := map[string]dockercli.Container{}
	for _, c := range cs {
		if c.Labels[dockercli.LabelFromTag(driver.TagCell)] != d.cfg.CellID {
			return nil, false, fmt.Errorf("%w: container %s", driver.ErrNotOwned, c.Name)
		}
		byService[c.Labels["com.docker.compose.service"]] = c
	}
	wait := recipe.DefaultHealthTimeout
	if rec != nil {
		wait = rec.HealthTimeout()
	}
	polls := strconv.Itoa(max(int(wait/seedPoll), 1))
	for _, svc := range plan.services {
		c, ok := byService[svc]
		if !ok {
			return nil, false, fmt.Errorf("%s did not start", svc)
		}
		pctx, cancel := context.WithTimeout(ctx, wait+30*time.Second)
		out, err := d.d.ExecInput(pctx, c.ID, nil, "/bin/sh", "-c", pgDataDir, "kodus-golden", polls, plan.user[svc])
		cancel()
		if err != nil {
			return nil, false, fmt.Errorf("%s: where its data is: %w", svc, err)
		}
		dir := path.Clean(strings.TrimSpace(string(out)))
		if !path.IsAbs(dir) || !slices.ContainsFunc(c.Mounts, func(m dockercli.Mount) bool { return m.Type == "volume" && underDir(dir, m.Destination) }) {
			return nil, false, fmt.Errorf("%s keeps its data in %q, in none of its volumes", svc, dir)
		}
	}
	if plan.seed {
		s := rec.Data.Seed
		m := machineState{targets: map[string]execTarget{s.Service: targetOf(byService[s.Service])}}
		if err := d.seed(ctx, m, projectDir, rec); err != nil {
			return nil, false, &goldenSeedError{err}
		}
		seeded = true
	}
	if err := d.d.ComposeStopServices(ctx, machine, plan.services...); err != nil {
		return nil, seeded, fmt.Errorf("stop: %w", err)
	}
	g = &golden{sum: plan.sum, seeded: seeded || (rec != nil && !rec.Data.Seed.IsZero())}
	for _, svc := range plan.services {
		for _, mnt := range byService[svc].Mounts {
			if mnt.Type != "volume" {
				continue
			}
			target := path.Clean(mnt.Destination)
			v := goldenVolume{service: svc, target: target, key: plan.named[svc][target]}
			if v.key == "" {
				v.key, v.injected = goldenKey(svc, target), true
			} else if mnt.Name != projectVolume(machine, v.key) {
				return nil, seeded, errors.Join(fmt.Errorf("%s mounts %s, not the project's %s", svc, mnt.Name, v.key), d.dropGolden(ctx, g))
			}
			v.name = goldenName(d.cfg.CellID, machine, v.key)
			labels := d.goldenLabels(ref)
			labels[labelGoldenOf], labels[labelGoldenKey] = machine, v.key
			if err := d.d.CopyVolumeIn(ctx, d.cfg.Runtime, d.cfg.HelperImage, mnt.Name, v.name, labels); err != nil {
				g.vols = append(g.vols, v)
				return nil, seeded, errors.Join(fmt.Errorf("copy %s: %w", target, err), d.dropGolden(ctx, g))
			}
			g.vols = append(g.vols, v)
		}
	}
	if len(g.vols) == 0 {
		return nil, seeded, errors.New("no volume to copy")
	}
	return g, seeded, nil
}

// underDir: p is dir or under it.
func underDir(p, dir string) bool {
	dir = path.Clean(dir)
	return p == dir || strings.HasPrefix(p, strings.TrimSuffix(dir, "/")+"/")
}

// restoreGolden gives a reset's project the golden copies, as the
// project's own volumes, before it comes up. A copy that fails drops every
// one it made.
func (d *Driver) restoreGolden(ctx context.Context, ref driver.MachineRef, g *golden) error {
	var made []string
	for _, v := range g.vols {
		to := projectVolume(ref.MachineID, v.key)
		labels := d.goldenLabels(ref)
		// Compose's own labels: the volume is the project's, and down -v takes it.
		labels["com.docker.compose.project"], labels["com.docker.compose.volume"] = ref.MachineID, v.key
		made = append(made, to)
		if err := d.d.CopyVolumeIn(ctx, d.cfg.Runtime, d.cfg.HelperImage, v.name, to, labels); err != nil {
			return errors.Join(fmt.Errorf("restore %s: %w", v.key, err), d.d.VolumeRemove(context.WithoutCancel(ctx), made...))
		}
	}
	return nil
}

// dropGolden removes a copy's volumes.
func (d *Driver) dropGolden(ctx context.Context, g *golden) error {
	if g == nil {
		return nil
	}
	names := make([]string, 0, len(g.vols))
	for _, v := range g.vols {
		names = append(names, v.name)
	}
	return d.d.VolumeRemove(context.WithoutCancel(ctx), names...)
}

// removeGolden removes every golden volume of the machine this cell made,
// from Docker's labels alone (Destroy, the sweep, the reaper).
func (r *Reaper) removeGolden(ctx context.Context, machine string) error {
	vols, err := r.d.Volumes(ctx, map[string]string{dockercli.LabelFromTag(driver.TagCell): r.cfg.CellID, labelGoldenOf: machine})
	if err != nil || len(vols) == 0 {
		return err
	}
	names := make([]string, 0, len(vols))
	for _, v := range vols {
		names = append(names, v.Name)
	}
	return r.d.VolumeRemove(ctx, names...)
}

// orphanGolden are the machines of this cell that left golden volumes and
// no container (a crash between the down and their removal), each with the
// earliest ceiling its volumes carry. live are the machines that still have one.
func (r *Reaper) orphanGolden(ctx context.Context, live map[string]bool) ([]driver.MachineRef, error) {
	vols, err := r.d.Volumes(ctx, map[string]string{dockercli.LabelFromTag(driver.TagCell): r.cfg.CellID, labelGoldenOf: ""})
	if err != nil {
		return nil, err
	}
	hard := map[string]time.Time{}
	tags := map[string]map[string]string{}
	for _, v := range vols {
		m := v.Labels[labelGoldenOf]
		if live[m] || !machineNamePattern.MatchString(m) {
			continue
		}
		h := driver.ParseExpiry(map[string]string{driver.TagHardExpires: v.Labels[dockercli.LabelFromTag(driver.TagHardExpires)]}, driver.TagHardExpires)
		if prev, ok := hard[m]; !ok || h.Before(prev) {
			hard[m] = h
			tags[m] = map[string]string{driver.TagCell: r.cfg.CellID, driver.TagClaim: v.Labels[dockercli.LabelFromTag(driver.TagClaim)], driver.TagOrg: v.Labels[dockercli.LabelFromTag(driver.TagOrg)]}
		}
	}
	names := make([]string, 0, len(hard))
	for m := range hard {
		names = append(names, m)
	}
	sort.Strings(names)
	out := make([]driver.MachineRef, 0, len(names))
	for _, m := range names {
		t := tags[m]
		t[driver.TagHardExpires] = driver.FormatTime(hard[m])
		out = append(out, driver.MachineRef{MachineID: m, Tags: t})
	}
	return out, nil
}
