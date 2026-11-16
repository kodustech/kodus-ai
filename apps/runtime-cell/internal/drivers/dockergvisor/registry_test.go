package dockergvisor

import (
	"context"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildprogress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildstate"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/registry"
)

// registryDriver is a driver on the registry transfer whose registries are
// one fake registry: it answers its API root and the manifests the builds
// pushed, as distribution does.
func registryDriver(t *testing.T) (*Driver, *memDocker) {
	t.Helper()
	// New refuses the registry transfer to a cell that is the builder's uid
	// (driver.go, sealSeed): run as that uid, these tests have no driver.
	if os.Geteuid() == builderUser {
		t.Skipf("the registry image transfer needs a cell uid other than the builder's (%d); this test runs as it", builderUser)
	}
	docker := newMemDocker()
	docker.plant(dockercli.Container{ID: "cegress", Name: "kodus-egress", Networks: map[string]string{"kodus-cell": "10.9.0.2"}})
	d, err := New(context.Background(), docker, Config{
		CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(), EgressContainer: "kodus-egress",
		BuilderImage: "moby/buildkit@sha256:abc", ImageTransfer: TransferRegistry, RegistryImage: "registry@sha256:abc",
	})
	if err != nil {
		t.Fatal(err)
	}
	recordChowns(d)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/" {
			return
		}
		docker.mu.Lock()
		defer docker.mu.Unlock()
		for digest, repo := range docker.pushed {
			if r.URL.Path == "/v2/"+repo+"/manifests/"+digest {
				return
			}
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	d.hooksForTest().dialRegistry = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}
	return d, docker
}

func seedDir(d *Driver) string {
	return filepath.Join(d.registryRoot(), buildstate.EnvKey("cell-1", bakeOrg, bakeEnv), "seed")
}

// writeBlob puts a blob in a registry storage as distribution lays it out.
func writeBlob(t *testing.T, storage, sum string, mode os.FileMode) string {
	t.Helper()
	p := filepath.Join(storage, registry.V2, "blobs", "sha256", sum[:2], sum, "data")
	writeFile(t, p, "layer "+sum)
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
	return p
}

// seedRegistry stands for a setup of the default branch that seeded the
// environment's registry: one sealed blob in its seed storage.
func seedRegistry(t *testing.T, d *Driver) {
	t.Helper()
	if err := d.dirs.builderDir(seedDir(d)); err != nil {
		t.Fatal(err)
	}
	writeBlob(t, seedDir(d), strings.Repeat("e", 64), 0o444)
}

// A pull request's build against an environment whose registry was never
// seeded sends its image as a tarball: a push there would carry the whole
// image. Once the default branch's setup has seeded the registry, the next
// pull request's build goes through it.
func TestAPullRequestBuildAgainstAnUnseededRegistrySendsATarball(t *testing.T) {
	d, docker := registryDriver(t)
	build := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
	first := "kodus-build/pr1-api:claim"
	_, ran, err := d.runBuild(context.Background(), machine("claim-pr1", bakeEnv), build, first, "net", "resolv", bakeSubnet, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(docker.registries) != 0 || docker.builds[0].Push != nil || len(docker.pulls) != 0 || !docker.images[first] || !hasPhase(ran.Phases, "docker load") {
		t.Fatalf("unseeded: registries %d, push %+v, pulls %v, loaded %v, phases %+v", len(docker.registries), docker.builds[0].Push, docker.pulls, docker.images[first], ran.Phases)
	}

	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, true)
	docker.duringBuild = func(b dockercli.BuildRun) {
		if b.Push != nil {
			writeBlob(t, docker.registries[len(docker.registries)-1].StorageDir, strings.Repeat("d", 64), 0o644)
		}
	}
	if _, _, err := d.runBuild(context.Background(), setup, build, "kodus-build/s-api:claim", "net", "resolv", bakeSubnet, nil); err != nil {
		t.Fatal(err)
	}
	docker.duringBuild = nil
	if docker.builds[1].Push == nil {
		t.Fatal("the setup that seeds the registry sent a tarball")
	}

	_, ran, err = d.runBuild(context.Background(), machine("claim-pr2", bakeEnv), build, "kodus-build/pr2-api:claim", "net", "resolv", bakeSubnet, nil)
	if err != nil {
		t.Fatal(err)
	}
	if docker.builds[2].Push == nil || len(docker.pulls) != 2 || !hasPhase(ran.Phases, "pull image") {
		t.Fatalf("seeded: push %+v, pulls %v, phases %+v", docker.builds[2].Push, docker.pulls, ran.Phases)
	}
}

// The registry transfer: the build pushes to a registry of its own and this
// Docker pulls exactly the image the build reported, by digest, through the
// cell's loopback forward; nothing is loaded from a tarball, and the
// registry is gone after the pull.
func TestARegistryBuildIsPulledByTheDigestItReported(t *testing.T) {
	d, docker := registryDriver(t)
	seedRegistry(t, d)
	tag := "kodus-build/m-api:claim"
	_, ran, err := d.runBuild(context.Background(), machine("claim-pr", bakeEnv), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}, tag, "net", "resolv", bakeSubnet, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(docker.pulls) != 1 || !strings.HasPrefix(docker.pulls[0], "127.0.0.1:") || !strings.Contains(docker.pulls[0], "@sha256:") {
		t.Fatalf("pulls %v", docker.pulls)
	}
	if !docker.images[tag] || docker.images[docker.pulls[0]] {
		t.Fatalf("images %v: the claim's tag is not there, or the pull's own name stayed", docker.images)
	}
	if b, r := docker.builds[0], docker.registries[0]; b.Push == nil || b.Push.Registry != "10.213.1.8:5000" || r.ClaimNetwork != "net" || r.ClaimIP != "10.213.1.8" {
		t.Fatalf("build %+v did not push to the registry on the claim network (registry on %s at %s)", b.Push, r.ClaimNetwork, r.ClaimIP)
	}
	if _, ok := docker.containers[docker.registries[0].Name]; ok {
		t.Fatal("the registry outlived its build")
	}
	if !hasPhase(ran.Phases, "pull image") || hasPhase(ran.Phases, "docker load") {
		t.Fatalf("phases %+v", ran.Phases)
	}
}

func hasPhase(ps []buildprogress.Phase, name string) bool {
	for _, p := range ps {
		if p.Name == name {
			return true
		}
	}
	return false
}

// A pull request's build never writes the environment's storage and never
// sees another pull request's: its registry gets storage of its own, with
// the default branch's sealed blobs linked in (so its push skips them) and
// nothing the cell has not sealed; that storage goes with the build.
func TestAPullRequestBuildGetsStorageOfItsOwn(t *testing.T) {
	d, docker := registryDriver(t)
	sealed := strings.Repeat("a", 64)
	unsealed := strings.Repeat("b", 64)
	if err := d.dirs.builderDir(seedDir(d)); err != nil {
		t.Fatal(err)
	}
	writeBlob(t, seedDir(d), sealed, 0o444)
	writeBlob(t, seedDir(d), unsealed, 0o644)
	var storage string
	var linked, leaked bool
	docker.duringBuild = func(dockercli.BuildRun) {
		storage = docker.registries[0].StorageDir
		_, err := os.Stat(filepath.Join(storage, registry.V2, "repositories", filepath.FromSlash(registry.Repo("api")), "_layers", "sha256", sealed, "link"))
		linked = err == nil
		_, err = os.Stat(filepath.Join(storage, registry.V2, "blobs", "sha256", unsealed[:2], unsealed, "data"))
		leaked = err == nil
	}
	if _, _, err := d.runBuild(context.Background(), machine("claim-pr", bakeEnv), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}, "kodus-build/m-api:claim", "net", "resolv", bakeSubnet, nil); err != nil {
		t.Fatal(err)
	}
	if storage == seedDir(d) || !linked || leaked {
		t.Fatalf("storage %s (seed %s), sealed blob linked %v, unsealed blob linked %v", storage, seedDir(d), linked, leaked)
	}
	if _, err := os.Stat(storage); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the build's storage outlived it: %v", err)
	}
}

// The default branch's setup pushes into the environment's storage, and what
// it pushed is sealed after its pull: the cell's and read-only, so a later
// build's registry can read it and never change it.
func TestASetupsPushIsSealedForTheBuildsAfterIt(t *testing.T) {
	d, docker := registryDriver(t)
	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, true)
	sum := strings.Repeat("c", 64)
	var blob string
	docker.duringBuild = func(dockercli.BuildRun) {
		blob = writeBlob(t, docker.registries[0].StorageDir, sum, 0o644)
	}
	if _, _, err := d.runBuild(context.Background(), setup, sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}, "kodus-build/s-api:claim", "net", "resolv", bakeSubnet, nil); err != nil {
		t.Fatal(err)
	}
	if docker.registries[0].StorageDir != seedDir(d) {
		t.Fatalf("the setup pushed into %s, not the environment's storage", docker.registries[0].StorageDir)
	}
	info, err := os.Lstat(blob)
	if err != nil {
		t.Fatal(err)
	}
	if uid, _ := d.dirs.owner(info); uid != d.dirs.self || info.Mode().Perm() != 0o444 {
		t.Fatalf("blob uid %d mode %v, want the cell's and read-only", uid, info.Mode().Perm())
	}
}

// What a build pushes is bounded like a tarball: past the cell's image bound
// it is refused as too large and never pulled.
func TestABuildThatPushesPastTheImageBoundIsRefused(t *testing.T) {
	d, docker := registryDriver(t)
	seedRegistry(t, d)
	d.cfg.MaxImageBytes = 1 << 10
	docker.pushBytes = 4 << 10
	_, _, err := d.runBuild(context.Background(), machine("claim-pr", bakeEnv), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}, "kodus-build/m-api:claim", "net", "resolv", bakeSubnet, nil)
	if !errors.Is(err, driver.ErrImageTooLarge) || len(docker.pulls) != 0 {
		t.Fatalf("err %v, pulls %v", err, docker.pulls)
	}
}

// The registry transfer is a choice of the cell's operator: an unknown mode,
// or the registry one without a registry image, does not start.
func TestTheRegistryTransferNeedsItsImage(t *testing.T) {
	for _, cfg := range []Config{
		{ImageTransfer: "nfs", BuilderImage: "b"},
		{ImageTransfer: TransferRegistry, BuilderImage: "b"},
	} {
		cfg.CellID, cfg.HolderImage, cfg.WorkDir = "cell-1", "h", t.TempDir()
		if _, err := New(context.Background(), newMemDocker(), cfg); err == nil {
			t.Fatalf("%+v started", cfg)
		}
	}
}

// The seed's blobs are sealed by making them the cell's and read-only, which
// keeps a pull request's registry (the builder's uid) from rewriting one it
// was linked. A cell that runs as the builder's uid owns what the builder
// writes, so that seal holds nothing: the registry transfer does not start.
func TestTheRegistryTransferRefusesACellThatIsTheBuilder(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root is never the builder (its uid may not be 0)")
	}
	_, err := New(context.Background(), newMemDocker(), Config{
		CellID: "cell-1", HolderImage: "h", WorkDir: t.TempDir(), BuilderImage: "b",
		ImageTransfer: TransferRegistry, RegistryImage: "registry@sha256:abc", BuilderUID: os.Geteuid(), BuilderGID: os.Getegid(),
	})
	if err == nil {
		t.Fatal("the registry transfer started on a cell that runs as the builder")
	}
}

// A build that pushes past the cell's image bound is stopped while it runs,
// not once it ends, and ends as an image too large: its registry is gone, and
// so is what it pushed, the environment's seed storage included.
func TestARegistryBuildPushingPastTheImageBoundIsStoppedWhileItRuns(t *testing.T) {
	for name, setup := range map[string]bool{"pull request": false, "setup": true} {
		t.Run(name, func(t *testing.T) {
			d, docker := registryDriver(t)
			d.cfg.MaxImageBytes = 1 << 10
			d.hooksForTest().buildDiskEvery = 10 * time.Millisecond
			ref := machine("claim-fill", bakeEnv)
			if setup {
				asSetup(d, ref, true)
			} else {
				seedRegistry(t, d)
			}
			var storage string
			f := &fillingBuilder{memDocker: docker, fill: func(dockercli.BuildRun) string {
				docker.mu.Lock()
				defer docker.mu.Unlock()
				storage = docker.registries[len(docker.registries)-1].StorageDir
				return filepath.Join(storage, "filler")
			}}
			d.d = f
			_, _, err := d.runBuild(context.Background(), ref, sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}, "kodus-build/m-api:claim", "net", "resolv", bakeSubnet, nil)
			if !errors.Is(err, driver.ErrImageTooLarge) || !f.stopped || len(docker.pulls) != 0 {
				t.Fatalf("err %v, stopped while it ran %v, pulls %v", err, f.stopped, docker.pulls)
			}
			if _, ok := docker.containers[docker.registries[0].Name]; ok {
				t.Fatal("the registry outlived its build")
			}
			if _, err := os.Stat(storage); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("what the build pushed stayed in %s: %v", storage, err)
			}
		})
	}
}
