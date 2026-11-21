package dockergvisor

import (
	"os"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
)

// A pull request whose environment's state the disk floor evicted builds from
// the cache the seeding setup exported on this cell, with no store off the
// cell: the seed exported nothing then, and directus, payload and immich's
// next pull requests built cold (1,000 s, 894 s, 363 s), calcom's past its
// ceiling (measured on the dev cell, 2026-11-13).
func TestAnEvictedStateLeavesItsPullRequestsTheSetupsExportedCache(t *testing.T) {
	d, docker, m := statefulDriver(t)
	build := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, true)
	boot(t, d, setup, build)
	exported := currentCache(d, bakeOrg, bakeEnv, "api")
	if exported == "" {
		t.Fatal("the seeding setup left no exported cache on the cell")
	}

	evictStates(t, d, m)
	boot(t, d, machine("claim-pr", bakeEnv), build)
	got := docker.builds[len(docker.builds)-1]
	if got.StateDir != "" || got.CacheFrom != exported || got.CacheTo != "" {
		t.Fatalf("the PR build after the eviction: state %q, cache from %q to %q; want the setup's exported cache, read only", got.StateDir, got.CacheFrom, got.CacheTo)
	}
}

// The next setup, seeding a state the floor evicted, starts from that
// exported cache too, and exports again.
func TestASeedOnAnEvictedStateStartsFromTheCacheOnTheCell(t *testing.T) {
	d, docker, m := statefulDriver(t)
	build := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
	first := machine("claim-setup", bakeEnv)
	asSetup(d, first, true)
	boot(t, d, first, build)
	exported := currentCache(d, bakeOrg, bakeEnv, "api")
	evictStates(t, d, m)

	again := machine("claim-setup-2", bakeEnv)
	asSetup(d, again, true)
	boot(t, d, again, build)
	got := docker.builds[len(docker.builds)-1]
	if got.StateDir == "" || got.CacheFrom != exported || got.CacheTo == "" {
		t.Fatalf("the seed after the eviction: state %q, cache from %q to %q; want a new state, the exported cache and an export", got.StateDir, got.CacheFrom, got.CacheTo)
	}
	if c := currentCache(d, bakeOrg, bakeEnv, "api"); c == "" || c == exported {
		t.Fatalf("the new seed's export did not become the environment's cache (%q)", c)
	}
}

// The exported caches stay under the disk floor the states keep: once the
// states the sweep could take are gone and the disk is still short, the
// cache of an environment whose state is still on the cell goes first (the
// state holds the same layers), the one whose state is gone stays as long
// as the disk allows, and a cache a build reads is never dropped.
func TestExportedCachesGoUnderTheFloorThoseWithAStateFirst(t *testing.T) {
	d, _, _ := statefulDriver(t)
	build := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
	for _, env := range []string{"env-kept", "env-gone", "env-read"} {
		setup := machine("claim-setup-"+env, env)
		asSetup(d, setup, true)
		boot(t, d, setup, build)
	}
	if err := os.RemoveAll(states(d).EnvDir(bakeOrg, "env-gone")); err != nil {
		t.Fatal(err)
	}
	_, release := d.caches.Acquire(d.envCacheDir(bakeOrg, "env-read", "api"))
	defer release()

	d.cfg.BuildStateMinFreeBytes = 100
	measured := 0
	d.hooksForTest().freeBytes = func(string) (int64, error) {
		// Short until one cache is gone.
		if measured++; measured > 2 {
			return 1000, nil
		}
		return 10, nil
	}
	if err := d.ReclaimDisk(); err != nil {
		t.Fatal(err)
	}
	if c := currentCache(d, bakeOrg, "env-kept", "api"); c != "" {
		t.Fatal("the cache of an environment whose state is on the cell was kept")
	}
	for _, env := range []string{"env-gone", "env-read"} {
		if c := currentCache(d, bakeOrg, env, "api"); c == "" {
			t.Fatalf("%s's cache was dropped", env)
		}
	}

	// Still short: everything no build reads goes, the one read stays.
	d.hooksForTest().freeBytes = func(string) (int64, error) { return 10, nil }
	if err := d.evictCaches(); err != nil {
		t.Fatal(err)
	}
	if c := currentCache(d, bakeOrg, "env-gone", "api"); c != "" {
		t.Fatal("a cache no build reads outlived the floor")
	}
	if c := currentCache(d, bakeOrg, "env-read", "api"); c == "" {
		t.Fatal("a cache a build reads was dropped")
	}
}
