package dockergvisor

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

// The build cache goes one way: a setup machine's builds write theirs, the
// bake makes it the environment's, and every later build reads it without
// ever writing it back.
func TestTheBuildCacheGoesFromTheSetupToLaterBuildsOnly(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	dir := project(t)
	build := sandbox.Build{Service: "api", Context: dir, Dockerfile: "Dockerfile"}

	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, false)
	boot(t, d, setup, build)
	first := docker.builds[0]
	if first.CacheTo == "" || first.CacheFrom != "" {
		t.Fatalf("the first setup build: cache from %q to %q, want only a cache of its own", first.CacheFrom, first.CacheTo)
	}
	if err := d.PinBakeSource(setup); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Bake(ctx, bakeSpec(setup)); err != nil {
		t.Fatal(err)
	}
	envCache := currentCache(d, bakeOrg, bakeEnv, "api")
	if _, err := os.Stat(filepath.Join(envCache, "index.json")); err != nil {
		t.Fatalf("the bake did not make the setup's cache the environment's: %v", err)
	}
	if _, err := os.Stat(d.machineCacheDir(setup.MachineID, "api")); !os.IsNotExist(err) {
		t.Fatal("the setup machine's cache outlived the bake")
	}

	// A PR changed the build: it reads the environment's cache, writes none.
	writeFile(t, filepath.Join(dir, "src", "main.go"), "package main // pr\n")
	pr := machine("claim-pr", bakeEnv)
	boot(t, d, pr, build)
	got := docker.builds[len(docker.builds)-1]
	if got.CacheFrom != envCache || got.CacheTo != "" {
		t.Fatalf("a PR build: cache from %q to %q, want the environment's, read only", got.CacheFrom, got.CacheTo)
	}
	before, _ := os.ReadFile(filepath.Join(envCache, "index.json"))
	if err := d.Destroy(ctx, pr); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(filepath.Join(envCache, "index.json"))
	if string(before) != string(after) {
		t.Fatal("a PR claim changed the environment's cache")
	}
	// Even baked (the agent never lets it), a machine that was no setup's has no cache to give.
	if err := d.PinBakeSource(machine("claim-pr2", bakeEnv)); err == nil {
		t.Fatal("pinned a machine that never booted")
	}

	// Another environment reads nothing of this one's.
	boot(t, d, machine("claim-other", "env-2"), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"})
	if c := docker.builds[len(docker.builds)-1].CacheFrom; c != "" {
		t.Fatalf("another environment read %q", c)
	}
}

// A setup machine released without a bake takes its cache with it.
func TestAnUnbakedSetupsCacheGoesWithIt(t *testing.T) {
	d, _ := bakeDriver(t)
	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, false)
	holder(d.d.(*memDocker), setup)
	boot(t, d, setup, sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"})
	if err := d.Destroy(context.Background(), setup); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(d.workDir(), "cache", "machine", setup.MachineID)); !os.IsNotExist(err) {
		t.Fatal("the setup machine's cache outlived it")
	}
	if currentCache(d, bakeOrg, bakeEnv, "api") != "" {
		t.Fatal("an unbaked setup's cache became the environment's")
	}
}

// A setup of the default branch seeds the cache as soon as its build
// finishes: it fails after that (its ceiling, a health check) and is never
// baked, and the next setup still builds warm.
func TestASeedingSetupLeavesItsCacheWithoutABake(t *testing.T) {
	d, docker := bakeDriver(t)
	dir := project(t)
	build := sandbox.Build{Service: "api", Context: dir, Dockerfile: "Dockerfile"}

	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, true)
	holder(d.d.(*memDocker), setup)
	boot(t, d, setup, build)
	if err := d.Destroy(context.Background(), setup); err != nil {
		t.Fatal(err)
	}
	envCache := currentCache(d, bakeOrg, bakeEnv, "api")
	if envCache == "" {
		t.Fatal("the default branch's build left the environment no cache")
	}

	// The next setup reads it, and writes its own again.
	next := machine("claim-setup-2", bakeEnv)
	asSetup(d, next, true)
	writeFile(t, filepath.Join(dir, "src", "main.go"), "package main // next\n")
	boot(t, d, next, build)
	got := docker.builds[len(docker.builds)-1]
	if got.CacheFrom != envCache || got.CacheTo == "" {
		t.Fatalf("the next setup: cache from %q to %q, want the seeded one and its own", got.CacheFrom, got.CacheTo)
	}
}

// The seed is the setup's only: a PR machine asked to seed writes nothing.
func TestOnlyASetupMachineSeeds(t *testing.T) {
	d, docker := bakeDriver(t)
	pr := machine("claim-pr", bakeEnv)
	d.machineLocked(pr.MachineID).seeds = true // never set without Setup; even so, nothing is written
	boot(t, d, pr, sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"})
	if c := docker.builds[len(docker.builds)-1].CacheTo; c != "" {
		t.Fatalf("a PR build wrote a cache to %q", c)
	}
	if currentCache(d, bakeOrg, bakeEnv, "api") != "" {
		t.Fatal("a PR build seeded the environment's cache")
	}
}

// asSetup marks the machine a setup claim's, as Create does for MachineSpec.Setup
// (and SeedsCache when seeds).
func asSetup(d *Driver, ref driver.MachineRef, seeds bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.machineLocked(ref.MachineID)
	m.setup, m.seeds = true, seeds
}

// currentCache is the generation of the environment's cache a build would
// read now ("" when none).
func currentCache(d *Driver, org, env, service string) string {
	gen, release := d.caches.Acquire(d.envCacheDir(org, env, service))
	release()
	return gen
}

// cacheFrom writes a finished build's cache, as a setup build leaves it.
func cacheFrom(t *testing.T, body string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "out")
	writeFile(t, filepath.Join(dir, "index.json"), body)
	writeFile(t, filepath.Join(dir, "blobs", "sha256", "abc"), body)
	return dir
}

// A promotion while a build reads the environment's cache leaves that
// build's generation whole until it ends; then the generation leaves the
// tree, and the sweep takes its bytes.
func TestAPromotionLeavesTheGenerationABuildReads(t *testing.T) {
	d, docker := bakeDriver(t)
	dir := d.envCacheDir(bakeOrg, bakeEnv, "api")
	if err := d.caches.Promote(cacheFrom(t, "gen1"), dir); err != nil {
		t.Fatal(err)
	}
	gen1 := currentCache(d, bakeOrg, bakeEnv, "api")
	docker.duringBuild = func(b dockercli.BuildRun) {
		docker.duringBuild = nil
		if b.CacheFrom != gen1 {
			t.Errorf("the build read %q, want the current generation %q", b.CacheFrom, gen1)
		}
		// The default branch's setup finishes meanwhile.
		if err := d.caches.Promote(cacheFrom(t, "gen2"), dir); err != nil {
			t.Error(err)
		}
		for _, f := range []string{"index.json", "blobs/sha256/abc"} {
			if b, err := os.ReadFile(filepath.Join(gen1, f)); err != nil || string(b) != "gen1" {
				t.Errorf("the generation under a running build lost %s: %q %v", f, b, err)
			}
		}
	}
	boot(t, d, machine("claim-pr", bakeEnv), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"})

	gen2 := currentCache(d, bakeOrg, bakeEnv, "api")
	if gen2 == "" || gen2 == gen1 {
		t.Fatalf("current %q after the promotion, was %q", gen2, gen1)
	}
	if _, err := os.Stat(gen1); !os.IsNotExist(err) {
		t.Fatal("the replaced generation stayed in the tree after its last build")
	}
	if err := d.ReclaimDisk(); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(filepath.Join(d.workDir(), "cache", "trash")); len(entries) != 0 {
		t.Fatalf("the sweep left the retired generation's bytes: %v", entries)
	}
	if b, err := os.ReadFile(filepath.Join(gen2, "index.json")); err != nil || string(b) != "gen2" {
		t.Fatalf("the current generation: %q %v", b, err)
	}
}
