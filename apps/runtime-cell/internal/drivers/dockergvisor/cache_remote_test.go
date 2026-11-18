package dockergvisor

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildstate"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/remotecache"
)

// fakeRemote is the store off the cell in memory: each key's cache as the
// index.json it was pushed with.
type fakeRemote struct {
	mu     sync.Mutex
	caches map[remotecache.Key]string
	pushes []remotecache.Key
	pulls  []remotecache.Key
}

func (f *fakeRemote) Push(_ context.Context, k remotecache.Key, dir string) (remotecache.Stats, error) {
	b, err := os.ReadFile(filepath.Join(dir, "index.json"))
	if err != nil {
		return remotecache.Stats{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.caches == nil {
		f.caches = map[remotecache.Key]string{}
	}
	f.caches[k] = string(b)
	f.pushes = append(f.pushes, k)
	return remotecache.Stats{Blobs: 1}, nil
}

func (f *fakeRemote) Pull(_ context.Context, k remotecache.Key, dir string) (remotecache.Stats, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pulls = append(f.pulls, k)
	idx, ok := f.caches[k]
	if !ok {
		return remotecache.Stats{}, remotecache.ErrNotFound
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return remotecache.Stats{}, err
	}
	return remotecache.Stats{Blobs: 1}, os.WriteFile(filepath.Join(dir, "index.json"), []byte(idx), 0o600)
}

// evictStates runs the store's eviction with the disk below its floor.
func evictStates(t *testing.T, d *Driver, m buildstate.Mounter) {
	t.Helper()
	d.states = testStates(t, d, m, func(c *buildstate.Config) {
		c.MinFree = 100
		c.FreeBytes = func(string) (int64, error) { return 10, nil }
	})
	if err := d.states.Evict(); err != nil {
		t.Fatal(err)
	}
}

// evictCachesBelowFloor drops every exported cache no build reads, as the
// sweep does once the disk stays below its floor after the states.
func evictCachesBelowFloor(t *testing.T, d *Driver) {
	t.Helper()
	d.cfg.BuildStateMinFreeBytes = 100
	d.hooksForTest().freeBytes = func(string) (int64, error) { return 10, nil }
	if err := d.evictCaches(); err != nil {
		t.Fatal(err)
	}
}

// The dev cell's disk floor evicted every environment's state and their pull
// requests built cold (no state, no exported cache: the seed exported none),
// calcom's past its boot's ceiling. With a store off the cell, the setup that
// seeds the state also pushes its cache there, and a build that finds neither
// state nor exported cache on this cell (both evicted, or another cell)
// imports that one.
func TestABuildWhoseStateWasEvictedImportsTheSetupsCacheFromOffTheCell(t *testing.T) {
	d, docker, m := statefulDriver(t)
	remote := &fakeRemote{}
	d.remote = remote
	build := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}

	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, true)
	boot(t, d, setup, build)
	d.WaitRemotePushes()
	seedBuild := docker.builds[len(docker.builds)-1]
	if seedBuild.StateDir == "" || seedBuild.CacheTo == "" {
		t.Fatalf("the seed: state %q, cache to %q; want the state and an export for the store", seedBuild.StateDir, seedBuild.CacheTo)
	}
	want := remotecache.Key{Org: bakeOrg, Env: bakeEnv, Service: "api"}
	if len(remote.pushes) != 1 || remote.pushes[0] != want {
		t.Fatalf("pushes = %+v, want one of %+v", remote.pushes, want)
	}

	evictStates(t, d, m)
	if _, err := os.Stat(d.states.(*buildstate.Store).EnvDir(bakeOrg, bakeEnv)); !os.IsNotExist(err) {
		t.Fatal("the state was not evicted")
	}
	evictCachesBelowFloor(t, d)
	if c := currentCache(d, bakeOrg, bakeEnv, "api"); c != "" {
		t.Fatalf("the exported cache outlived the floor: %s", c)
	}

	pullsBefore := len(remote.pulls) // the first seed's, of a store still empty
	pr := machine("claim-pr", bakeEnv)
	boot(t, d, pr, build)
	got := docker.builds[len(docker.builds)-1]
	if got.StateDir != "" || got.CacheFrom == "" || got.CacheTo != "" {
		t.Fatalf("the PR build after the eviction: state %q, cache from %q, to %q; want the pulled cache, read only", got.StateDir, got.CacheFrom, got.CacheTo)
	}
	if idx, _ := os.ReadFile(filepath.Join(got.CacheFrom, "index.json")); string(idx) != remote.caches[want] {
		t.Fatal("the PR build read another cache than the setup's")
	}
	// Pulled once: the next build reads what is now on the cell.
	boot(t, d, machine("claim-pr-2", bakeEnv), build)
	if n := len(remote.pulls) - pullsBefore; n != 1 {
		t.Fatalf("pulls after the eviction = %d, want 1", n)
	}
}

// The next setup after the eviction seeds an empty state: it starts from the
// store's cache instead of cold.
func TestASeedOnAnEvictedStateStartsFromTheStoresCache(t *testing.T) {
	d, docker, m := statefulDriver(t)
	remote := &fakeRemote{}
	d.remote = remote
	build := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
	first := machine("claim-setup", bakeEnv)
	asSetup(d, first, true)
	boot(t, d, first, build)
	d.WaitRemotePushes()
	evictStates(t, d, m)
	evictCachesBelowFloor(t, d)

	again := machine("claim-setup-2", bakeEnv)
	asSetup(d, again, true)
	boot(t, d, again, build)
	d.WaitRemotePushes()
	got := docker.builds[len(docker.builds)-1]
	if got.StateDir == "" || got.CacheFrom == "" || got.CacheTo == "" {
		t.Fatalf("the seed after the eviction: state %q, cache from %q, to %q; want a new state, the store's cache and an export", got.StateDir, got.CacheFrom, got.CacheTo)
	}
}

// Only a setup of the default branch pushes: a pull request's build never
// reaches the store, and another org's environment never reads this one's.
func TestOnlyTheSeedPushesAndOnlyItsOrgReads(t *testing.T) {
	d, docker := bakeDriver(t)
	remote := &fakeRemote{}
	d.remote = remote
	build := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
	boot(t, d, machine("claim-pr", bakeEnv), build)
	d.WaitRemotePushes()
	if len(remote.pushes) != 0 {
		t.Fatalf("a PR build pushed %+v", remote.pushes)
	}
	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, true)
	boot(t, d, setup, build)
	d.WaitRemotePushes()
	if len(remote.pushes) != 1 {
		t.Fatalf("pushes = %+v, want the seed's", remote.pushes)
	}
	other := machine("claim-other-org", bakeEnv)
	other.Tags["kodus:org"] = "org-other"
	boot(t, d, other, build)
	if c := docker.builds[len(docker.builds)-1].CacheFrom; c != "" {
		t.Fatalf("another org's build read %q", c)
	}
	for _, k := range remote.pulls {
		if k.Org == "org-other" {
			if _, ok := remote.caches[k]; ok {
				t.Fatal("another org's key found this org's cache")
			}
		}
	}
}
