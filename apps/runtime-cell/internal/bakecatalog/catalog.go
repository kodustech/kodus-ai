// Package bakecatalog is the durable record of an environment's baked
// generations: which exist, which one each environment boots from, and which
// are retired and waiting for their artifacts to go.
//
// A generation is immutable: a new bake of the same commit is another
// generation. It is staged (retired, held) before any artifact is made,
// published once every artifact exists, and retired again when a newer one
// is current and nothing holds it. A crash at any point leaves cleanup work,
// never an eligible partial generation.
//
// The catalog is one JSON file in a directory only the cell reaches, written
// by rename under an exclusive lock. It knows no backend: the driver says
// which generations are its own (Config.Valid) and removes the artifacts of
// the ones the catalog drops (Prune).
package bakecatalog

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"os"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

const (
	// MaxGenerations bounds eligible plus retired generations of one cell.
	MaxGenerations = 1024
	// FileName is the catalog's file in its directory.
	FileName = "catalog.json"

	maxBytes = 4 << 20
)

var (
	// ErrCommitUncertain: the catalog was renamed into place but the rename
	// may not be durable. The change is kept in memory: it may have landed.
	ErrCommitUncertain = errors.New("bakecatalog: commit durability uncertain")
	// ErrLimit: the catalog holds MaxGenerations, or would pass its size.
	ErrLimit = errors.New("bakecatalog: limit")
	// ErrClosed: the catalog was closed.
	ErrClosed = errors.New("bakecatalog: closed")
)

// Generation is one bake. It is published only after all its immutable
// artifacts exist. Holds are deliberately not persisted: old machines must
// be reaped before recovery, never resurrected with an empty lease or memory
// ledger.
type Generation struct {
	ID          string            `json:"id"`
	Cell        string            `json:"cell"`
	Org         string            `json:"org"`
	Environment string            `json:"environment"`
	SHA         string            `json:"sha"`
	RecipeSHA   string            `json:"recipeSha"`
	Nonce       string            `json:"nonce"`
	Images      map[string]string `json:"images"`
	Volumes     map[string]string `json:"volumes"`
}

// scope names the environment a generation is current for.
func scope(org, env string) string { return org + "/" + env }

type state struct {
	Version     int                   `json:"version"`
	Cell        string                `json:"cell"`
	Driver      string                `json:"driver"`
	Generations map[string]Generation `json:"generations"`
	Current     map[string]string     `json:"current"`
	Retired     map[string]Generation `json:"retired"`
}

// Config is what Open needs.
type Config struct {
	// Dir is a directory only the cell reaches; the caller made it so.
	Dir string
	// Cell and Driver are who owns the catalog: one written by another cell
	// or another driver is refused.
	Cell, Driver string
	// Valid reports whether g is a generation this driver makes for this
	// cell: its id and the names of its artifacts. Anything else is refused,
	// on read and on write.
	Valid func(g Generation) bool
	// SyncDir makes a rename in the directory durable; nil syncs it.
	SyncDir func(dir *os.File) error
}

// Catalog is the open catalog of one cell. Its methods are safe for
// concurrent use.
type Catalog struct {
	cfg     Config
	mu      sync.Mutex
	root    *os.Root
	lock    *os.File
	state   state
	holds   map[string]int
	closed  bool
	syncDir func(*os.File) error
	// Previous and current generations survive the gap between publication
	// and the caller installing its latest pointer (Acknowledge), including
	// uncertain commits.
	unconfirmed map[string]bool
}

// IsHex reports whether s is size lowercase hexadecimal digits.
func IsHex(s string, size int) bool {
	if len(s) != size {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// Open takes exclusive control of the catalog in cfg.Dir and reads it. A
// catalog another process controls, or one that is not exactly what this
// package writes, is refused.
func Open(ctx context.Context, cfg Config) (*Catalog, error) {
	if cfg.Valid == nil {
		return nil, errors.New("bakecatalog: a generation validator is required")
	}
	r, err := os.OpenRoot(cfg.Dir)
	if err != nil {
		return nil, err
	}
	lock, err := r.OpenFile("lock", os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0o600)
	if err != nil {
		r.Close()
		return nil, err
	}
	fail := func(err error) (*Catalog, error) { lock.Close(); r.Close(); return nil, err }
	info, err := lock.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return fail(errors.New("bakecatalog: unsafe lock"))
	}
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return fail(errors.New("bakecatalog: already controlled"))
	}
	// Only the exclusive controller may remove abandoned atomic-write files.
	// Names and file type are fixed; nothing from a checkout is traversed.
	dir, err := r.Open(".")
	if err != nil {
		return fail(err)
	}
	defer dir.Close()
	for {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		entries, err := dir.ReadDir(128)
		if err != nil && !errors.Is(err, io.EOF) {
			return fail(err)
		}
		for _, entry := range entries {
			if !strings.HasPrefix(entry.Name(), "pending-") || !IsHex(strings.TrimPrefix(entry.Name(), "pending-"), 24) {
				continue
			}
			info, err := r.Lstat(entry.Name())
			if err != nil {
				return fail(err)
			}
			if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
				return fail(errors.New("bakecatalog: unsafe pending file"))
			}
			if err := r.Remove(entry.Name()); err != nil {
				return fail(err)
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
	}
	syncDir := cfg.SyncDir
	if syncDir == nil {
		syncDir = func(f *os.File) error { return f.Sync() }
	}
	c := &Catalog{cfg: cfg, root: r, lock: lock, holds: map[string]int{}, unconfirmed: map[string]bool{}, syncDir: syncDir,
		state: state{Version: 1, Cell: cfg.Cell, Driver: cfg.Driver, Generations: map[string]Generation{}, Current: map[string]string{}, Retired: map[string]Generation{}}}
	f, err := r.OpenFile(FileName, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err == nil {
		info, statErr := f.Stat()
		if statErr != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > maxBytes {
			f.Close()
			return fail(errors.New("bakecatalog: unsafe catalog file"))
		}
		raw, readErr := io.ReadAll(io.LimitReader(f, maxBytes+1))
		f.Close()
		if readErr != nil || len(raw) > maxBytes || json.Unmarshal(raw, &c.state) != nil {
			return fail(errors.New("bakecatalog: invalid catalog"))
		}
		canonical, marshalErr := json.Marshal(c.state)
		// Only our canonical representation is accepted. This also refuses
		// duplicate/unknown/case-aliased keys and trailing JSON.
		if marshalErr != nil || !bytes.Equal(raw, canonical) || !c.valid() {
			return fail(errors.New("bakecatalog: invalid catalog"))
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fail(err)
	}
	return c, nil
}

func (c *Catalog) valid() bool {
	s := c.state
	if s.Version != 1 || s.Driver != c.cfg.Driver || s.Cell != c.cfg.Cell || s.Generations == nil || s.Current == nil || s.Retired == nil || len(s.Generations)+len(s.Retired) > MaxGenerations || len(s.Current) > MaxGenerations {
		return false
	}
	for id, g := range s.Generations {
		if id != g.ID || !c.cfg.Valid(g) {
			return false
		}
	}
	for id, g := range s.Retired {
		if id != g.ID || !c.cfg.Valid(g) {
			return false
		}
		if _, eligible := s.Generations[id]; eligible {
			return false
		}
	}
	for sc, id := range s.Current {
		g, ok := s.Generations[id]
		if !ok || sc != scope(g.Org, g.Environment) {
			return false
		}
	}
	return true
}

// saveLocked publishes metadata after artifacts, never before. A failed
// write keeps the previous eligible generation and leaves only orphans.
func (c *Catalog) saveLocked() error {
	if c.closed {
		return ErrClosed
	}
	raw, err := json.Marshal(c.state)
	if err != nil || len(raw) > maxBytes {
		return ErrLimit
	}
	var nonce [12]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	tmp := "pending-" + hex.EncodeToString(nonce[:])
	f, err := c.root.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer c.root.Remove(tmp)
	_, err = f.Write(raw)
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	if err = c.root.Rename(tmp, FileName); err != nil {
		return err
	}
	dir, err := c.root.Open(".")
	if err != nil {
		return errors.Join(ErrCommitUncertain, err)
	}
	if err := errors.Join(c.syncDir(dir), dir.Close()); err != nil {
		return errors.Join(ErrCommitUncertain, err)
	}
	return nil
}

// releaser gives back one hold of id, once.
func (c *Catalog) releaser(id string) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			c.mu.Lock()
			if c.holds[id] <= 1 {
				delete(c.holds, id)
			} else {
				c.holds[id]--
			}
			c.mu.Unlock()
		})
	}
}

// Hold keeps the eligible generation id of the environment from being
// dropped until release; false when it is not eligible for that environment.
func (c *Catalog) Hold(id, org, env string) (g Generation, release func(), ok bool) {
	c.mu.Lock()
	g, ok = c.state.Generations[id]
	if c.closed || !ok || g.Cell != c.cfg.Cell || g.Org != org || g.Environment != env {
		c.mu.Unlock()
		return Generation{}, nil, false
	}
	c.holds[id]++
	c.mu.Unlock()
	return g, c.releaser(id), true
}

// Stage records exact intended artifacts before any is created, held until
// release. A crash leaves cleanup work, never an eligible partial generation.
func (c *Catalog) Stage(g Generation) (release func(), err error) {
	g.Images = maps.Clone(g.Images)
	g.Volumes = maps.Clone(g.Volumes)
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.cfg.Valid(g) || len(c.state.Generations)+len(c.state.Retired) >= MaxGenerations {
		return nil, ErrLimit
	}
	old := c.state.Retired
	c.state.Retired = maps.Clone(old)
	c.state.Retired[g.ID] = g
	if err := c.saveLocked(); err != nil {
		if !errors.Is(err, ErrCommitUncertain) {
			c.state.Retired = old
		}
		return nil, err
	}
	c.holds[g.ID]++
	return c.releaser(g.ID), nil
}

// Publish makes g eligible and its environment's current generation. The
// caller has checked that every artifact of g exists. Until Acknowledge, g
// and the generation it replaced both stay.
func (c *Catalog) Publish(g Generation) error {
	g.Images = maps.Clone(g.Images)
	g.Volumes = maps.Clone(g.Volumes)
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.state.Generations)+len(c.state.Retired) >= MaxGenerations && c.state.Retired[g.ID].ID == "" {
		return ErrLimit
	}
	old := c.state
	c.state.Generations = maps.Clone(old.Generations)
	c.state.Current = maps.Clone(old.Current)
	c.state.Retired = maps.Clone(old.Retired)
	delete(c.state.Retired, g.ID)
	c.state.Generations[g.ID] = g
	c.state.Current[scope(g.Org, g.Environment)] = g.ID
	err := c.saveLocked()
	if err != nil && !errors.Is(err, ErrCommitUncertain) {
		c.state = old
		return err
	}
	c.unconfirmed[g.ID] = true
	if prev := old.Current[scope(g.Org, g.Environment)]; prev != "" {
		c.unconfirmed[prev] = true
	}
	return err
}

// Acknowledge follows the caller's latest-pointer update to id: the
// generations of id's environment are no longer kept for it. False when id
// is not its environment's current generation. Before it, old eligibility
// stays usable even if publication returned an uncertain error.
func (c *Catalog) Acknowledge(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	g, ok := c.state.Generations[id]
	if !ok || c.state.Current[scope(g.Org, g.Environment)] != id {
		return false
	}
	for pending := range c.unconfirmed {
		p, ok := c.state.Generations[pending]
		if ok && scope(p.Org, p.Environment) == scope(g.Org, g.Environment) {
			delete(c.unconfirmed, pending)
		}
	}
	return true
}

// Each calls fn for every eligible generation, with whether it is its
// environment's current one, and stops at the first error. It runs under
// the catalog's lock: fn must not call the catalog.
func (c *Catalog) Each(fn func(g Generation, current bool) error) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, g := range c.state.Generations {
		if err := fn(g, c.state.Current[scope(g.Org, g.Environment)] == id); err != nil {
			return err
		}
	}
	return nil
}

// Prune first removes eligibility durably: a generation that is not current,
// not held and not waiting for an Acknowledge is retired. Then remove takes
// the artifacts of each retired generation nothing holds, and one whose
// artifacts went leaves the catalog. Holds exclude generations being copied,
// tagged or used by a live machine, without blocking new publication.
func (c *Catalog) Prune(remove func(g Generation) error) error {
	c.mu.Lock()
	old := c.state
	next := maps.Clone(old.Generations)
	retired := maps.Clone(old.Retired)
	changed := false
	for id, g := range next {
		if old.Current[scope(g.Org, g.Environment)] != id && c.holds[id] == 0 && !c.unconfirmed[id] {
			retired[id] = g
			delete(next, id)
			changed = true
		}
	}
	if changed {
		c.state.Generations, c.state.Retired = next, retired
		if err := c.saveLocked(); err != nil {
			if !errors.Is(err, ErrCommitUncertain) {
				c.state = old
			}
			c.mu.Unlock()
			return err
		}
	}
	var drop []Generation
	for id, g := range retired {
		if c.holds[id] == 0 {
			drop = append(drop, g)
		}
	}
	c.mu.Unlock()
	var errs []error
	for _, g := range drop {
		if err := remove(g); err != nil {
			errs = append(errs, err)
			continue
		}
		c.mu.Lock()
		oldRetired := c.state.Retired
		c.state.Retired = maps.Clone(oldRetired)
		delete(c.state.Retired, g.ID)
		if err := c.saveLocked(); err != nil {
			if !errors.Is(err, ErrCommitUncertain) {
				c.state.Retired = oldRetired
			}
			errs = append(errs, err)
		}
		c.mu.Unlock()
	}
	return errors.Join(errs...)
}

// Lookup is the generation id as the catalog holds it now: eligible, retired
// (staged or waiting for its artifacts to go), or neither.
func (c *Catalog) Lookup(id string) (g Generation, eligible, retired bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if g, ok := c.state.Generations[id]; ok {
		return g, true, false
	}
	g, retired = c.state.Retired[id]
	return g, false, retired
}

// Current is the id of the environment's current generation, or "".
func (c *Catalog) Current(org, env string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state.Current[scope(org, env)]
}

// Counts is how many generations are eligible, how many retired, and how
// many are held.
func (c *Catalog) Counts() (eligible, retired, held int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.state.Generations), len(c.state.Retired), len(c.holds)
}

// Closed reports whether Close was called.
func (c *Catalog) Closed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// Close gives up control of the catalog. It is safe to call twice.
func (c *Catalog) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	return errors.Join(c.lock.Close(), c.root.Close())
}
