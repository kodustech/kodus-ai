package kube

import (
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
)

var update = flag.Bool("update", false, "rewrite the golden files")

func checkout() fstest.MapFS {
	return fstest.MapFS{
		".env.app":            {Data: []byte("NODE_ENV=production\n# a comment\nexport LOG_LEVEL=\"debug\"\nGREETING='hi $there'\nPORT=4000 # inline\n")},
		"db/init.sql":         {Data: []byte("create table t(id int);\n")},
		"db/conf/tune.conf":   {Data: []byte("max_connections = 50\n")},
		"db/conf/extra.conf":  {Data: []byte("shared_buffers = 64MB\n")},
		"scripts/entry.sh":    {Data: []byte("#!/bin/sh\n"), Mode: 0o755},
		"README.md":           {Data: []byte("hello\n")},
		"src/server/index.js": {Data: []byte("1\n")},
	}
}

func opts() Options {
	return Options{
		Namespace: "kodus-runtime-environments", Prefix: "env-claim-1",
		Labels:       map[string]string{"kodus.io/cell": "cell-a", "kodus.io/org": "org-1", "kodus.io/claim": "claim-1", "kodus.io/role": "workload"},
		Selector:     map[string]string{"kodus.io/cell": "cell-a", "kodus.io/claim": "claim-1"},
		Annotations:  map[string]string{"kodus.io/hard-expires": "2026-11-17T12:00:00Z"},
		Side:         "pr",
		RuntimeClass: "gvisor", HelperImage: "registry.example/kodus-helper@sha256:0000000000000000000000000000000000000000000000000000000000000000",
		Size: Size{MemoryMB: 2048, CPUs: 2}, DeadlineSeconds: 3600,
		Nameservers: []string{"10.96.12.34"},
		Egress: []EgressPeer{{
			NamespaceLabels: map[string]string{"kubernetes.io/metadata.name": "kodus-runtime"},
			PodLabels:       map[string]string{"app.kubernetes.io/component": "cell"},
			Ports:           []Port{{Protocol: "UDP", Port: 5353}, {Protocol: "TCP", Port: 5353}, {Port: 8080}, {Port: 8443}},
		}},
		Checkout: checkout(),
	}
}

// golden is what a test compares: the plan's services as the driver reads
// them, and every object, as YAML.
func golden(t *testing.T, p *Plan) []byte {
	t.Helper()
	type svc struct {
		Name, PodName, Container string
		Wave                     int
		DependsOn                []Dependency `yaml:",omitempty"`
		Hostnames                []string
		Hostname                 string `yaml:",omitempty"`
		Healthcheck              bool
		WorkingDir               string      `yaml:",omitempty"`
		Data                     []DataMount `yaml:",omitempty"`
		Copies                   []Copy      `yaml:",omitempty"`
	}
	var services []svc
	for _, s := range p.Services {
		services = append(services, svc{s.Name, s.PodName, s.Container, s.Wave, s.DependsOn, s.Hostnames, s.Hostname, s.Healthcheck, s.WorkingDir, s.Data, s.Copies})
	}
	var ignored []string
	for _, v := range p.Ignored {
		ignored = append(ignored, v.String())
	}
	out, err := yaml.Marshal(map[string]any{"services": services, "ignored": ignored, "objects": p.Objects()})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// Each representative compose file renders to the objects in its golden
// file: one pod per service on the RuntimeClass with the claim's labels, a
// claim per named volume, and the claim's NetworkPolicy.
func TestRenderMatchesTheGoldenFiles(t *testing.T) {
	for _, name := range []string{"single", "app-postgres-redis", "volumes", "ports", "build"} {
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("testdata", name+".compose.yaml"))
			if err != nil {
				t.Fatal(err)
			}
			o := opts()
			if name == "build" {
				o.Built = map[string]string{"api": builtAPI}
			}
			p, err := Render(raw, o)
			if err != nil {
				t.Fatal(err)
			}
			got := golden(t, p)
			file := filepath.Join("testdata", name+".golden.yaml")
			if *update {
				if err := os.WriteFile(file, got, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(file)
			if err != nil {
				t.Fatalf("%v (run with -update to write it)", err)
			}
			if string(got) != string(want) {
				t.Errorf("render differs from %s (run with -update and read the diff):\n%s", file, got)
			}
		})
	}
}

// builtAPI is the image the builder pushed for the build golden's api, as
// the nodes pull it: by digest.
const builtAPI = "registry.kodus-runtime.svc:5000/kodus-build/claim-1/api@sha256:1111111111111111111111111111111111111111111111111111111111111111"

// A service with a build section runs the image the builder made for it,
// pulled by digest, with everything else the file says; the builder's pod
// is rootless BuildKit on the claim's RuntimeClass with the claim's labels
// in the builder's role, its whole size and deadline, and the build policy
// selects only the claim's builder pods.
func TestTheBuilderPodAndPolicyMatchTheirGoldenFile(t *testing.T) {
	b, err := BuilderPod(opts(), BuildPod{Service: "api", Image: "registry.example/kodus-runtime-builder@sha256:2222222222222222222222222222222222222222222222222222222222222222"})
	if err != nil {
		t.Fatal(err)
	}
	if b.PodName != "env-claim-1--build-api" {
		t.Errorf("pod name %q", b.PodName)
	}
	pol := BuildPolicy(opts(), []EgressPeer{{CIDR: "10.96.0.50/32", Ports: []Port{{Port: 5000}}}})
	got, err := yaml.Marshal(map[string]any{"builder": b.Pod, "policy": pol})
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join("testdata", "builder.golden.yaml")
	if *update {
		if err := os.WriteFile(file, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(file)
	if err != nil || string(got) != string(want) {
		t.Errorf("builder differs from %s (run with -update and read the diff): %v\n%s", file, err, got)
	}
	if BuildPolicy(opts(), nil) != nil {
		t.Error("a build policy with no peer")
	}
	if _, err := BuilderPod(opts(), BuildPod{Service: "api"}); err == nil {
		t.Error("a builder pod with no image")
	}
}

func render(t *testing.T, compose string) *Plan {
	t.Helper()
	p, err := Render([]byte(compose), opts())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func service(p *Plan, name string) Service {
	for _, s := range p.Services {
		if s.Name == name {
			return s
		}
	}
	return Service{}
}

func spec(s Service) map[string]any      { return s.Pod["spec"].(map[string]any) }
func container(s Service) map[string]any { return spec(s)["containers"].([]any)[0].(map[string]any) }
func initContainer(s Service) map[string]any {
	return spec(s)["initContainers"].([]any)[0].(map[string]any)
}

// Every pod is isolated whatever the file says: the RuntimeClass, no token,
// no host namespaces, no privilege or escalation, the safe capabilities
// only, RuntimeDefault seccomp, the cell's resolver, the claim's deadline,
// and the gate before the service starts.
func TestEveryPodIsIsolatedAndGated(t *testing.T) {
	p := render(t, "services:\n  a:\n    image: busybox\n  b:\n    image: busybox\n    cap_drop: [NET_BIND_SERVICE]\n")
	for _, s := range p.Services {
		sp := spec(s)
		for k, want := range map[string]any{"runtimeClassName": "gvisor", "automountServiceAccountToken": false, "enableServiceLinks": false,
			"hostNetwork": false, "hostPID": false, "hostIPC": false, "dnsPolicy": "None", "activeDeadlineSeconds": int64(3600)} {
			if sp[k] != want {
				t.Errorf("%s: %s = %v, want %v", s.Name, k, sp[k], want)
			}
		}
		if sp["securityContext"].(map[string]any)["seccompProfile"].(map[string]any)["type"] != "RuntimeDefault" {
			t.Errorf("%s: seccomp", s.Name)
		}
		sec := container(s)["securityContext"].(map[string]any)
		if sec["privileged"] != false || sec["allowPrivilegeEscalation"] != false {
			t.Errorf("%s: %v", s.Name, sec)
		}
		caps := sec["capabilities"].(map[string]any)
		if caps["drop"].([]any)[0] != "ALL" {
			t.Errorf("%s: caps %v", s.Name, caps)
		}
		for _, c := range caps["add"].([]any) {
			if !strings.Contains(strings.Join(sandbox.ServiceCaps, ","), c.(string)) {
				t.Errorf("%s: adds %v", s.Name, c)
			}
		}
		res := container(s)["resources"].(map[string]any)
		if res["limits"].(map[string]any)["memory"] != res["requests"].(map[string]any)["memory"] {
			t.Errorf("%s: requests differ from limits", s.Name)
		}
		if initContainer(s)["name"] != InitContainer || initContainer(s)["command"].([]any)[2] != GateWait {
			t.Errorf("%s: no gate", s.Name)
		}
	}
	for _, c := range container(service(p, "b"))["securityContext"].(map[string]any)["capabilities"].(map[string]any)["add"].([]any) {
		if c == "NET_BIND_SERVICE" {
			t.Error("cap_drop kept the capability")
		}
	}
}

// The claim's size is shared: a service's own limit comes out first, the
// rest is split evenly, and a file that asks more than the claim is refused.
func TestTheClaimSizeIsSharedBetweenTheServices(t *testing.T) {
	p := render(t, "services:\n  db:\n    image: postgres\n    mem_limit: 1g\n    cpus: 0.5\n  a:\n    image: x\n  b:\n    image: y\n")
	limits := func(n string) map[string]any {
		return container(service(p, n))["resources"].(map[string]any)["limits"].(map[string]any)
	}
	if limits("db")["memory"] != "1024Mi" || limits("db")["cpu"] != "500m" {
		t.Errorf("db %v", limits("db"))
	}
	if limits("a")["memory"] != "512Mi" || limits("a")["cpu"] != "750m" || limits("b")["memory"] != "512Mi" {
		t.Errorf("a %v b %v", limits("a"), limits("b"))
	}
	_, err := Render([]byte("services:\n  db:\n    image: postgres\n    deploy:\n      resources:\n        limits:\n          memory: 3g\n"), opts())
	var refused *sandbox.RefusedError
	if !errors.As(err, &refused) || !strings.Contains(err.Error(), "memory") {
		t.Errorf("3g in a 2 GB claim: %v", err)
	}
}

// Services start after what they depend on; a cycle, an unknown service or
// a wait on an image's own HEALTHCHECK is refused.
func TestStartOrderFollowsDependsOn(t *testing.T) {
	p := render(t, `services:
  web: {image: w, depends_on: [api]}
  api: {image: a, depends_on: {db: {condition: service_healthy}, cache: {condition: service_started}}}
  db: {image: d, healthcheck: {test: [CMD, pg_isready]}}
  cache: {image: c}
`)
	var order []string
	for _, s := range p.Services {
		order = append(order, s.Name)
	}
	if strings.Join(order, ",") != "cache,db,api,web" {
		t.Errorf("order %v", order)
	}
	for compose, want := range map[string]string{
		"services:\n  a: {image: x, depends_on: [b]}\n  b: {image: y, depends_on: [a]}\n":              "a cycle",
		"services:\n  a: {image: x, depends_on: [nope]}\n":                                             "not a service of the project",
		"services:\n  a: {image: x, depends_on: {b: {condition: service_healthy}}}\n  b: {image: y}\n": "image's own",
	} {
		if _, err := Render([]byte(compose), opts()); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %q", compose, err, want)
		}
	}
}

// What no cell runs is refused, every reason at once, as compose/sandbox
// does; a build is the backend's gap (UnsupportedError), not the file's.
func TestWhatTheBackendCannotHonourIsRefusedNotDropped(t *testing.T) {
	refused := map[string]string{
		"privileged: true":                          "services.a.privileged",
		"network_mode: host":                        "services.a.network_mode",
		"pid: host":                                 "services.a.pid",
		"ipc: host":                                 "services.a.ipc",
		"devices: [/dev/kvm]":                       "services.a.devices",
		"cap_add: [SYS_ADMIN]":                      "services.a.cap_add[0]",
		"cap_add: [NET_ADMIN]":                      "services.a.cap_add[0]",
		"security_opt: [seccomp=unconfined]":        "services.a.security_opt",
		"sysctls: {net.ipv4.ip_forward: 1}":         "services.a.sysctls",
		"user: postgres":                            "services.a.user",
		"ulimits: {nofile: 65535}":                  "services.a.ulimits",
		"volumes: [/var/run/docker.sock:/s]":        "services.a.volumes[0]",
		"volumes: [../outside:/o]":                  "services.a.volumes[0]",
		"volumes: [./missing:/m]":                   "services.a.volumes[0]",
		"volumes: [undeclared:/u]":                  "services.a.volumes[0]",
		"volumes: [./README.md:/etc/hosts]":         "services.a.volumes[0]",
		"environment: {A: \"${REQUIRED:?set it}\"}": "services.a.environment.A",
		"environment: {A: $(date)}":                 "services.a.environment.A",
		"stop_signal: SIGINT":                       "services.a.stop_signal",
		"deploy: {replicas: 2}":                     "services.a.deploy.replicas",
		"tty: true":                                 "services.a.tty",
		"some_new_key: 1":                           "services.a.some_new_key",
		"networks: {default: {ipv4_address: x}}":    "services.a.networks.default.ipv4_address",
	}
	for line, path := range refused {
		_, err := Render([]byte("services:\n  a:\n    image: busybox\n    "+line+"\n"), opts())
		var re *sandbox.RefusedError
		if !errors.As(err, &re) {
			t.Errorf("%s: %v, want a RefusedError", line, err)
			continue
		}
		found := false
		for _, v := range re.Violations {
			found = found || v.Path == path
		}
		if !found {
			t.Errorf("%s: %v, want a violation at %s", line, err, path)
		}
	}
	_, err := Render([]byte("services:\n  a:\n    build: .\n    privileged: true\n    cap_add: [SYS_PTRACE]\n"), opts())
	var re *sandbox.RefusedError
	if !errors.As(err, &re) || len(re.Violations) != 2 {
		t.Errorf("every reason at once: %v", err)
	}
	_, err = Render([]byte("services:\n  a:\n    build: .\n"), opts())
	if !errors.Is(err, ErrUnsupported) || !strings.Contains(err.Error(), "builder") {
		t.Errorf("a build with no builder: %v", err)
	}
	built := opts()
	built.Built = map[string]string{"a": "registry.example/built@sha256:1111111111111111111111111111111111111111111111111111111111111111"}
	p, err := Render([]byte("services:\n  a:\n    build: .\n"), built)
	if err != nil || container(service(p, "a"))["image"] != built.Built["a"] {
		t.Errorf("a build the builder made: %v", err)
	}
	if _, err := Render([]byte("services:\n  a: {image: x, volumes: [shared:/s]}\n  b: {image: y, volumes: [shared:/t]}\nvolumes: {shared: {}}\n"), opts()); !errors.Is(err, ErrUnsupported) {
		t.Errorf("a volume two services mount: %v", err)
	}
	if _, err := Render([]byte("services:\n  a:\n    image: x\n    volumes: [./README.md:/r]\n"), func() Options { o := opts(); o.Checkout = nil; return o }()); err == nil {
		t.Error("a bind with no checkout")
	}
}

// Values reach the process as compose would hand them: compose's own
// interpolation with an empty environment, and every '$' escaped from
// Kubernetes' $(VAR) expansion.
func TestValuesAreInterpolatedAsComposeAndNeverExpandedByKubernetes(t *testing.T) {
	p := render(t, "services:\n  a:\n    image: x\n    entrypoint: [\"sh\", \"-c\", \"echo $$HOME $$(id -u)\"]\n    command: run --level ${LEVEL:-info} ${UNSET}\n    environment:\n      A: \"$${B}\"\n      C: ${C-dflt}\n")
	c := container(service(p, "a"))
	// compose reads "$$" as "$"; Kubernetes reads "$$" as "$" again.
	if got := c["command"].([]any)[2]; got != "echo $$HOME $$(id -u)" {
		t.Errorf("entrypoint %q", got)
	}
	if got := c["args"].([]any); len(got) != 3 || got[2] != "info" {
		t.Errorf("args %v", got)
	}
	env := map[string]any{}
	for _, e := range c["env"].([]any) {
		m := e.(map[string]any)
		env[m["name"].(string)] = m["value"]
	}
	if env["A"] != "$${B}" || env["C"] != "dflt" {
		t.Errorf("env %v", env)
	}
}

// The hosts file maps every service's names to its pod's address, the
// pod's own hostname included.
func TestTheHostsFileNamesEveryService(t *testing.T) {
	p := render(t, "services:\n  db:\n    image: d\n    networks: {default: {aliases: [database]}}\n  app:\n    image: a\n    hostname: run-host\n")
	got := string(p.HostsFile(service(p, "app"), map[string]string{"db": "10.0.0.5", "app": "10.0.0.6"}))
	for _, want := range []string{"127.0.0.1\tlocalhost\n", "10.0.0.6\trun-host\n", "10.0.0.5\tdb database\n", "10.0.0.6\tapp\n"} {
		if !strings.Contains(got, want) {
			t.Errorf("hosts file lacks %q:\n%s", want, got)
		}
	}
}

func TestNamesAreDNSLabelsThatNeverMeet(t *testing.T) {
	for _, in := range []string{"web", "My_Service", "a.b", strings.Repeat("x", 80)} {
		s := slug(in, 40)
		if !dnsLabel.MatchString(s) || len(s) > 40 {
			t.Errorf("slug(%q) = %q", in, s)
		}
	}
	if slug("a_b", 40) == slug("a-b", 40) {
		t.Error("two compose names met in one slug")
	}
}
