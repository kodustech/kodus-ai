package dockergvisor

import (
	"os"
	"path/filepath"
	"sort"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildstate"
)

// The build cache goes one way, as the images do (S-52). Every build reads
// its environment's cache, mounted read-only; only a setup machine's builds
// write theirs, into a directory of the machine's, and a bake of that
// machine (or, for the default branch's setup, the build's own end) makes
// it the environment's. A PR build reads the default branch's layers and
// can never put one of its own where a later setup or bake would take it.

// envCacheDir is where an environment keeps the build cache of a service.
func (d *Driver) envCacheDir(org, env, service string) string {
	return filepath.Join(d.workDir(), "cache", "env", buildstate.EnvKey(d.cfg.CellID, org, env), service)
}

// machineCacheDir is where a setup machine's build of a service writes its cache.
func (d *Driver) machineCacheDir(machine, service string) string {
	return filepath.Join(d.workDir(), "cache", "machine", machine, service)
}

// writableCache makes the setup machine's cache directory for a service,
// empty and the builder's alone (hostdirs.go).
func (d *Driver) writableCache(machine, service string) (string, error) {
	dir := d.machineCacheDir(machine, service)
	if err := os.RemoveAll(dir); err != nil {
		return "", err
	}
	return dir, d.dirs.builderDir(dir)
}

// promoteCache makes a finished setup build's cache of a service the
// environment's.
func (d *Driver) promoteCache(from, org, env, service string) error {
	return d.caches.Promote(from, d.envCacheDir(org, env, service))
}

// removeMachineCache drops what a machine's builds wrote and no bake took.
func (d *Driver) removeMachineCache(machine string) error {
	return os.RemoveAll(filepath.Join(d.workDir(), "cache", "machine", machine))
}

// evictCaches keeps the exported caches under the disk floor the states
// keep (Config.BuildStateMinFreeBytes): once the sweep has evicted every
// state it could and the disk is still below the floor, it drops exported
// caches no build reads. Those of an environment whose state is still on the
// cell go first (the state holds the same layers and its cache mounts too),
// then the least recently promoted; a cache whose state is gone is the warm
// start of that environment's next builds, so it goes last.
func (d *Driver) evictCaches() error {
	floor := d.cfg.BuildStateMinFreeBytes
	if floor <= 0 {
		return nil
	}
	free := buildstate.FreeBytes
	if d.hooks != nil && d.hooks.freeBytes != nil {
		free = d.hooks.freeBytes
	}
	root := filepath.Join(d.workDir(), "cache")
	if n, err := free(root); err != nil || n >= floor {
		return err
	}
	all := d.caches.Current()
	// The states' directories are EnvKey too (buildstate, under buildkit/env).
	hasState := map[string]bool{}
	for _, c := range all {
		if _, err := os.Stat(filepath.Join(d.workDir(), "buildkit", "env", c.Env)); err == nil {
			hasState[c.Env] = true
		}
	}
	sort.SliceStable(all, func(i, j int) bool {
		if hasState[all[i].Env] != hasState[all[j].Env] {
			return hasState[all[i].Env]
		}
		return all[i].Promoted.Before(all[j].Promoted)
	})
	for _, c := range all {
		if n, err := free(root); err != nil || n >= floor {
			return err
		}
		dropped, err := d.caches.Drop(c.Dir)
		if err != nil {
			return err
		}
		if dropped {
			d.log().Info("build.cache.evicted", "env", c.Env, "service", filepath.Base(c.Dir), "promoted", c.Promoted, "stateKept", hasState[c.Env])
		}
	}
	return nil
}
