package localdocker

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

const recipeYAML = `version: 1
services:
  compose:
    files: [docker-compose.yml]
    public: web
    health: /health
    health_timeout: 30s
    env: { APP_PORT: "8080" }
  expose:
    - { service: web, port: 8080, kind: http }
    - { service: db, port: 5432, kind: postgres }
data:
  migrate: ./migrate.sh
  seed: { service: db, sql: seed.sql, user: app, database: app }
ui: { service: web }
`

const recipeCompose = `services:
  web: { build: ., ports: ["8080:8080"] }
  db: { image: postgres:16, ports: ["5432:5432"] }
  cache: { image: redis:7, ports: ["6379:6379"] }
`

// recipe.Parse accepts every §6 key; local-docker says which it ignores and
// refuses what it cannot run.
func TestRecipeKeysLocalDockerIgnoresOrRefuses(t *testing.T) {
	r, err := recipe.Parse([]byte(recipeYAML))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(recipeKeysIgnored(r), ","); got != "ui" {
		t.Fatalf("ignored %s", got)
	}
	needs, err := recipe.Parse([]byte("version: 1\nservices: { needs: { sso: { repo: a/b } } }\n"))
	if err != nil {
		t.Fatal(err)
	}
	if err := refuseWhatLocalDockerCannotRun(needs); err == nil {
		t.Fatal("services.needs accepted")
	}
}

func recipeRepo(t *testing.T) string {
	dir := writeRepo(t, map[string]string{"docker-compose.yml": recipeCompose, "compose.yaml": "services: { other: { image: x } }\n", "seed.sql": "insert into t values (1);\n"})
	if err := os.MkdirAll(filepath.Join(dir, ".kodus"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, recipe.Path), []byte(recipeYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestRecipeBootExposeAndReset(t *testing.T) {
	ctx := context.Background()
	m := newFake()
	d := newDriver(t, m, t.TempDir())
	var gets []string
	d.getStatus = func(_ context.Context, url string) (int, error) {
		gets = append(gets, url)
		if len(gets) == 1 {
			return 503, nil // not ready yet: the check polls
		}
		return 200, nil
	}
	d.pollEvery = time.Millisecond
	if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{ClaimID: "Claim-1", Expose: []driver.ExposePort{{Service: "web", Port: 8080, Kind: "http"}}}); err != nil {
		t.Fatal(err)
	}
	work, _ := d.Create(ctx, spec(driver.RoleWorkload))
	dir := recipeRepo(t)
	if err := d.Boot(ctx, work, dir); err != nil {
		t.Fatal(err)
	}
	// Only the recipe's expose is published, on 127.0.0.1, from its compose file.
	var doc struct {
		Services map[string]struct {
			Ports []string `yaml:"ports"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(m.composes[work.MachineID], &doc); err != nil {
		t.Fatal(err)
	}
	if p := doc.Services; len(p) != 3 || strings.Join(p["web"].Ports, ",") != "127.0.0.1::8080" || strings.Join(p["db"].Ports, ",") != "127.0.0.1::5432" || len(p["cache"].Ports) != 0 {
		t.Fatalf("ports %+v", p)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, EnvFile)); string(b) != "APP_PORT=8080\n" {
		t.Fatalf("env file %q", b)
	}
	// The observer reaches each exposed service by name, even the ones
	// claim.acquire did not list.
	ts, err := d.Targets("Claim-1", nil)
	if err != nil || len(ts) != 2 || ts[0].Service != "web" || ts[0].Address != "127.0.0.1:55001" || ts[1].Service != "db" || ts[1].Kind != "postgres" || ts[1].Address != "127.0.0.1:55002" {
		t.Fatalf("targets %+v %v", ts, err)
	}
	if _, err := d.Targets("Claim-1", []observer.Target{{Service: "cache", Port: 6379}}); err == nil {
		t.Fatal("unpublished target accepted")
	}
	man, ok := d.Manifest("Claim-1")
	if !ok || len(man.Expose) != 2 || man.Expose[1].Service != "db" || man.Expose[1].Port != 5432 || len(man.Services) != 3 || man.SeedSha == "none" || man.ImageID != "img-1" {
		t.Fatalf("manifest %+v", man)
	}
	if len(gets) != 2 || gets[0] != "http://127.0.0.1:55001/health" {
		t.Fatalf("ready check %v", gets)
	}
	rep, ok := d.LastBoot("Claim-1")
	if !ok || rep.Kind != "boot" || rep.TotalMs < rep.BuildMs+rep.UpMs+rep.SeedMs+rep.ReadyMs || rep.At.IsZero() {
		t.Fatalf("boot report %+v", rep)
	}

	m.calls = nil
	gets = nil
	if err := d.Reset(ctx, work, driver.SnapshotRef{Kind: "compose_volumes", Ref: "seed"}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"down kodus-claim-1-workload v=true",
		"up kodus-claim-1-workload",
		"port kodus-claim-1-workload web 8080",
		"port kodus-claim-1-workload db 5432",
		"sh ./migrate.sh",
		"exec kodus-claim-1-workload db pg_isready -q -h 127.0.0.1 -U app -d app",
		"exec kodus-claim-1-workload db psql -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U app -d app",
		"stdin insert into t values (1);",
	}
	if m.joined() != strings.Join(want, "\n") || len(gets) != 2 {
		t.Fatalf("reset calls:\n%s\ngets %v", m.joined(), gets)
	}
	if rep, _ := d.LastBoot("Claim-1"); rep.Kind != "reset" || rep.BuildMs != 0 {
		t.Fatalf("reset report %+v", rep)
	}
}

func TestRecipeRefusesClaimPortItDoesNotExpose(t *testing.T) {
	ctx := context.Background()
	d := newDriver(t, newFake(), t.TempDir())
	if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{ClaimID: "Claim-1", Expose: []driver.ExposePort{{Service: "cache", Port: 6379, Kind: "http"}}}); err != nil {
		t.Fatal(err)
	}
	work, _ := d.Create(ctx, spec(driver.RoleWorkload))
	if err := d.Boot(ctx, work, recipeRepo(t)); err == nil || !strings.Contains(err.Error(), "cache/6379") {
		t.Fatalf("err %v", err)
	}
}

func TestReseedSkipsRecreate(t *testing.T) {
	ctx := context.Background()
	m := newFake()
	d := newDriver(t, m, t.TempDir())
	d.getStatus = func(context.Context, string) (int, error) { return 200, nil }
	work, _ := d.Create(ctx, spec(driver.RoleWorkload))
	dir := writeRepo(t, map[string]string{"compose.yaml": "services: { web: { image: x } }\n"})
	_ = os.MkdirAll(filepath.Join(dir, ".kodus"), 0o700)
	_ = os.WriteFile(filepath.Join(dir, recipe.Path), []byte("version: 1\ndata: { seed: { service: web, command: ./reseed }, reset: reseed }\n"), 0o600)
	if err := d.Boot(ctx, work, dir); err != nil {
		t.Fatal(err)
	}
	m.calls = nil
	if err := d.Reset(ctx, work, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	if m.joined() != "exec kodus-claim-1-workload web sh -c ./reseed" {
		t.Fatalf("calls %s", m.joined())
	}
}
