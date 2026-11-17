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
