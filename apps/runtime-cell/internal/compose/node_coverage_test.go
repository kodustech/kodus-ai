package compose

import (
	"testing"
)

func TestAddNodeCoverageAppendsToNodeOptionsOfNodeServicesOnly(t *testing.T) {
	dir := writeFiles(t, map[string]string{"docker-compose.yml": `
services:
  api:
    image: node:22-alpine
    environment: { NODE_OPTIONS: "--max-old-space-size=512" }
  worker:
    image: ghcr.io/acme/node
    environment: ["MODE=worker"]
  db:
    image: postgres:16
`})
	p, err := Load(dir, []string{"docker-compose.yml"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := p.AddNodeCoverage(NodeCoverage{Dir: "/kodus-coverage", Preload: "/kodus-coverage-preload.cjs"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "api" || got[1] != "worker" {
		t.Fatalf("instrumented %v, want [api worker]", got)
	}
	env := func(svc, k string) any { m, _ := environmentMap(p.Service(svc)["environment"]); return m[k] }
	if v := env("api", "NODE_OPTIONS"); v != "--max-old-space-size=512 --require=/kodus-coverage-preload.cjs" {
		t.Fatalf("api NODE_OPTIONS %q: the compose's own options come first, ours appended", v)
	}
	if v := env("worker", "NODE_OPTIONS"); v != "--require=/kodus-coverage-preload.cjs" {
		t.Fatalf("worker NODE_OPTIONS %q", v)
	}
	if v := env("worker", "MODE"); v != "worker" {
		t.Fatalf("worker lost its own env: MODE=%v", v)
	}
	if v := env("api", "NODE_V8_COVERAGE"); v != "/kodus-coverage" {
		t.Fatalf("api NODE_V8_COVERAGE %v", v)
	}
	if v := env("db", "NODE_V8_COVERAGE"); v != nil {
		t.Fatalf("db is not Node, got NODE_V8_COVERAGE %v", v)
	}
	if vols := p.Service("api")["volumes"]; vols != nil {
		t.Fatalf("the driver mounts the coverage files, yet api got mounts %v", vols)
	}
}

func TestIsNodeImage(t *testing.T) {
	for img, want := range map[string]bool{
		"node": true, "node:22-alpine": true, "docker.io/library/node:20": true, "cimg/node:22.1": true,
		"postgres:16": false, "nodered/node-red": false, "": false, "api:dev": false,
	} {
		if got := IsNodeImage(img); got != want {
			t.Errorf("IsNodeImage(%q) = %v, want %v", img, got, want)
		}
	}
}

// A built image is Node when its config says so: Node's own NODE_VERSION,
// or a command that starts with node, npm, npx, pnpm, yarn or tsx (as is,
// or as the first word of a shell's -c). Anything else is not, and gets no
// NODE_OPTIONS.
func TestIsNodeImageConfig(t *testing.T) {
	for name, tc := range map[string]struct {
		cfg  ImageConfig
		want bool
	}{
		"node's NODE_VERSION":            {ImageConfig{Env: []string{"PATH=/usr/bin", "NODE_VERSION=22.11.0"}, Cmd: []string{"docker-entrypoint.sh"}}, true},
		"cmd node":                       {ImageConfig{Cmd: []string{"node", "dist/main.js"}}, true},
		"entrypoint npm by path":         {ImageConfig{Entrypoint: []string{"/usr/local/bin/npm"}, Cmd: []string{"start"}}, true},
		"shell form pnpm":                {ImageConfig{Cmd: []string{"/bin/sh", "-c", "pnpm start"}}, true},
		"shell form exec yarn":           {ImageConfig{Cmd: []string{"sh", "-c", "exec yarn start"}}, true},
		"npx":                            {ImageConfig{Cmd: []string{"npx", "next", "start"}}, true},
		"tsx":                            {ImageConfig{Cmd: []string{"tsx", "src/index.ts"}}, true},
		"python":                         {ImageConfig{Env: []string{"PYTHON_VERSION=3.12"}, Cmd: []string{"python", "app.py"}}, false},
		"an entrypoint script then node": {ImageConfig{Entrypoint: []string{"/entrypoint.sh"}, Cmd: []string{"node", "x.js"}}, false},
		"empty NODE_VERSION":             {ImageConfig{Env: []string{"NODE_VERSION="}}, false},
		"node_exporter":                  {ImageConfig{Cmd: []string{"/bin/sh", "-c", "node_exporter --web"}}, false},
		"nothing":                        {ImageConfig{}, false},
	} {
		if got := IsNodeImageConfig(tc.cfg); got != tc.want {
			t.Errorf("%s: IsNodeImageConfig = %v, want %v", name, got, tc.want)
		}
	}
}

// Services built from a Dockerfile are instrumented by their built image's
// config, after the build: NODE_OPTIONS keeps the service's own, else the
// image's, with the preload appended. The service's command and entrypoint
// are what runs (an entrypoint clears the image's command). A value with
// a $ is left out rather than guessed at (compose would interpolate it).
func TestAddBuiltNodeCoverageInstrumentsBuiltNodeServicesOnly(t *testing.T) {
	p, err := FromYAML([]byte(`
services:
  web:
    build: ./web
    environment: { MODE: web }
  jobs:
    build: ./jobs
    command: ["node", "jobs.js"]
  py:
    build: ./py
  ep:
    build: ./ep
    entrypoint: ["/app/run.sh"]
  dollar:
    build: ./d
  db:
    image: postgres:16
`))
	if err != nil {
		t.Fatal(err)
	}
	node := []string{"NODE_VERSION=22.11.0"}
	got, err := p.AddBuiltNodeCoverage(NodeCoverage{Dir: "/kodus-coverage", Preload: "/p.cjs"}, map[string]ImageConfig{
		"web":    {Env: append(node, "NODE_OPTIONS=--max-old-space-size=512")},
		"jobs":   {Cmd: []string{"python", "x.py"}},
		"py":     {Cmd: []string{"python", "app.py"}},
		"ep":     {Cmd: []string{"node", "x.js"}},
		"dollar": {Env: append(node, "NODE_OPTIONS=--title=$HOSTNAME")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "jobs" || got[1] != "web" {
		t.Fatalf("instrumented %v, want [jobs web]", got)
	}
	env := func(svc, k string) any { m, _ := environmentMap(p.Service(svc)["environment"]); return m[k] }
	if v := env("web", "NODE_OPTIONS"); v != "--max-old-space-size=512 --require=/p.cjs" {
		t.Fatalf("web NODE_OPTIONS %q: the image's options are kept, ours appended", v)
	}
	if v := env("web", "MODE"); v != "web" {
		t.Fatalf("web lost its own env: %v", v)
	}
	if v := env("jobs", "NODE_OPTIONS"); v != "--require=/p.cjs" || env("jobs", "NODE_V8_COVERAGE") != "/kodus-coverage" {
		t.Fatalf("jobs env %v %v", v, env("jobs", "NODE_V8_COVERAGE"))
	}
	for _, svc := range []string{"py", "ep", "dollar", "db"} {
		if env(svc, "NODE_OPTIONS") != nil || env(svc, "NODE_V8_COVERAGE") != nil {
			t.Fatalf("%s is not instrumented, yet got the coverage env", svc)
		}
	}
}

// A service with a build section is decided by its built image, never by
// the name it tags that image with.
func TestAddNodeCoverageLeavesBuiltServicesToTheirImage(t *testing.T) {
	p, err := FromYAML([]byte("services:\n  api:\n    build: .\n    image: acme/node\n"))
	if err != nil {
		t.Fatal(err)
	}
	got, err := p.AddNodeCoverage(NodeCoverage{Dir: "/c", Preload: "/p.cjs"})
	if err != nil || len(got) != 0 {
		t.Fatalf("instrumented %v (%v) by the built image's name", got, err)
	}
}
