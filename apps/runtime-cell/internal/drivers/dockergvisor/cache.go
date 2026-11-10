package dockergvisor

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
)

// The build cache goes one way, as the images do (S-52). Every build reads
// its environment's cache, mounted read-only; only a setup machine's builds
// write theirs, into a directory of the machine's, and a bake of that
// machine (or, for the default branch's setup, the build's own end) makes
// it the environment's. A PR build reads the default branch's layers and
// can never put one of its own where a later setup or bake would take it.

// envCacheDir is where an environment keeps the build cache of a service.
func (d *Driver) envCacheDir(org, env, service string) string {
	return filepath.Join(d.workDir(), "cache", "env", envDirKey(d.cfg.CellID, org, env), service)
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

// cacheGenerations keeps each environment's exported cache of a service as
// generations: <dir>/gen-<id> holds one, and the symlink <dir>/current names
// the one builds read. A build mounts the generation itself, read-only, for
// its whole run, so a promotion never changes or removes files under a
// running build: it adds a generation and swaps the link (a rename, atomic),
// and the generation it replaced goes only once no build holds it. Going is
// a rename into trash under the lock, O(1); the bytes go on the cell's
// sweep, never on a build's path.
type cacheGenerations struct {
	// root holds the environments' cache directories (<root>/<env>/<service>,
	// envCacheDir); trash what was retired, until Sweep removes it.
	root, trash string
	mu          sync.Mutex
	// held counts the builds reading each generation (its path).
	held map[string]int
	seq  int
	// clock stamps generation and trash names; seq keeps two of the same
	// instant apart.
	clock clock.Clock
}

func newCacheGenerations(root, trash string, clk clock.Clock) *cacheGenerations {
	return &cacheGenerations{root: root, trash: trash, held: map[string]int{}, clock: clock.Or(clk)}
}

const (
	cacheCurrent   = "current"
	cacheGenPrefix = "gen-"
)

// currentLocked is the generation <dir>/current names, when it holds a
// cache. The caller holds c.mu.
func (c *cacheGenerations) currentLocked(dir string) string {
	name, err := os.Readlink(filepath.Join(dir, cacheCurrent))
	// The link is the cell's own, in a directory only the cell writes;
	// anything but a generation's bare name is not one it made.
	if err != nil || name != filepath.Base(name) || !strings.HasPrefix(name, cacheGenPrefix) {
		return ""
	}
	gen := filepath.Join(dir, name)
	if _, err := os.Stat(filepath.Join(gen, "index.json")); err != nil {
		return ""
	}
	return gen
}

// Acquire is the generation of the cache in dir a build reads, held until
// release: "" (and a release that does nothing) when there is none.
func (c *cacheGenerations) Acquire(dir string) (gen string, release func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	gen = c.currentLocked(dir)
	if gen == "" {
		return "", func() {}
	}
	c.held[gen]++
	var once sync.Once
	return gen, func() { once.Do(func() { c.release(dir, gen) }) }
}

func (c *cacheGenerations) release(dir, gen string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.held[gen]--; c.held[gen] > 0 {
		return
	}
	delete(c.held, gen)
	if c.currentLocked(dir) != gen {
		_ = c.retireLocked(gen)
	}
}

// Promote makes from (a finished build's cache) the current generation of
// dir. The generation it replaces stays while a build reads it.
func (c *cacheGenerations) Promote(from, dir string) error {
	if _, err := os.Stat(filepath.Join(from, "index.json")); err != nil {
		return nil // the build wrote no cache
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	c.seq++
	id := strconv.FormatInt(c.clock.Now().UnixNano(), 36) + "-" + strconv.Itoa(c.seq)
	name := cacheGenPrefix + id
	if err := os.Rename(from, filepath.Join(dir, name)); err != nil {
		return err
	}
	old := c.currentLocked(dir)
	link := filepath.Join(dir, cacheCurrent+".tmp-"+id)
	if err := os.Symlink(name, link); err != nil {
		return errors.Join(err, c.retireLocked(filepath.Join(dir, name)))
	}
	if err := os.Rename(link, filepath.Join(dir, cacheCurrent)); err != nil {
		return errors.Join(err, os.Remove(link), c.retireLocked(filepath.Join(dir, name)))
	}
	if old != "" && c.held[old] == 0 {
		return c.retireLocked(old)
	}
	return nil
}

// retireLocked takes a generation out of the tree; Sweep removes its bytes.
func (c *cacheGenerations) retireLocked(gen string) error {
	if err := os.MkdirAll(c.trash, 0o700); err != nil {
		return err
	}
	c.seq++
	to := filepath.Join(c.trash, fmt.Sprintf("%s-%d-%d", filepath.Base(gen), c.clock.Now().UnixNano(), c.seq))
	if err := os.Rename(gen, to); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Sweep retires what no build holds and no link names under root:
// generations a crash left behind, and the files of the layout before
// generations. Then it removes what is in the trash.
func (c *cacheGenerations) Sweep() error {
	root := c.root
	envs, _ := os.ReadDir(root)
	var errs []error
	for _, env := range envs {
		services, _ := os.ReadDir(filepath.Join(root, env.Name()))
		for _, svc := range services {
			errs = append(errs, c.sweepDir(filepath.Join(root, env.Name(), svc.Name())))
		}
	}
	trash, _ := os.ReadDir(c.trash)
	for _, e := range trash {
		errs = append(errs, os.RemoveAll(filepath.Join(c.trash, e.Name())))
	}
	return errors.Join(errs...)
}

func (c *cacheGenerations) sweepDir(dir string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	current := c.currentLocked(dir)
	var errs []error
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		if e.Name() == cacheCurrent || p == current || c.held[p] > 0 {
			continue
		}
		errs = append(errs, c.retireLocked(p))
	}
	return errors.Join(errs...)
}
