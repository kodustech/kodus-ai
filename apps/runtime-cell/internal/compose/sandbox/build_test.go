package sandbox

import (
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
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
		"secret from a file":  "build: {context: ./src, secrets: [npmrc]}\nsecrets:\n  npmrc: {file: /etc/shadow}",
		"secret not a name":   "build: {context: ./src, secrets: [\"a,b\"]}",
		"secret bad id":       "build: {context: ./src, secrets: [{source: NPM_TOKEN, target: \"id=x\"}]}",
		"secret with a mode":  "build: {context: ./src, secrets: [{source: NPM_TOKEN, mode: 0444}]}",
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

// G6: a build asks for the org secrets it reads, in its compose build
// section (a name, a source and target, a top-level entry that names the
// org secret by environment) or in its Dockerfile (RUN
// --mount=type=secret); a build that asks for none has none.
func TestBuildsReadTheSecretsEachBuildAsksFor(t *testing.T) {
	dir := withDockerfile(t)
	df := "FROM node:22-alpine\n" +
		"RUN --mount=type=secret,id=SENTRY_AUTH,env=SENTRY_AUTH \\\n  --mount=type=cache,target=/root/.npm npm ci\n" +
		"RUN --mount=type=secret,target=/run/secrets/GH_TOKEN true\n" +
		"RUN --mount=type=secret,id=NPM_AUTH cat /run/secrets/NPM_AUTH\n"
	if err := os.MkdirAll(filepath.Join(dir, "web"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "web", "Dockerfile"), []byte(df), 0o644); err != nil {
		t.Fatal(err)
	}
	compose := `
services:
  api:
    build: {context: ./src, secrets: [NPM_TOKEN, {source: npm, target: NPM_AUTH}]}
  web:
    build: {context: ./web, secrets: [{source: npm, target: NPM_AUTH}]}
  worker:
    build: ./src
secrets:
  npm: {environment: NPM_TOKEN}
`
	bs, err := Builds([]byte(compose), opts(dir))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]map[string]string{}
	for _, b := range bs {
		got[b.Service] = b.Secrets
	}
	want := map[string]map[string]string{
		"api":    {"NPM_TOKEN": "NPM_TOKEN", "NPM_AUTH": "NPM_TOKEN"},
		"web":    {"NPM_AUTH": "NPM_TOKEN", "SENTRY_AUTH": "SENTRY_AUTH", "GH_TOKEN": "GH_TOKEN"},
		"worker": {},
	}
	for svc, w := range want {
		if !maps.Equal(got[svc], w) {
			t.Errorf("%s asked for %v, want %v", svc, got[svc], w)
		}
	}
}

func TestDockerfileSecretIDs(t *testing.T) {
	df := `# syntax=docker/dockerfile:1
FROM alpine
RUN --mount=type=secret,id=A true
RUN --mount="type=secret,id=B,required=true" true
RUN --mount=type=secret,dst=/x/C true
RUN --mount=type=secret,env=D true
RUN --mount=type=secret,id=$ARG true
RUN --mount=type=bind,source=E,target=/e true
RUN --mount=type=secret,id=A true
`
	if got := DockerfileSecretIDs(df); !slices.Equal(got, []string{"A", "B", "C", "D"}) {
		t.Fatalf("ids %v", got)
	}
}

// The top-level secrets a build reads leave the file the cell runs; a
// service still never mounts one.
func TestTopLevelSecretsLeaveTheFileAndServicesNeverMountThem(t *testing.T) {
	dir := withDockerfile(t)
	o := opts(dir)
	o.Built = map[string]string{"api": "kodus-build/claim-1-api:1"}
	compose := "services:\n  api:\n    build: {context: ./src, secrets: [npm]}\nsecrets:\n  npm: {environment: NPM_TOKEN}\n"
	out, err := Apply([]byte(compose), o)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	if _, ok := doc["secrets"]; ok {
		t.Fatalf("top-level secrets kept:\n%s", out)
	}
	mounted := compose + "  other: {environment: X}\n"
	mounted = strings.Replace(mounted, "services:\n", "services:\n  db:\n    image: postgres:16\n    secrets: [npm]\n", 1)
	var re *RefusedError
	if _, err := Apply([]byte(mounted), o); !errors.As(err, &re) {
		t.Fatalf("a service's secrets accepted: %v", err)
	}
	err = VerifyCanonical([]byte(`{"services":{},"secrets":{"npm":{"environment":"NPM_TOKEN"}}}`), o)
	if !errors.As(err, &re) || !slices.ContainsFunc(re.Violations, func(v Violation) bool { return v.Path == "secrets" }) {
		t.Fatalf("canonical file with secrets: %v", err)
	}
}

// F3-07: a null build arg (args: {FOO: }) became the string "<nil>", so
// ARG FOO=default built with FOO=<nil>. It is left out, as compose leaves
// it unset and the Dockerfile's default applies.
func TestANullBuildArgIsLeftUnset(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM scratch\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bs, err := Builds([]byte("services:\n  api:\n    build:\n      context: .\n      args: {FOO: , BAR: x}\n"), Options{ProjectDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if v, set := bs[0].Args["FOO"]; set || bs[0].Args["BAR"] != "x" {
		t.Fatalf("args %v (FOO %q set %v)", bs[0].Args, v, set)
	}
}
