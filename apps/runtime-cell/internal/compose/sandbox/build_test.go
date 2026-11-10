package sandbox

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"go.yaml.in/yaml/v3"
)

func withDockerfile(t *testing.T) string {
	t.Helper()
	dir := checkout(t)
	if err := os.WriteFile(filepath.Join(dir, "src", "Dockerfile"), []byte("FROM alpine:3.20\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestBuildsReadsWhatTheCellBuilds(t *testing.T) {
	dir := withDockerfile(t)
	compose := "services:\n  api:\n    build:\n      context: ./src\n      target: runtime\n      args: {NODE_ENV: production}\n  db:\n    image: postgres:16\n"
	bs, err := Builds([]byte(compose), opts(dir))
	if err != nil {
		t.Fatal(err)
	}
	src, _ := filepath.EvalSymlinks(filepath.Join(dir, "src"))
	if len(bs) != 1 || bs[0].Service != "api" || bs[0].Context != src || bs[0].Dockerfile != "Dockerfile" || bs[0].Target != "runtime" || bs[0].Args["NODE_ENV"] != "production" {
		t.Fatalf("builds %+v", bs)
	}
}

// A build reaches only the checkout: no remote context, nothing outside it,
// nothing that brings in the host (ssh, secrets, caches, contexts).
func TestBuildsRefusesWhatReachesOutside(t *testing.T) {
	dir := withDockerfile(t)
	cases := map[string]string{
		"remote context":      "build: https://evil.example/repo.git",
		"git context":         "build: git@github.com:evil/repo.git",
		"context outside":     "build: ../",
		"dockerfile outside":  "build: {context: ./src, dockerfile: ../../etc/passwd}",
		"no dockerfile":       "build: {context: ./src, dockerfile: Missing}",
		"ssh":                 "build: {context: ./src, ssh: [default]}",
		"secrets":             "build: {context: ./src, secrets: [npmrc]}",
		"cache from":          "build: {context: ./src, cache_from: [\"type=local,src=/var/lib\"]}",
		"additional contexts": "build: {context: ./src, additional_contexts: {x: /etc}}",
		"network":             "build: {context: ./src, network: host}",
		"interpolated arg":    "build: {context: ./src, args: {TOKEN: $TOKEN}}",
		"bad target":          "build: {context: ./src, target: \"a b\"}",
	}
	for name, b := range cases {
		var re *RefusedError
		if _, err := Builds([]byte("services:\n  api:\n    "+b+"\n"), opts(dir)); !errors.As(err, &re) {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
}

func TestABuiltServiceRunsTheCellsImageAndNothingElse(t *testing.T) {
	dir := withDockerfile(t)
	o := opts(dir)
	compose := "services:\n  api:\n    build: ./src\n"
	var re *RefusedError
	if _, err := Apply([]byte(compose), o); !errors.As(err, &re) {
		t.Fatalf("a build the cell did not run was accepted: %v", err)
	}
	o.Built = map[string]string{"api": "kodus-build/claim-1-api:1"}
	out, err := Apply([]byte(compose), o)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	_ = yaml.Unmarshal(out, &doc)
	api := doc["services"].(map[string]any)["api"].(map[string]any)
	if api["build"] != nil || api["image"] != "kodus-build/claim-1-api:1" || api["pull_policy"] != "never" {
		t.Fatalf("api %v", api)
	}
}
