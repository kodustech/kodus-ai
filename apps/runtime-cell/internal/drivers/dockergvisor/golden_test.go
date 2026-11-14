package dockergvisor

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// composeDocker is memDocker with compose itself: config answers the file
// the cell wrote, up makes each service's container (a new one when there
// is none) with its volumes, and postgres initializes an empty data volume
// ("initdb"). It counts what a reset is meant to save: each initdb.
type composeDocker struct {
	*memDocker
	inits int
	// ups are the services each up asked for ("" for all of them).
	ups   []string
	stops []string
	// dataDir is what the server says its data directory is.
	dataDir string
}

func newComposeDocker() *composeDocker {
	return &composeDocker{memDocker: newMemDocker(), dataDir: "/var/lib/postgresql/data"}
}

type fakeService struct {
	Image   string           `yaml:"image"`
	Labels  map[string]any   `yaml:"labels"`
	Volumes []map[string]any `yaml:"volumes"`
}

func readRendered(t testing.TB, file string) (map[string]any, map[string]fakeService) {
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	var typed struct {
		Services map[string]fakeService `yaml:"services"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if err := yaml.Unmarshal(raw, &typed); err != nil {
		t.Fatal(err)
	}
	return doc, typed.Services
}

var composeT testing.TB

func (c *composeDocker) ComposeConfig(_ context.Context, p dockercli.ComposeProject) ([]byte, error) {
	doc, _ := readRendered(composeT, p.File)
	if vols, ok := doc["volumes"].(map[string]any); ok {
		for k := range vols {
			vols[k] = map[string]any{"name": p.Name + "_" + k}
		}
	}
	return json.Marshal(doc)
}

func (c *composeDocker) ComposeUp(_ context.Context, p dockercli.ComposeProject) error {
	_, services := readRendered(composeT, p.File)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ups = append(c.ups, strings.Join(p.Services, ","))
	names := make([]string, 0, len(services))
	for n := range services {
		names = append(names, n)
	}
	slices.Sort(names)
	for _, name := range names {
		if len(p.Services) > 0 && !slices.Contains(p.Services, name) {
			continue
		}
		cname := p.Name + "-" + name + "-1"
		if _, ok := c.containers[cname]; ok {
			continue // compose starts the stopped one
		}
		s := services[name]
		labels := map[string]string{"com.docker.compose.project": p.Name, "com.docker.compose.service": name}
		for k, v := range s.Labels {
			labels[k] = fmt.Sprint(v)
		}
		c.seq++
		ctr := dockercli.Container{ID: fmt.Sprintf("x%04d", c.seq), Name: cname, Image: s.Image, Labels: labels, Networks: map[string]string{"kodus-claim-1": fmt.Sprintf("10.213.5.%d", 10+c.seq%100)}}
		pg := postgresImages[imageName(s.Image)]
		mounted := false
		for _, v := range s.Volumes {
			if v["type"] != "volume" {
				continue
			}
			target := fmt.Sprint(v["target"])
			vol := p.Name + "_" + fmt.Sprint(v["source"])
			if _, ok := c.volumes[vol]; !ok {
				c.volumes[vol] = memVolume{labels: map[string]string{"com.docker.compose.project": p.Name, "com.docker.compose.volume": fmt.Sprint(v["source"])}}
			}
			ctr.Mounts = append(ctr.Mounts, dockercli.Mount{Type: "volume", Name: vol, Destination: target})
			mounted = mounted || target == "/var/lib/postgresql/data"
		}
		if pg && !mounted {
			// The image's VOLUME: anonymous, gone with the container on down -v.
			anon := fmt.Sprintf("anon%04d", c.seq)
			c.volumes[anon] = memVolume{labels: map[string]string{"com.docker.volume.anonymous": "", "mem.anon-of": p.Name}}
			ctr.Mounts = append(ctr.Mounts, dockercli.Mount{Type: "volume", Name: anon, Destination: "/var/lib/postgresql/data"})
		}
		if pg {
			for _, m := range ctr.Mounts {
				if m.Destination == "/var/lib/postgresql/data" && c.volumes[m.Name].data == "" {
					v := c.volumes[m.Name]
					v.data = "initdb"
					c.volumes[m.Name] = v
					c.inits++
				}
			}
		}
		c.containers[cname] = ctr
	}
	return nil
}

func (c *composeDocker) ComposeDown(ctx context.Context, project string, volumes bool) error {
	c.mu.Lock()
	if volumes {
		for name, v := range c.volumes {
			if v.labels["mem.anon-of"] == project {
				delete(c.volumes, name)
			}
		}
	}
	c.mu.Unlock()
	return c.memDocker.ComposeDown(ctx, project, volumes)
}

func (c *composeDocker) ComposeStopServices(_ context.Context, _ string, services ...string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stops = append(c.stops, strings.Join(services, ","))
	return nil
}

// ExecInput answers the data directory probe; a seed adds itself to the
// data of the seed service's volume.
func (c *composeDocker) ExecInput(ctx context.Context, container string, stdin []byte, argv ...string) ([]byte, error) {
	if _, err := c.memDocker.ExecInput(ctx, container, stdin, argv...); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(argv) > 2 && argv[2] == pgDataDir {
		return []byte(c.dataDir + "\n"), nil
	}
	for _, ctr := range c.containers {
		if ctr.ID == container {
			for _, m := range ctr.Mounts {
				v := c.volumes[m.Name]
				v.data += "+seed"
				c.volumes[m.Name] = v
			}
		}
	}
	return nil, nil
}

const goldenCompose = `services:
  app:
    image: shop-app
    depends_on:
      db:
        condition: service_healthy
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: shop
    volumes:
      - type: bind
        source: ./db/seed.sql
        target: /docker-entrypoint-initdb.d/seed.sql
        read_only: true
`

const goldenRecipe = `version: 1
services:
  compose: { files: [docker-compose.yml], public: app }
data:
  seed: { service: db, sql: db/seed.sql, user: shop, database: shop }
`

// testWriter sends the driver's log to the test's.
type testWriter struct{ t testing.TB }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Log(strings.TrimSpace(string(p)))
	return len(p), nil
}

type goldenRig struct {
	d      *Driver
	docker *composeDocker
	ref    driver.MachineRef
	dir    string
	file   []byte
}

func newGoldenRig(t *testing.T, file, recipeText string) *goldenRig {
	t.Helper()
	composeT = t
	docker := newComposeDocker()
	docker.plant(dockercli.Container{ID: "cegress", Name: "kodus-egress", Networks: map[string]string{"kodus-cell": "10.9.0.2"}})
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(), EgressContainer: "kodus-egress",
		Log: slog.New(slog.NewTextHandler(testWriter{t}, nil))})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	if err != nil {
		t.Fatal(err)
	}
	s := spec()
	s.ClaimGroupID = n.WorkloadGroupID
	ref, err := d.Create(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	// The real path: the sandbox resolves the binds' sources (macOS's /var).
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "db", "seed.sql"), "INSERT INTO orders VALUES (1);\n")
	if recipeText != "" {
		writeFile(t, filepath.Join(dir, recipe.Path), recipeText)
	}
	return &goldenRig{d: d, docker: docker, ref: ref, dir: dir, file: []byte(file)}
}

// up is what the agent does: Up, then the recipe's steps.
func (r *goldenRig) up(t *testing.T) {
	t.Helper()
	if _, err := r.d.Up(context.Background(), r.ref, r.file, r.dir); err != nil {
		t.Fatal(err)
	}
	if err := r.d.RunRecipe(context.Background(), r.ref, r.dir); err != nil {
		t.Fatal(err)
	}
}

func (r *goldenRig) reset(t *testing.T) {
	t.Helper()
	if err := r.d.Reset(context.Background(), r.ref, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	r.up(t)
}

// dbData is what the db container's data volume holds now.
func (r *goldenRig) dbData(t *testing.T) (string, string) {
	t.Helper()
	r.docker.mu.Lock()
	defer r.docker.mu.Unlock()
	c, ok := r.docker.containers[r.ref.MachineID+"-db-1"]
	if !ok {
		t.Fatal("no db container")
	}
	for _, m := range c.Mounts {
		if m.Destination == "/var/lib/postgresql/data" {
			return m.Name, r.docker.volumes[m.Name].data
		}
	}
	t.Fatal("db has no data volume")
	return "", ""
}

func (r *goldenRig) write(t *testing.T, what string) {
	name, data := r.dbData(t)
	r.docker.mu.Lock()
	defer r.docker.mu.Unlock()
	v := r.docker.volumes[name]
	v.data = data + what
	r.docker.volumes[name] = v
}

func goldenVolumes(docker *composeDocker) map[string]memVolume {
	docker.mu.Lock()
	defer docker.mu.Unlock()
	out := map[string]memVolume{}
	for n, v := range docker.volumes {
		if _, ok := v.labels[labelGoldenOf]; ok {
			out[n] = v
		}
	}
	return out
}

// The sample app (pgvector seeded through initdb, the recipe's seed the same
// file): the first boot starts db alone, waits for its init, stops it and
// copies its anonymous volume; every reset gives the new db a copy of that
// instead of running initdb again. Each round starts from the first boot's
// data, never from what a previous round wrote, and with new containers.
func TestResetsStartFromTheFirstBootsGoldenData(t *testing.T) {
	r := newGoldenRig(t, goldenCompose, goldenRecipe)
	r.up(t)
	if got := strings.Join(r.docker.ups, "|"); got != "db|" {
		t.Fatalf("first boot ups %q, want db alone then all", got)
	}
	if got := strings.Join(r.docker.stops, "|"); got != "db" {
		t.Fatalf("stops %q", got)
	}
	gv := goldenVolumes(r.docker)
	if len(gv) != 1 {
		t.Fatalf("golden volumes %v", gv)
	}
	for name, v := range gv {
		if v.data != "initdb" || v.labels[labelGoldenOf] != r.ref.MachineID || v.labels["kodus.cell"] != "cell-1" || v.labels["kodus.hard-expires"] == "" {
			t.Fatalf("golden %s = %+v", name, v)
		}
		if _, compose := v.labels["com.docker.compose.project"]; compose {
			t.Fatal("a golden volume carries compose's label: down -v would take it")
		}
	}
	for _, c := range r.docker.copies {
		if !strings.HasPrefix(c, "runsc ") {
			t.Fatalf("a copy of the org's data ran outside gVisor: %q", c)
		}
	}
	if len(r.docker.inputs) != 1 {
		t.Fatalf("execs with input %+v, want the data directory probe alone (the seed is at init)", r.docker.inputs)
	}
	firstApp := r.docker.containers[r.ref.MachineID+"-app-1"].ID
	r.write(t, "+round0")

	for i := range 3 {
		r.reset(t)
		if r.docker.inits != 1 {
			t.Fatalf("reset %d: initdb ran %d times, want only the first boot's", i, r.docker.inits)
		}
		name, data := r.dbData(t)
		if data != "initdb" || name != projectVolume(r.ref.MachineID, goldenKey("db", "/var/lib/postgresql/data")) {
			t.Fatalf("reset %d: db on %s holding %q, want a project copy of the golden data", i, name, data)
		}
		if app := r.docker.containers[r.ref.MachineID+"-app-1"].ID; app == firstApp {
			t.Fatalf("reset %d: the app container is the previous round's", i)
		} else {
			firstApp = app
		}
		tm, _ := r.d.BootTiming("claim-1")
		if tm.Kind != "reset" {
			t.Fatalf("reset %d timing %+v", i, tm)
		}
		r.write(t, fmt.Sprintf("+round%d", i+1))
	}
	if len(r.docker.inputs) != 1 {
		t.Fatalf("a reset ran a seed or a probe: %+v", r.docker.inputs)
	}
	if err := r.d.Destroy(context.Background(), r.ref); err != nil {
		t.Fatal(err)
	}
	if gv := goldenVolumes(r.docker); len(gv) != 0 {
		t.Fatalf("golden volumes outlived the machine: %v", gv)
	}
}

// A SQL seed the compose file does not bind into initdb runs before the
// app on the first boot, into the copy; the rounds after do not run it.
func TestASQLSeedRunsBeforeTheAppAndOnlyOnce(t *testing.T) {
	file := strings.Replace(goldenCompose, `    volumes:
      - type: bind
        source: ./db/seed.sql
        target: /docker-entrypoint-initdb.d/seed.sql
        read_only: true
`, "", 1)
	r := newGoldenRig(t, file, goldenRecipe)
	r.up(t)
	seeds := func() int {
		n := 0
		for _, in := range r.docker.inputs {
			if in.argv[2] == seedScript {
				n++
			}
		}
		return n
	}
	if seeds() != 1 {
		t.Fatalf("seeds %d on the first boot", seeds())
	}
	for _, v := range goldenVolumes(r.docker) {
		if v.data != "initdb+seed" {
			t.Fatalf("golden holds %q, want the seed", v.data)
		}
	}
	r.reset(t)
	r.reset(t)
	if _, data := r.dbData(t); data != "initdb+seed" || seeds() != 1 || r.docker.inits != 1 {
		t.Fatalf("after resets: data %q, %d seeds, %d inits", data, seeds(), r.docker.inits)
	}
}

// A named data volume is copied back into itself; nothing is injected.
func TestANamedDataVolumeGoesBackUnderItsName(t *testing.T) {
	file := goldenCompose + `      - type: volume
        source: pgdata
        target: /var/lib/postgresql/data
volumes:
  pgdata: {}
`
	r := newGoldenRig(t, file, goldenRecipe)
	r.up(t)
	r.write(t, "+round0")
	r.reset(t)
	name, data := r.dbData(t)
	if name != projectVolume(r.ref.MachineID, "pgdata") || data != "initdb" || r.docker.inits != 1 {
		t.Fatalf("db on %s holding %q, %d inits", name, data, r.docker.inits)
	}
}

// Whatever the app's container runs before the data is ready keeps the
// reset as it was: down -v, init again, the steps again.
func TestStepsInTheAppKeepTheResetAsItWas(t *testing.T) {
	for name, rec := range map[string]string{
		"migrate":      "version: 1\nservices: { compose: { public: app } }\ndata: { migrate: npm run migrate }\n",
		"setup":        "version: 1\nsetup: [make]\nservices: { compose: { public: app } }\n",
		"seed command": "version: 1\nservices: { compose: { public: app } }\ndata: { seed: npm run seed }\n",
		"reseed":       "version: 1\nservices: { compose: { public: app } }\ndata: { reset: reseed }\n",
	} {
		t.Run(name, func(t *testing.T) {
			r := newGoldenRig(t, goldenCompose, rec)
			r.docker.execAnswer.ExitCode = 0
			r.up(t)
			if len(goldenVolumes(r.docker)) != 0 || strings.Join(r.docker.ups, "|") != "" {
				t.Fatalf("golden %v, ups %q", goldenVolumes(r.docker), r.docker.ups)
			}
			r.reset(t)
			if r.docker.inits != 2 {
				t.Fatalf("inits %d, want a new initdb on the reset", r.docker.inits)
			}
		})
	}
}

// A data directory outside the service's volumes would not survive the
// copy: no golden data.
func TestADataDirectoryOutsideTheVolumesTakesNoCopy(t *testing.T) {
	r := newGoldenRig(t, goldenCompose, goldenRecipe)
	r.docker.dataDir = "/pgdata"
	r.up(t)
	if len(goldenVolumes(r.docker)) != 0 {
		t.Fatal("copied a volume that does not hold the data")
	}
	r.reset(t)
	if r.docker.inits != 2 {
		t.Fatalf("inits %d", r.docker.inits)
	}
}

// When what the copy was made from changes (here the seed file), the reset
// drops the copy and recreates.
func TestChangedInputsDropTheCopy(t *testing.T) {
	r := newGoldenRig(t, goldenCompose, goldenRecipe)
	r.up(t)
	writeFile(t, filepath.Join(r.dir, "db", "seed.sql"), "INSERT INTO orders VALUES (2);\n")
	r.reset(t)
	if r.docker.inits != 2 || len(goldenVolumes(r.docker)) != 0 {
		t.Fatalf("inits %d, golden %v", r.docker.inits, goldenVolumes(r.docker))
	}
	name, _ := r.dbData(t)
	if strings.Contains(name, goldenKeyPrefix) {
		t.Fatalf("db still on the injected volume %s", name)
	}
}

// A golden volume whose machine is gone (a crash between the down and its
// removal) is found by the reaper and the sweep past its ceiling.
func TestOrphanGoldenDataIsReaped(t *testing.T) {
	r := newGoldenRig(t, goldenCompose, goldenRecipe)
	r.up(t)
	// The containers and the holder are gone; the golden volume is not.
	r.docker.mu.Lock()
	for n := range r.docker.containers {
		if n != "kodus-egress" {
			delete(r.docker.containers, n)
		}
	}
	r.docker.mu.Unlock()
	rp, err := NewForReaper(r.docker, ReaperConfig{CellID: "cell-1", WorkDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	refs, err := rp.List(context.Background(), map[string]string{driver.TagCell: "cell-1"})
	if err != nil || len(refs) != 1 || refs[0].MachineID != r.ref.MachineID || refs[0].Tags[driver.TagHardExpires] == "" {
		t.Fatalf("reaper lists %+v %v", refs, err)
	}
	if err := rp.Destroy(context.Background(), refs[0]); err != nil || len(goldenVolumes(r.docker)) != 0 {
		t.Fatalf("destroy %v, left %v", err, goldenVolumes(r.docker))
	}

	r2 := newGoldenRig(t, goldenCompose, goldenRecipe)
	r2.up(t)
	r2.docker.mu.Lock()
	for n := range r2.docker.containers {
		if n != "kodus-egress" {
			delete(r2.docker.containers, n)
		}
	}
	r2.docker.mu.Unlock()
	if gone, err := r2.d.SweepExpired(context.Background(), time.Date(2026, 10, 29, 12, 30, 0, 0, time.UTC)); err != nil || len(gone) != 0 {
		t.Fatalf("the sweep took golden data before its ceiling: %v %v", gone, err)
	}
	if gone, err := r2.d.SweepExpired(context.Background(), time.Date(2026, 10, 29, 14, 0, 0, 0, time.UTC)); err != nil || len(gone) != 1 || len(goldenVolumes(r2.docker)) != 0 {
		t.Fatalf("sweep past the ceiling: %v %v, left %v", gone, err, goldenVolumes(r2.docker))
	}
}

func TestPlanGoldenRefusesWhatItCannotProve(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "db", "seed.sql"), "SELECT 1;\n")
	svc := func(image string, deps ...string) map[string]any {
		s := map[string]any{"image": image}
		if len(deps) > 0 {
			d := map[string]any{}
			for _, x := range deps {
				d[x] = map[string]any{"condition": "service_started"}
			}
			s["depends_on"] = d
		}
		return s
	}
	canon := func(services map[string]any, volumes ...string) []byte {
		doc := map[string]any{"services": services}
		if len(volumes) > 0 {
			v := map[string]any{}
			for _, k := range volumes {
				v[k] = map[string]any{}
			}
			doc["volumes"] = v
		}
		b, _ := json.Marshal(doc)
		return b
	}
	load := func(text string) *recipe.Recipe {
		d := t.TempDir()
		writeFile(t, filepath.Join(d, recipe.Path), text)
		rec, err := recipe.Load(d)
		if err != nil {
			t.Fatal(err)
		}
		return rec
	}
	base := map[string]any{"app": svc("shop", "db"), "db": svc("postgres:16")}
	cases := []struct {
		name    string
		canon   []byte
		rec     *recipe.Recipe
		atInit  bool
		refused string
	}{
		{"no recipe, plain postgres", canon(base), nil, false, ""},
		{"redis beside", canon(map[string]any{"app": svc("shop", "db"), "db": svc("postgres:16", "cache"), "cache": svc("redis:7")}), nil, false, ""},
		{"sql seed", canon(base), load("version: 1\ndata: { seed: { service: db, sql: db/seed.sql } }\n"), false, ""},
		{"no postgres", canon(map[string]any{"app": svc("shop", "cache"), "cache": svc("redis:7")}), nil, false, "no postgres"},
		{"db needs the app", canon(map[string]any{"app": svc("shop"), "db": svc("postgres:16", "app")}), nil, false, "depends on app"},
		{"migrate", canon(base), load("version: 1\ndata: { migrate: ./m }\n"), false, "migrate"},
		{"setup", canon(base), load("version: 1\nsetup: [make]\n"), false, "setup"},
		{"seed command", canon(base), load("version: 1\ndata: { seed: { service: db, command: ./s } }\n"), false, "command"},
		{"reseed", canon(base), load("version: 1\ndata: { reset: reseed }\n"), false, "reseed"},
		{"public db", canon(base), load("version: 1\nservices: { compose: { public: db } }\n"), false, "public"},
		{"planted key", canon(base, goldenKeyPrefix+"x"), nil, false, "declares"},
	}
	for _, c := range cases {
		p, why := planGolden(c.canon, []byte("x"), dir, c.rec, c.atInit, nil)
		switch {
		case c.refused == "" && p == nil:
			t.Errorf("%s: refused (%s)", c.name, why)
		case c.refused != "" && (p != nil || !strings.Contains(why, c.refused)):
			t.Errorf("%s: plan %+v, why %q, want refused for %q", c.name, p, why, c.refused)
		}
	}
	p, _ := planGolden(canon(base), []byte("x"), dir, load("version: 1\ndata: { seed: { service: db, sql: db/seed.sql } }\n"), false, nil)
	if !p.seed || !slices.Equal(p.services, []string{"db"}) || p.user["db"] != "postgres" {
		t.Fatalf("sql seed plan %+v", p)
	}
	if again, _ := planGolden(canon(base), []byte("y"), dir, nil, false, nil); again.sum == p.sum {
		t.Fatal("another compose file hashed the same")
	}
}

func TestImageName(t *testing.T) {
	for ref, want := range map[string]string{"pgvector/pgvector:pg16": "pgvector", "postgres": "postgres", "docker.io/library/postgres:16@sha256:ab": "postgres", "registry:5000/team/Mongo:7": "mongo"} {
		if got := imageName(ref); got != want {
			t.Errorf("%s: %s", ref, got)
		}
	}
}
