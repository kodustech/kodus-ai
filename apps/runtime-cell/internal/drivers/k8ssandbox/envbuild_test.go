package k8ssandbox

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/kube"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

const digestA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const composeBuild = `services:
  api:
    build: {context: ., target: runtime, args: {MODE: prod}}
    depends_on: [cache]
  cache:
    image: redis:7
`

// newBuildFixture is an environment fixture on a cell that builds: its
// builder image, a registry the builder pushes to over HTTP and the nodes
// pull from under another name, the registry's address in the builder's
// hosts, and its egress; the checkout has a Dockerfile, a .dockerignore and
// a symlink.
func newBuildFixture(t *testing.T) *envFixture {
	t.Helper()
	f := newEnvFixture(t, "")
	e := f.d.cfg.Env
	e.BuilderImage = "builder@sha256:3"
	e.BuildRegistry, e.BuildRegistryPull, e.BuildRegistryInsecure = "registry.kodus-runtime.svc:5000", "localhost:5001", true
	e.BuildHosts = map[string]string{"registry.kodus-runtime.svc": "10.96.0.50"}
	e.BuildEgress = []kube.EgressPeer{{CIDR: "10.96.0.50/32", Ports: []kube.Port{{Port: 5000}}}}
	if err := e.buildDefaults(); err != nil {
		t.Fatal(err)
	}
	f.c.buildDigest = digestA
	f.c.buildLines = []string{"#1 [internal] load build definition from Dockerfile", "#1 DONE 0.1s", "#2 [runtime 1/1] RUN make", "#2 DONE 2.0s"}
	for name, data := range map[string]string{"Dockerfile": "FROM busybox AS runtime\nRUN make\n", ".dockerignore": "secret.txt\n", "main.go": "package main\n", "secret.txt": "x"} {
		if err := os.WriteFile(filepath.Join(f.dir, name), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("main.go", filepath.Join(f.dir, "link.go")); err != nil {
		t.Fatal(err)
	}
	return f
}

func tarNames(t *testing.T, data []byte) map[string]string {
	t.Helper()
	out := map[string]string{}
	tr := tar.NewReader(bytes.NewReader(data))
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(tr)
		out[h.Name] = string(body) + h.Linkname
	}
}

// A build section runs in a builder pod of its own before any service: the
// rendered builder (which the gate admits) gets the registry's name in its
// hosts file, BuildKit's config (plain HTTP to the registry) and the
// context (what .dockerignore excludes left out, a symlink kept as a link)
// through its init container, then buildctl runs in it with the build's
// target and args and pushes to the registry under the claim, service and
// fingerprint; its lines reach the boot's output; the service runs the
// pushed image by digest from the nodes' registry name; the builder pod is
// gone after the build and the builder policy lets builder pods alone reach
// the registry.
func TestABuildRunsInABuilderPodAndTheServiceRunsItsImageByDigest(t *testing.T) {
	f := newBuildFixture(t)
	var out []string
	_, err := f.d.Up(context.Background(), driver.UpRequest{Ref: f.ref, Compose: []byte(composeBuild), ProjectDir: f.dir, Output: func(l string) { out = append(out, l) }})
	if err != nil {
		t.Fatal(err)
	}
	if len(f.c.builderPods) != 1 {
		t.Fatalf("builder pods %d", len(f.c.builderPods))
	}
	bp := f.c.builderPods[0]
	if failed := gate(t, bp); len(failed) != 0 {
		t.Errorf("the gate refuses the builder: %v", failed)
	}
	if !hasLabels(bp, map[string]string{"kodus.io/cell": "cell-a", "kodus.io/claim": "claim-1", kube.RoleLabel: kube.BuilderRole}) {
		t.Errorf("builder labels %v", meta(bp)["labels"])
	}
	name := str(meta(bp)["name"])
	if !strings.Contains(f.c.hosts[name], "10.96.0.50\tregistry.kodus-runtime.svc") {
		t.Errorf("builder hosts %q", f.c.hosts[name])
	}
	if conf := tarNames(t, f.c.copies[name+"/"+kube.BuildConfigDir])["buildkitd.toml"]; !strings.Contains(conf, `[registry."registry.kodus-runtime.svc:5000"]`) || !strings.Contains(conf, "http = true") {
		t.Errorf("buildkitd.toml %q", conf)
	}
	ctx := tarNames(t, f.c.copies[name+"/"+kube.BuildContextDir])
	if _, ok := ctx["secret.txt"]; ok || ctx["Dockerfile"] == "" || ctx["main.go"] == "" || ctx["link.go"] != "main.go" {
		t.Errorf("context %v", ctx)
	}
	if len(f.c.buildctl) != 1 {
		t.Fatalf("buildctl ran %d times", len(f.c.buildctl))
	}
	argv := strings.Join(f.c.buildctl[0], " ")
	for _, want := range []string{"--opt target=runtime", "--opt build-arg:MODE=prod", "--opt filename=Dockerfile",
		"--output type=image,name=registry.kodus-runtime.svc:5000/kodus-build/claim-1/api:", ",push=true", ",registry.insecure=true"} {
		if !strings.Contains(argv, want) {
			t.Errorf("buildctl lacks %q: %s", want, argv)
		}
	}
	if !slices.Contains(out, "#2 [runtime 1/1] RUN make") {
		t.Errorf("output %q", out)
	}
	for _, p := range f.envPods() {
		if hasLabels(p, map[string]string{kube.RoleLabel: kube.BuilderRole}) {
			t.Error("the builder pod outlived its build")
		}
		if str(meta(p)["name"]) == "env-claim-1-api" {
			img := str(p["spec"].(map[string]any)["containers"].([]any)[0].(map[string]any)["image"])
			if img != "localhost:5001/kodus-build/claim-1/api@"+digestA {
				t.Errorf("api runs %q", img)
			}
		}
	}
	pol := f.c.objects[ResourceNetworkPolicies][envNS+"/env-claim-1--build"]
	if pol == nil || str(pol["spec"].(map[string]any)["podSelector"].(map[string]any)["matchLabels"].(map[string]any)[kube.RoleLabel]) != kube.BuilderRole {
		t.Errorf("build policy %v", pol)
	}

	// A reset's Up with the same checkout builds nothing again; Destroy
	// takes the build policy with the claim.
	if err := f.d.Parts().Resetter.Reset(context.Background(), f.ref, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.up(composeBuild); err != nil {
		t.Fatal(err)
	}
	if len(f.c.buildctl) != 1 {
		t.Errorf("the reset's Up built again: %d", len(f.c.buildctl))
	}
	if err := f.d.Destroy(context.Background(), f.ref); err != nil {
		t.Fatal(err)
	}
	if len(f.c.objects[ResourceNetworkPolicies]) != 0 || len(f.envPods()) != 0 {
		t.Errorf("left %v and %d pods", f.c.objects[ResourceNetworkPolicies], len(f.envPods()))
	}
}

// A build whose step fails is the repository's failure, naming the step
// and its lines; one the kubelet killed for memory is out_of_memory; one
// whose builder ended with no step failed is the platform's. None leaves a
// pod behind.
func TestAFailedBuildSaysWhyAndLeavesNoPod(t *testing.T) {
	for name, tc := range map[string]struct {
		lines []string
		oom   bool
		check func(error) bool
	}{
		"step": {lines: []string{"#2 [runtime 1/1] RUN make", "#2 0.2 make: *** no rule", `#2 ERROR: process "/bin/sh -c make" did not complete successfully: exit code: 2`},
			check: func(err error) bool {
				return strings.Contains(err.Error(), "step [runtime 1/1] RUN make failed") && strings.Contains(err.Error(), "no rule") && !errors.Is(err, driver.ErrBuilderFailed)
			}},
		"oom":     {oom: true, check: func(err error) bool { return errors.Is(err, driver.ErrOutOfMemory) }},
		"builder": {lines: []string{"#1 [internal] load build definition"}, check: func(err error) bool { return errors.Is(err, driver.ErrBuilderFailed) }},
	} {
		t.Run(name, func(t *testing.T) {
			f := newBuildFixture(t)
			f.c.buildLines, f.c.buildExit, f.c.buildOOM = tc.lines, 1, tc.oom
			_, err := f.up(composeBuild)
			if err == nil || !tc.check(err) {
				t.Errorf("err %v", err)
			}
			if n := len(f.envPods()); n != 0 {
				t.Errorf("%d pods left", n)
			}
		})
	}
}

// A build that reads an org secret the claim holds is refused before
// anything is created (the builder does not trust the cell CA on
// Kubernetes yet); a file the cell refuses is refused before any build.
func TestABuildIsCheckedBeforeAnythingRuns(t *testing.T) {
	f := newBuildFixture(t)
	if err := os.WriteFile(filepath.Join(f.dir, "Dockerfile"), []byte("FROM busybox\nRUN --mount=type=secret,id=NPM_TOKEN cat /run/secrets/NPM_TOKEN\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := f.d.Up(context.Background(), driver.UpRequest{Ref: f.ref, Compose: []byte("services:\n  api: {build: .}\n"), ProjectDir: f.dir, BuildSecrets: map[string]string{"NPM_TOKEN": "kodus-placeholder"}})
	if !errors.Is(err, driver.ErrUnsupported) || !strings.Contains(err.Error(), "org secrets") {
		t.Errorf("a build with a secret: %v", err)
	}
	if _, err := f.up("services:\n  api: {build: ., privileged: true}\n"); err == nil {
		t.Error("a privileged built service")
	}
	if len(f.c.builderPods) != 0 || len(f.c.buildctl) != 0 {
		t.Errorf("built %d times", len(f.c.buildctl))
	}
}

// Builds need both the builder image and the registry, and names the
// builder resolves need addresses.
func TestBuildSettingsAreCheckedAtConstruction(t *testing.T) {
	for name, e := range map[string]EnvConfig{
		"no registry":  {BuilderImage: "b"},
		"no image":     {BuildRegistry: "r:5000"},
		"bad registry": {BuilderImage: "b", BuildRegistry: "http://r"},
		"bad host":     {BuilderImage: "b", BuildRegistry: "r:5000", BuildHosts: map[string]string{"r": "not-an-ip"}},
	} {
		c := newCluster()
		e.API, e.Exec, e.Namespace = c, c, envNS
		if _, err := New(c, nil, Config{CellID: "c", Namespace: sandboxNS, RuntimeClass: "gvisor", HolderImage: "h", EgressAddress: "1.1.1.1",
			ReadyTimeout: time.Second, Env: &e}); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}
