package compose

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeFiles(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func mustYAML(t *testing.T, y string) *Project {
	t.Helper()
	p, err := FromYAML([]byte(y))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// The recipe can name several compose files (kodus-ai: dev + an overlay);
// they lay over each other in order like `docker compose -f a -f b`.
func TestLoadLaysFilesOverEachOtherInOrder(t *testing.T) {
	dir := writeFiles(t, map[string]string{
		"docker-compose.dev.yml": `
services:
  api:
    image: api:dev
    command: ["node", "dev.js"]
    environment: { MODE: dev, PORT: "3001" }
    depends_on: [db]
  db:
    image: postgres:16
volumes:
  data: {}
`,
		"docker-compose.billing.yml": `
services:
  api:
    command: ["node", "billing.js"]
    environment: { BILLING: "on" }
    depends_on: [db, stripe]
  stripe:
    image: stripe-mock:latest
`,
	})
	p, err := Load(dir, []string{"docker-compose.dev.yml", "docker-compose.billing.yml"})
	if err != nil {
		t.Fatal(err)
	}
	if got := p.ServiceNames(); !reflect.DeepEqual(got, []string{"api", "db", "stripe"}) {
		t.Fatalf("services %v", got)
	}
	api := p.Service("api")
	if api["image"] != "api:dev" {
		t.Errorf("image %v: a key only the first file has stays", api["image"])
	}
	if !reflect.DeepEqual(api["command"], []any{"node", "billing.js"}) {
		t.Errorf("command %v: the later file wins", api["command"])
	}
	if !reflect.DeepEqual(api["environment"], map[string]any{"MODE": "dev", "PORT": "3001", "BILLING": "on"}) {
		t.Errorf("environment %v: maps merge", api["environment"])
	}
	if !reflect.DeepEqual(api["depends_on"], []any{"db", "stripe"}) {
		t.Errorf("depends_on %v: lists add up without repeats", api["depends_on"])
	}
	if _, ok := p.doc["volumes"].(map[string]any)["data"]; !ok {
		t.Error("top-level volumes lost")
	}
}

func TestLoadFindsTheDefaultFileOrSaysThereIsNone(t *testing.T) {
	dir := writeFiles(t, map[string]string{"docker-compose.yml": "services: { a: { image: x } }\n", "compose.yaml": "services: { b: { image: y } }\n"})
	if p, err := Load(dir, nil); err != nil || !reflect.DeepEqual(p.ServiceNames(), []string{"b"}) {
		t.Fatalf("compose.yaml comes first, as in docker compose: %v %v", p, err)
	}
	if _, err := Load(t.TempDir(), nil); !errors.Is(err, ErrNoComposeFile) {
		t.Fatalf("empty checkout: %v", err)
	}
	if _, err := Load(dir, []string{"docker-compose.yml", "missing.yml"}); err == nil {
		t.Fatal("a recipe file that is not there was skipped")
	}
}

func TestPublishOnLoopbackReplacesTheCheckoutBindings(t *testing.T) {
	p := mustYAML(t, `services:
  web: { image: w, ports: ["0.0.0.0:8080:8080", "9229:9229"] }
  db: { image: d, ports: ["5432:5432"] }
`)
	got, err := p.PublishOnLoopback([]Port{{Service: "web", Port: 8080}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []PublishedPort{{Port: Port{Service: "web", Port: 8080}, ComposeService: "web"}}) {
		t.Fatalf("published %+v", got)
	}
	if !reflect.DeepEqual(p.Service("web")["ports"], []any{"127.0.0.1::8080"}) || p.Service("db")["ports"] != nil {
		t.Fatalf("web %v db %v", p.Service("web")["ports"], p.Service("db")["ports"])
	}
	if _, err := p.PublishOnLoopback([]Port{{Service: "nope", Port: 80}}); err == nil {
		t.Fatal("unknown service accepted")
	}
	single := SingleService("app")
	if got, err := single.PublishOnLoopback([]Port{{Port: 3000}}); err != nil || got[0].ComposeService != "app" {
		t.Fatalf("no service name means the only one: %+v %v", got, err)
	}
}

func TestAddLabelsRefusesReservedOnes(t *testing.T) {
	p := mustYAML(t, "services: { web: { image: w, labels: [\"team=shop\"] }, db: }\n")
	if err := p.AddLabels(map[string]string{"kodus.cell": "c"}, "kodus."); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(p.Service("web")["labels"], map[string]any{"team": "shop", "kodus.cell": "c"}) {
		t.Fatalf("labels %v", p.Service("web")["labels"])
	}
	if p.Service("db")["labels"] == nil {
		t.Fatal("a null service gets the labels too")
	}
	forged := mustYAML(t, "services: { web: { labels: { kodus.expires: '2099-01-01T00:00:00Z' } } }\n")
	if err := forged.AddLabels(nil, "kodus."); err == nil {
		t.Fatal("a checkout label could forge kodus:expires")
	}
}

func TestAddEnvironmentReachesEveryServiceAndWins(t *testing.T) {
	p := mustYAML(t, "services: { app: { image: a, environment: { DATABASE_URL: pg, SESSION_SECRET: '${SESSION_SECRET}' } }, worker: { environment: [\"QUEUE=q\", \"HOME\"] }, db: }\n")
	if err := p.AddEnvironment(map[string]string{"SESSION_SECRET": "kodus-test-value", "PRICE": "$5"}); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"DATABASE_URL": "pg", "SESSION_SECRET": "kodus-test-value", "PRICE": "$$5"}
	if !reflect.DeepEqual(p.Service("app")["environment"], want) {
		t.Fatalf("app %v", p.Service("app")["environment"])
	}
	want = map[string]any{"QUEUE": "q", "HOME": nil, "SESSION_SECRET": "kodus-test-value", "PRICE": "$$5"}
	if !reflect.DeepEqual(p.Service("worker")["environment"], want) {
		t.Fatalf("worker %v", p.Service("worker")["environment"])
	}
	if p.Service("db")["environment"] == nil {
		t.Fatal("a null service gets the env too")
	}
	untouched := mustYAML(t, "services: { app: { image: a } }\n")
	if err := untouched.AddEnvironment(nil); err != nil || untouched.Service("app")["environment"] != nil {
		t.Fatalf("no recipe env adds nothing: %v %v", untouched.Service("app"), err)
	}
	bad := mustYAML(t, "services: { app: { environment: 3 } }\n")
	if err := bad.AddEnvironment(map[string]string{"A": "b"}); err == nil {
		t.Fatal("an environment that is not a mapping or a list is refused")
	}
}

func TestDropContainerNames(t *testing.T) {
	p := mustYAML(t, "services: { web: { image: w, container_name: kodus_api } }\n")
	if err := p.DropContainerNames(); err != nil || p.Service("web")["container_name"] != nil {
		t.Fatalf("%v %v", p.Service("web"), err)
	}
}

// kodus-ai builds one image for api, worker and webhooks under a fixed tag.
// In a cell each project builds it once, under its own name.
func TestNameBuiltImagesAfterProject(t *testing.T) {
	p := mustYAML(t, `services:
  api:     { build: { context: . }, image: "kodus-ai-dev:latest" }
  worker:  { build: { context: . }, image: "kodus-ai-dev:latest" }
  webhook: { build: { context: . }, image: "kodus-ai-dev:latest" }
  runner:  { image: "kodus-ai-dev:latest" }
  broker:  { build: { context: ./docker/rabbitMQ } }
  db:      { image: "postgres:16" }
`)
	pull, err := p.NameBuiltImagesAfterProject("kodus-c1-workload")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(pull, []string{"db"}) {
		t.Errorf("pull %v: only the registry image", pull)
	}
	if api := p.Service("api"); api["build"] == nil || api["image"] != nil {
		t.Errorf("api builds under the name compose gives it: %v", api)
	}
	for _, n := range []string{"runner", "webhook", "worker"} {
		if s := p.Service(n); s["build"] != nil || s["image"] != BuiltImageName("kodus-c1-workload", "api") {
			t.Errorf("%s runs the image api built: %v", n, s)
		}
	}
	if b := p.Service("broker"); b["build"] == nil || b["image"] != nil {
		t.Errorf("an untagged build is left alone: %v", b)
	}
	if _, err := mustYAML(t, "services: { a: { build: ., image: x } }\n").NameBuiltImagesAfterProject(""); err == nil {
		t.Error("a built image named without a project")
	}
}

func TestMakeExternalNetworksPrivate(t *testing.T) {
	p := mustYAML(t, `services: { a: { image: x, networks: [backend] } }
networks:
  backend: { external: true, name: kodus-backend-services }
  own: {}
`)
	p.MakeExternalNetworksPrivate()
	nets := p.doc["networks"].(map[string]any)
	if !reflect.DeepEqual(nets["backend"], map[string]any{}) || !reflect.DeepEqual(nets["own"], map[string]any{}) {
		t.Fatalf("networks %v", nets)
	}
}

func TestAServiceThatIsNotAMappingIsRefused(t *testing.T) {
	p := mustYAML(t, "services: { web: [1, 2] }\n")
	if err := p.DropContainerNames(); err == nil {
		t.Fatal("accepted")
	}
	if _, err := mustYAML(t, "{}\n").PublishOnLoopback(nil); err == nil {
		t.Fatal("a project with no services")
	}
}

func TestMakeExternalVolumesPrivate(t *testing.T) {
	p, err := FromYAML([]byte("services: {a: {image: x}}\nvolumes:\n  pg: {external: true, name: shared_pg}\n  data: {name: fixed}\n  plain: {}\n"))
	if err != nil {
		t.Fatal(err)
	}
	p.MakeExternalVolumesPrivate()
	out, _ := p.Marshal()
	if strings.Contains(string(out), "external") || strings.Contains(string(out), "shared_pg") || strings.Contains(string(out), "fixed") {
		t.Fatalf("%s", out)
	}
}

// A later file can take a service's binds away (!override) or drop a key
// (!reset), as docker compose -f a -f b does; the overlay only appended.
func TestOverlayHonoursResetAndOverride(t *testing.T) {
	dir := writeFiles(t, map[string]string{
		"a.yml": "x-app: &app\n  volumes: [\".:/src\", \"cache:/cache\"]\n  command: dev\nservices:\n  api:\n    <<: *app\n    ports: [\"3000:3000\"]\n  worker:\n    <<: *app\nvolumes:\n  cache: {}\n  data: {}\n",
		"b.yml": "services:\n  api:\n    volumes: !override [\"data:/data\"]\n    ports: !reset []\n  worker:\n    volumes: !reset []\n    command: prod\n",
	})
	p, err := Load(dir, []string{"a.yml", "b.yml"})
	if err != nil {
		t.Fatal(err)
	}
	api, worker := p.Service("api"), p.Service("worker")
	if !reflect.DeepEqual(api["volumes"], []any{"data:/data"}) {
		t.Fatalf("api volumes %v", api["volumes"])
	}
	if _, ok := api["ports"]; ok {
		t.Fatalf("api ports %v", api["ports"])
	}
	if _, ok := worker["volumes"]; ok || worker["command"] != "prod" {
		t.Fatalf("worker %v", worker)
	}
	out, _ := p.Marshal()
	if strings.Contains(string(out), "kodus-reset") || strings.Contains(string(out), "kodus-override") {
		t.Fatalf("markers left: %s", out)
	}
	if got := p.NamedVolumes(); !reflect.DeepEqual(got, map[string][]string{"api": {"data"}}) {
		t.Fatalf("named volumes %v", got)
	}
	if _, err := Load(writeFiles(t, map[string]string{"compose.yaml": "services: {a: !custom {}}\n"}), nil); err == nil {
		t.Fatal("unknown tag accepted")
	}
}

func TestNamedVolumesSkipProfiledServicesAndBinds(t *testing.T) {
	p, _ := FromYAML([]byte("services:\n  db: {image: pg, volumes: [\"pg:/var/lib/pg\", \"./init:/init\", {type: volume, source: wal, target: /wal}]}\n  web: {image: w, profiles: [off], volumes: [\"cache:/c\"]}\nvolumes: {pg: {}, wal: {}, cache: {}}\n"))
	if got := p.NamedVolumes(); !reflect.DeepEqual(got, map[string][]string{"db": {"pg", "wal"}}) {
		t.Fatalf("%v", got)
	}
}
