package recipe

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const sample = `version: 1
services:
  compose:
    files: [docker-compose.yml]
    public: web
    health: /health
    health_timeout: 30s
    env: { APP_PORT: "8080" }
  expose:
    - { service: web, port: 8080, kind: http }
    - { service: db, port: 5432, kind: postgres, readonly_user_from_seed: true }
data:
  migrate: ./migrate.sh
  seed: { service: db, sql: seed.sql, user: app, database: app }
ui: { service: web }
`

func TestParseReadsEveryPart(t *testing.T) {
	r, err := Parse([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	if r.Services.Compose.Primary() != "web" || r.HealthTimeout() != 30*time.Second || len(r.Services.Expose) != 2 ||
		r.Data.Seed.SQL != "seed.sql" || r.Data.Seed.Service != "db" || r.Services.Compose.Env["APP_PORT"] != "8080" {
		t.Fatalf("parsed %+v", r)
	}
	if p, ok := r.PublicHTTP(); !ok || p.Port != 8080 {
		t.Fatalf("public http %+v %v", p, ok)
	}
	if !r.SeedsData() || r.ResetStrategy() != ResetRecreate || r.UI.IsZero() {
		t.Fatalf("data %+v", r.Data)
	}
}

func TestParseReadsRunoForms(t *testing.T) {
	r, err := Parse([]byte("version: 1\nservices: { compose: { health_timeout: 600 } }\ndata: { seed: pnpm seed }\n"))
	if err != nil || r.HealthTimeout() != 600*time.Second || r.Data.Seed.Command != "pnpm seed" {
		t.Fatalf("a bare number is seconds and a string seed is a host command: %+v %v", r, err)
	}
	if r, _ := Parse([]byte("version: 1\n")); r.HealthTimeout() != DefaultHealthTimeout || r.SeedsData() {
		t.Fatalf("defaults %+v", r)
	}
	r, err = Parse([]byte("version: 1\nservices: { compose: { file: dev.yml, public: [web, hooks], profiles: [mcp] } }\nexpose: { mode: https }\n"))
	if err != nil || len(r.Services.Compose.Files) != 1 || r.Services.Compose.Files[0] != "dev.yml" || r.Services.Compose.File != "" ||
		r.Services.Compose.Primary() != "web" || r.Services.Compose.Profiles[0] != "mcp" || r.Expose.IsZero() {
		t.Fatalf("file is files, the first public is the primary, Runo's expose is read: %+v %v", r, err)
	}
}

// A wait longer than a setup gives is read as the most it gives, not
// refused: a Runo recipe (Kodus's own says 20m) still boots in a cell.
func TestHealthTimeoutIsCappedAtTheMostASetupWaits(t *testing.T) {
	for v, want := range map[string]time.Duration{
		"900":        MaxHealthTimeout,
		"901":        MaxHealthTimeout,
		"20m":        MaxHealthTimeout,
		"9223372036": MaxHealthTimeout,
		"+90s":       90 * time.Second,
		"899":        899 * time.Second,
	} {
		r, err := Parse([]byte("version: 1\nservices: { compose: { health_timeout: \"" + v + "\" } }\n"))
		if err != nil {
			t.Errorf("health_timeout %s: refused: %v", v, err)
		} else if r.HealthTimeout() != want {
			t.Errorf("health_timeout %s: %s, want %s", v, r.HealthTimeout(), want)
		}
	}
}

func TestParseNamesRunoServicesMode(t *testing.T) {
	_, err := Parse([]byte("version: 1\nservices:\n  db: { image: postgres }\n  app: { run: bun app.ts }\n"))
	if err == nil || !strings.Contains(err.Error(), "services.app: a cell boots a compose project") {
		t.Fatalf("%v", err)
	}
}

func TestParseRefuses(t *testing.T) {
	bad := map[string]string{
		"empty":              "",
		"unknown top key":    "version: 1\nservise: {}\n",
		"unknown nested key": "version: 1\nservices: { compose: { helth: /x } }\n",
		"unknown seed key":   "version: 1\ndata: { seed: { service: db, sql: a.sql, pasword: x } }\n",
		"seed sql and cmd":   "version: 1\ndata: { seed: { service: db, sql: a.sql, command: x } }\n",
		"no version":         "services: {}\n",
		"expose no service":  "version: 1\nservices: { expose: [ { port: 80, kind: http } ] }\n",
		"expose bad port":    "version: 1\nservices: { expose: [ { service: web, port: 70000, kind: http } ] }\n",
		"expose bad kind":    "version: 1\nservices: { expose: [ { service: web, port: 80, kind: redis } ] }\n",
		"expose port string": "version: 1\nservices: { expose: [ { service: web, port: http, kind: http } ] }\n",
		"expose twice":       "version: 1\nservices: { expose: [ { service: web, port: 80, kind: http }, { service: web, port: 80, kind: http } ] }\n",
		"expose unknown key": "version: 1\nservices: { expose: [ { service: web, port: 80, kind: http, host: 0.0.0.0 } ] }\n",
		"health no public":   "version: 1\nservices: { compose: { health: /h }, expose: [ { service: web, port: 80, kind: http } ] }\n",
		"health not a path":  "version: 1\nservices: { compose: { public: web, health: h }, expose: [ { service: web, port: 80, kind: http } ] }\n",
		"files.copy":         "version: 1\nfiles: { copy: [.env] }\n",
		"secret key":         "version: 1\nservices: { compose: { env: { STRIPE_SECRET: x } } }\n",
		"secret key, almost": "version: 1\nservices: { compose: { env: { SESSION_SECRET: kodus-test-value-real } } }\n",
		"secret value":       "version: 1\nservices: { compose: { env: { X: ghp_abcdefghijklmnopqrstuvwxyz0123 } } }\n",
		"env newline":        "version: 1\nservices: { compose: { env: { X: \"a\\nb\" } } }\n",
		"env LD_PRELOAD":     "version: 1\nservices: { compose: { env: { LD_PRELOAD: /tmp/x.so } } }\n",
		"env NODE_OPTIONS":   "version: 1\nservices: { compose: { env: { NODE_OPTIONS: --require=/tmp/x.js } } }\n",
		"env PATH":           "version: 1\nservices: { compose: { env: { PATH: /tmp } } }\n",
		"env COMPOSE_":       "version: 1\nservices: { compose: { env: { COMPOSE_PROFILES: all } } }\n",
		"env DOCKER_":        "version: 1\nservices: { compose: { env: { DOCKER_HOST: tcp://x:2375 } } }\n",
		"env lowercase":      "version: 1\nservices: { compose: { env: { dyld_insert_libraries: x } } }\n",
		"compose outside":    "version: 1\nservices: { compose: { files: [../x.yml] } }\n",
		"too many files":     "version: 1\nservices: { compose: { files: [a,b,c,d,e,f,g,h,i] } }\n",
		"seed sql outside":   "version: 1\ndata: { seed: { service: db, sql: /etc/x.sql } }\n",
		"bad reset":          "version: 1\ndata: { reset: restore }\n",
		"bad duration":       "version: 1\nservices: { compose: { health_timeout: soon } }\n",
		"negative seconds":   "version: 1\nservices: { compose: { health_timeout: -30 } }\n",
		"negative duration":  "version: 1\nservices: { compose: { health_timeout: -5m } }\n",
		"seconds overflow":   "version: 1\nservices: { compose: { health_timeout: 9223372037 } }\n",
		"file and files":     "version: 1\nservices: { compose: { file: a.yml, files: [b.yml] } }\n",
		"file outside":       "version: 1\nservices: { compose: { file: ../a.yml } }\n",
		"public_port, list":  "version: 1\nservices: { compose: { public: [a, b], public_port: 80 } }\n",
		"public_port bad":    "version: 1\nservices: { compose: { public: a, public_port: 70000 } }\n",
		"public twice":       "version: 1\nservices: { compose: { public: [a, a] } }\n",
		"public a mapping":   "version: 1\nservices: { compose: { public: { a: 1 } } }\n",
		"bad profile":        "version: 1\nservices: { compose: { profiles: [\"-x\"] } }\n",
		"health not path-y":  "version: 1\nservices: { compose: { public: web, health: \"/a b\" }, expose: [ { service: web, port: 80, kind: http } ] }\n",
		"runo expose typo":   "version: 1\nexpsoe: { mode: https }\n",
	}
	for name, y := range bad {
		if _, err := Parse([]byte(y)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// A fix's test value (catalog.ts testValueFor) may sit under a name that
// looks like a secret; a real-looking value never may, whatever the name.
func TestParseTakesKodusTestValuesUnderSecretNames(t *testing.T) {
	r, err := Parse([]byte("version: 1\nservices: { compose: { env: { SESSION_SECRET: kodus-test-value, STRIPE_API_URL: \"http://kodus-fake.invalid\", API_TOKEN: \"http://kodus-fake.invalid\" } } }\n"))
	if err != nil || r.Services.Compose.Env["SESSION_SECRET"] != "kodus-test-value" {
		t.Fatalf("%+v %v", r, err)
	}
	if _, err := Parse([]byte("version: 1\nservices: { compose: { env: { X: \"kodus-test-value ghp_abcdefghijklmnopqrstuvwxyz0123\" } } }\n")); err == nil {
		t.Fatal("a real-looking token is refused even beside the marker")
	}
}

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	if r, err := Load(dir); r != nil || err != nil {
		t.Fatalf("a checkout without a recipe: %v %v", r, err)
	}
	if err := os.MkdirAll(filepath.Join(dir, ".kodus"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, Path), []byte(sample), 0o600); err != nil {
		t.Fatal(err)
	}
	if r, err := Load(dir); err != nil || r.Services.Compose.Primary() != "web" {
		t.Fatalf("load %+v %v", r, err)
	}
}

// "..seed.sql" is a file in the repo, not its parent: the lexical prefix
// check refused it.
func TestInsideRepoIsPathAware(t *testing.T) {
	if err := insideRepo("f", "..seed.sql"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"../x", "/etc/x", "a/../../x", ""} {
		if insideRepo("f", bad) == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestResetStrategies(t *testing.T) {
	for in, want := range map[string]string{"": ResetRecreate, "recreate": ResetRecreate, "reseed": ResetReseed, "snapshot": ResetSnapshot} {
		r, err := Parse([]byte("version: 1\ndata: { reset: \"" + in + "\" }\n"))
		if err != nil {
			t.Fatalf("%q: %v", in, err)
		}
		if got := r.ResetStrategy(); got != want {
			t.Errorf("%q: %s, want %s", in, got, want)
		}
	}
}

// TestZeroHealthTimeoutIsUnset: recipes written before durations were
// checked say health_timeout: 0 for "the default"; they must still boot,
// with the default wait, not be refused after a deploy.
func TestZeroHealthTimeoutIsUnset(t *testing.T) {
	for _, v := range []string{"0", "0s", "0m"} {
		r, err := Parse([]byte("version: 1\nservices: { compose: { health_timeout: " + v + " } }\n"))
		if err != nil {
			t.Fatalf("%s: %v", v, err)
		}
		if got := r.HealthTimeout(); got != DefaultHealthTimeout {
			t.Errorf("%s: health timeout %s, want the default %s", v, got, DefaultHealthTimeout)
		}
	}
}

// The keys no cell acts on are named, so the product can say so; services.needs
// (refused) and Runo's top-level expose are not among them. Legacy
// limits.instance remains explicitly unapplied.
func TestUnappliedNamesWhatNoCellActsOn(t *testing.T) {
	r, err := Parse([]byte(`version: 1
validate: [{ name: lint, run: npm run lint }]
limits: { instance: t3.xlarge }
expose: { mode: https }
size: large
fakes: { stripe: true }
flags: { NEW_CHECKOUT: true }
llm: { provider: fake }
egress: { allow: [api.stripe.com] }
ui: { login: /login }
`))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := r.Unapplied(), []string{"flags", "llm", "ui", "limits.instance"}; !slices.Equal(got, want) {
		t.Fatalf("unapplied %v, want %v", got, want)
	}
	if r.HasBootSteps() {
		t.Fatal("a recipe with no setup, migrate or seed has boot steps")
	}
	r, _ = Parse([]byte("version: 1\nsetup: [make]\n"))
	if len(r.Unapplied()) != 0 || !r.HasBootSteps() {
		t.Fatalf("setup only: unapplied %v, steps %v", r.Unapplied(), r.HasBootSteps())
	}
	r, _ = Parse([]byte("version: 1\ndata: { migrate: npm run migrate }\n"))
	if !r.HasBootSteps() {
		t.Fatal("data.migrate is a boot step")
	}
}
