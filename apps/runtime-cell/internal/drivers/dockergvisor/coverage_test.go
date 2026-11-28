package dockergvisor

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
)

// builtUp boots a project of two built services, web and py, whose images
// have the given configs, with a Run's coverage asked; it returns the
// rendered file's services and the machine.
func builtUp(t *testing.T, web, py dockercli.ImageConfig) (map[string]map[string]any, driver.MachineRef, *Driver) {
	t.Helper()
	services, ref, d, _ := builtUpAgain(t, web, py)
	return services, ref, d
}

// builtUpAgain is builtUp, and also returns a second Up of the same machine
// after a reset, asked with the services the claim says are instrumented
// (the agent passes the driver's own list back, coveredAfterUp).
func builtUpAgain(t *testing.T, web, py dockercli.ImageConfig) (map[string]map[string]any, driver.MachineRef, *Driver, func() map[string]map[string]any) {
	t.Helper()
	docker := &requestDocker{memDocker: newMemDocker(), rendered: map[string]string{}, mounts: map[string][]string{}, killed: map[string][]string{}}
	docker.plant(dockercli.Container{ID: "cegress", Name: "kodus-egress", Networks: map[string]string{"kodus-cell": "10.9.0.2"}})
	d, err := New(context.Background(), docker, Config{
		CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(), EgressContainer: "kodus-egress",
		BuilderImage: "kodus-runtime-builder@sha256:abc",
	})
	if err != nil {
		t.Fatal(err)
	}
	recordChowns(d)
	net, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "cov-1"})
	if err != nil {
		t.Fatal(err)
	}
	s := drivertest.BaseSpec("cell-1", "cov-1", net)
	s.ExpiresAt, s.HardExpiresAt = time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
	ref, err := d.Create(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for _, svc := range []string{"web", "py"} {
		if err := os.MkdirAll(filepath.Join(dir, svc), 0o755); err != nil {
			t.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(dir, svc, "Dockerfile"), []byte("FROM x\n"), 0o644)
	}
	docker.mu.Lock()
	docker.imageConfigs = map[string]dockercli.ImageConfig{builtTag(ref.MachineID, "web"): web, builtTag(ref.MachineID, "py"): py}
	docker.mu.Unlock()
	preload := filepath.Join(t.TempDir(), "coverage-preload.cjs")
	_ = os.WriteFile(preload, []byte("x"), 0o644)
	covDir := t.TempDir()
	up := func(services []string) map[string]map[string]any {
		t.Helper()
		_, err := d.Up(context.Background(), driver.UpRequest{
			Ref: ref, Compose: []byte("services:\n  web:\n    build: ./web\n  py:\n    build: ./py\n"), ProjectDir: dir,
			Coverage: driver.Coverage{Dir: covDir, Preload: preload, Services: services},
		})
		if err != nil {
			t.Fatal(err)
		}
		docker.mu.Lock()
		file := docker.rendered[ref.MachineID]
		docker.mu.Unlock()
		var doc struct {
			Services map[string]map[string]any `yaml:"services"`
		}
		if err := yaml.Unmarshal([]byte(file), &doc); err != nil {
			t.Fatal(err)
		}
		return doc.Services
	}
	first := up(nil)
	again := func() map[string]map[string]any {
		t.Helper()
		if err := d.Reset(context.Background(), ref, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
			t.Fatal(err)
		}
		return up(d.CoverageServices(ref))
	}
	return first, ref, d, again
}

func coverageMounted(svc map[string]any) bool {
	vols, _ := svc["volumes"].([]any)
	return slices.ContainsFunc(vols, func(v any) bool {
		m, _ := v.(map[string]any)
		return m["target"] == sandbox.CoverageTarget
	})
}

// A service built from a Dockerfile whose image runs Node is instrumented
// after its build (env and mounts) and named as instrumented; a built image
// that does not run Node gets neither.
func TestAnUpInstrumentsAServiceBuiltFromANodeImage(t *testing.T) {
	services, ref, d := builtUp(t,
		dockercli.ImageConfig{Env: []string{"NODE_VERSION=22.11.0", "NODE_OPTIONS=--max-old-space-size=512"}, Cmd: []string{"node", "dist/main.js"}},
		dockercli.ImageConfig{Env: []string{"PYTHON_VERSION=3.12"}, Cmd: []string{"python", "app.py"}})
	env := func(svc, k string) any { m, _ := services[svc]["environment"].(map[string]any); return m[k] }
	if env("web", "NODE_V8_COVERAGE") != sandbox.CoverageTarget || env("web", "NODE_OPTIONS") != "--max-old-space-size=512 --require="+sandbox.CoveragePreloadTarget {
		t.Fatalf("web env %v", services["web"]["environment"])
	}
	if !coverageMounted(services["web"]) {
		t.Fatalf("web has no coverage mount: %v", services["web"]["volumes"])
	}
	if env("py", "NODE_OPTIONS") != nil || env("py", "NODE_V8_COVERAGE") != nil || coverageMounted(services["py"]) {
		t.Fatalf("py is not Node, yet got coverage: %v", services["py"])
	}
	if got := d.CoverageServices(ref); !slices.Equal(got, []string{"web"}) {
		t.Fatalf("instrumented %v, want [web]", got)
	}
}

// Nothing built runs Node: nothing is instrumented.
func TestAnUpWithNoNodeImageInstrumentsNothing(t *testing.T) {
	services, ref, d := builtUp(t, dockercli.ImageConfig{Cmd: []string{"/entrypoint.sh"}}, dockercli.ImageConfig{Cmd: []string{"python"}})
	for name, svc := range services {
		if coverageMounted(svc) {
			t.Fatalf("%s got coverage", name)
		}
	}
	if got := d.CoverageServices(ref); len(got) != 0 {
		t.Fatalf("instrumented %v", got)
	}
}

// A round's reset boots the project again with the services the claim says
// are instrumented (the driver's own list, passed back by the agent): a
// built Node service stays instrumented on that Up too, or the flush signal
// reaches a Node process with no preload and nothing is counted.
func TestAnUpAfterAResetKeepsABuiltNodeServiceInstrumented(t *testing.T) {
	_, ref, d, again := builtUpAgain(t,
		dockercli.ImageConfig{Env: []string{"NODE_VERSION=22.11.0"}, Cmd: []string{"node", "server.js"}},
		dockercli.ImageConfig{Env: []string{"PYTHON_VERSION=3.12"}, Cmd: []string{"python", "app.py"}})
	services := again()
	env := func(svc, k string) any { m, _ := services[svc]["environment"].(map[string]any); return m[k] }
	if env("web", "NODE_V8_COVERAGE") != sandbox.CoverageTarget || env("web", "NODE_OPTIONS") != "--require="+sandbox.CoveragePreloadTarget || !coverageMounted(services["web"]) {
		t.Fatalf("web lost its coverage on the Up after a reset: %v", services["web"])
	}
	if got := d.CoverageServices(ref); !slices.Equal(got, []string{"web"}) {
		t.Fatalf("instrumented %v, want [web]", got)
	}
}
