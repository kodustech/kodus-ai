// Package buildcache keeps the exported BuildKit cache of each environment's
// services as generations, so a promotion never changes files under a
// running build. It holds directories and a clock; it knows no Docker.
package buildcache

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

// Generations keeps each environment's exported cache of a service as
// generations: <dir>/gen-<id> holds one, and the symlink <dir>/current names
// the one builds read. A build mounts the generation itself, read-only, for
// its whole run, so a promotion never changes or removes files under a
// running build: it adds a generation and swaps the link (a rename, atomic),
// and the generation it replaced goes only once no build holds it. Going is
// a rename into trash under the lock, O(1); the bytes go on the cell's
// sweep, never on a build's path.
type Generations struct {
	// root holds the environments' cache directories (<root>/<env>/<service>); trash what was retired, until Sweep removes it.
	root, trash string
	mu          sync.Mutex
	// held counts the builds reading each generation (its path).
	held map[string]int
	seq  int
	// clock stamps generation and trash names; seq keeps two of the same
	// instant apart.
	clock clock.Clock
}

// New keeps the caches under root and retires generations into trash; clk
// nil is the wall clock.
func New(root, trash string, clk clock.Clock) *Generations {
	return &Generations{root: root, trash: trash, held: map[string]int{}, clock: clock.Or(clk)}
}

const (
	currentLink = "current"
	genPrefix   = "gen-"
)

// currentLocked is the generation <dir>/current names, when it holds a
// cache. The caller holds c.mu.
func (c *Generations) currentLocked(dir string) string {
	name, err := os.Readlink(filepath.Join(dir, currentLink))
	// The link is the cell's own, in a directory only the cell writes;
	// anything but a generation's bare name is not one it made.
	if err != nil || name != filepath.Base(name) || !strings.HasPrefix(name, genPrefix) {
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
func (c *Generations) Acquire(dir string) (gen string, release func()) {
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

func (c *Generations) release(dir, gen string) {
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
func (c *Generations) Promote(from, dir string) error {
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
	name := genPrefix + id
	if err := os.Rename(from, filepath.Join(dir, name)); err != nil {
		return err
	}
	old := c.currentLocked(dir)
	link := filepath.Join(dir, currentLink+".tmp-"+id)
	if err := os.Symlink(name, link); err != nil {
		return errors.Join(err, c.retireLocked(filepath.Join(dir, name)))
	}
	if err := os.Rename(link, filepath.Join(dir, currentLink)); err != nil {
		return errors.Join(err, os.Remove(link), c.retireLocked(filepath.Join(dir, name)))
	}
	if old != "" && c.held[old] == 0 {
		return c.retireLocked(old)
	}
	return nil
}

// retireLocked takes a generation out of the tree; Sweep removes its bytes.
func (c *Generations) retireLocked(gen string) error {
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
func (c *Generations) Sweep() error {
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

func (c *Generations) sweepDir(dir string) error {
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
		if e.Name() == currentLink || p == current || c.held[p] > 0 {
			continue
		}
		errs = append(errs, c.retireLocked(p))
	}
	return errors.Join(errs...)
}
