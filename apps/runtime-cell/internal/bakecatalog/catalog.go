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
	"strconv"
	"strings"
	"sync"
	"time"

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
	ID          string `json:"id"`
	Cell        string `json:"cell"`
	Org         string `json:"org"`
	Environment string `json:"environment"`
	SHA         string `json:"sha"`
	RecipeSHA   string `json:"recipeSha"`
	// RefsDigest is the bake key of an environment of several
	// repositories (image.bake refsDigest, RefsDigest): every repository's
	// commit and the recipe. Empty for one repository, whose key is SHA;
	// left out of the file then, so a catalog of one-repository bakes reads
	// and writes as it always did.
	RefsDigest string            `json:"refsDigest,omitempty"`
	Nonce      string            `json:"nonce"`
	Images     map[string]string `json:"images"`
	Volumes    map[string]string `json:"volumes"`
}

// Key is what the generation was baked from: RefsDigest for an environment
// of several repositories (the default-branch commit of one says nothing of
// the others'), SHA for one.
func (g Generation) Key() string {
	if g.RefsDigest != "" {
		return g.RefsDigest
	}
	return g.SHA
}

// IsRefsDigest reports whether s is a bake key RefsDigest writes.
func IsRefsDigest(s string) bool {
	hex, ok := strings.CutPrefix(s, "sha256:")
	return ok && IsHex(hex, 64)
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
	// Adopt, when set, lets this cell take over a catalog another cell of
	// the same disk lineage wrote (a host made from a saved template): see
	// Adoption. Nil refuses every catalog of another cell, as it always did.
	Adopt *Adoption
	// Quarantined hears a catalog Open could not accept and moved aside (the
	// cell then starts with an empty one). Nil: nobody listens.
	Quarantined func(Quarantine)
	// Now is the clock of a quarantined file's name; nil is time.Now.
	Now func() time.Time
}

// Adoption is the one case a catalog of another cell is kept: the cell was
// told by the hub which org it serves, and the host is a fleet host whose
// disk was copied from a template. The caller proves both before it sets it.
type Adoption struct {
	// Org is the only org whose generations are kept; the rest are retired
	// for their artifacts to be removed, never used.
	Org string
	// Valid returns the validator of the generations the owner cell made
	// (the driver's: its names embed the owner's id), or nil when owner is
	// not a cell id the driver would have named artifacts after.
	Valid func(owner string) func(g Generation) bool
}

// Adopted says what taking over a catalog changed.
type Adopted struct {
	// From is the cell that wrote the catalog. Names of its generations
	// embed that id, so it stays the catalog's owner.
	From string
	// Kept is how many eligible generations are of the adopted org, Retired
	// how many generations (eligible or not) are left for removal.
	Kept, Retired int
}

// Quarantine reports a catalog moved to File because it could not be used.
type Quarantine struct {
	// Reason is corrupt (not what this package writes), unsafe (a link or
	// loose permissions), unreadable, foreign_driver, foreign_cell or invalid
	// (a generation the driver would not make).
	Reason string
	// File is the name it was moved to.
	File string
	// Owner is the cell that wrote it, when it could be read.
	Owner string
	// Eligible and Retired are the generations it held, when it could be read.
	Eligible, Retired int
}

// quarantinePrefix names a catalog moved aside; at most one is kept.
const quarantinePrefix = FileName + ".foreign-"

// Catalog is the open catalog of one cell. Its methods are safe for
// concurrent use.
type Catalog struct {
	cfg      Config
	owner    string
	adopted  *Adopted
	validate func(Generation) bool
	mu       sync.Mutex
	root     *os.Root
	lock     *os.File
	state    state
	holds    map[string]int
	closed   bool
	syncDir  func(*os.File) error
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
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
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
		_ = r.Close()
		return nil, err
	}
	fail := func(err error) (*Catalog, error) { _ = lock.Close(); _ = r.Close(); return nil, err }
	info, err := lock.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return fail(errors.New("bakecatalog: unsafe lock"))
	}
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return fail(errors.New("bakecatalog: already controlled"))
	}
	// Only the exclusive controller may remove abandoned atomic-write files.
	// Names and file type are fixed; nothing from a checkout is traversed.
	// One that cannot be removed is left: nothing ever reads it.
	dir, err := r.Open(".")
	if err != nil {
		return fail(err)
	}
	defer func() { _ = dir.Close() }()
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
			_ = r.Remove(entry.Name())
		}
		if errors.Is(err, io.EOF) {
			break
		}
	}
	syncDir := cfg.SyncDir
	if syncDir == nil {
		syncDir = func(f *os.File) error { return f.Sync() }
	}
	c := &Catalog{
		cfg: cfg, owner: cfg.Cell, validate: cfg.Valid, root: r, lock: lock, holds: map[string]int{}, unconfirmed: map[string]bool{}, syncDir: syncDir,
		state: state{Version: 1, Cell: cfg.Cell, Driver: cfg.Driver, Generations: map[string]Generation{}, Current: map[string]string{}, Retired: map[string]Generation{}},
	}
	// A catalog this cell cannot accept never stops it: it is moved aside
	// and the cell starts with an empty one. The artifacts it named stay
	// for whoever owns them; a cell never removes what is not its own.
	quarantine := func(reason string, read *state) (*Catalog, error) {
		q := Quarantine{Reason: reason}
		if read != nil {
			q.Owner, q.Eligible, q.Retired = read.Cell, len(read.Generations), len(read.Retired)
		}
		name, err := c.quarantine()
		if err != nil {
			return fail(err)
		}
		q.File = name
		if cfg.Quarantined != nil {
			cfg.Quarantined(q)
		}
		return c, nil
	}
	f, err := r.OpenFile(FileName, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return quarantine("unreadable", nil)
	}
	info, statErr := f.Stat()
	if statErr != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > maxBytes {
		_ = f.Close()
		return quarantine("unsafe", nil)
	}
	raw, readErr := io.ReadAll(io.LimitReader(f, maxBytes+1))
	_ = f.Close()
	var read state
	if readErr != nil || len(raw) > maxBytes || json.Unmarshal(raw, &read) != nil {
		return quarantine("corrupt", nil)
	}
	// Only our canonical representation is accepted. This also refuses
	// duplicate/unknown/case-aliased keys and trailing JSON.
	if canonical, marshalErr := json.Marshal(read); marshalErr != nil || !bytes.Equal(raw, canonical) {
		return quarantine("corrupt", nil)
	}
	switch {
	case read.Driver != cfg.Driver:
		return quarantine("foreign_driver", &read)
	case read.Cell != cfg.Cell:
		if cfg.Adopt == nil || cfg.Adopt.Valid == nil || cfg.Adopt.Org == "" {
			return quarantine("foreign_cell", &read)
		}
		validate := cfg.Adopt.Valid(read.Cell)
		if validate == nil || !wellFormed(read, cfg.Driver, read.Cell, validate) {
			return quarantine("foreign_cell", &read)
		}
		c.state, c.owner, c.validate = read, read.Cell, validate
		c.adopt(cfg.Adopt.Org)
		if err := c.saveLocked(); err != nil && !errors.Is(err, ErrCommitUncertain) {
			return fail(err)
		}
	case !wellFormed(read, cfg.Driver, cfg.Cell, cfg.Valid):
		return quarantine("invalid", &read)
	default:
		c.state = read
	}
	return c, nil
}

// adopt keeps the generations of org and retires the rest, for the driver to
// remove their artifacts: the catalog came from another cell's disk and
// nothing but the org this cell serves is theirs to use.
func (c *Catalog) adopt(org string) {
	s := &c.state
	a := Adopted{From: s.Cell}
	for id, g := range s.Generations {
		if g.Org != org {
			s.Retired[id] = g
			delete(s.Generations, id)
			delete(s.Current, scope(g.Org, g.Environment))
		}
	}
	a.Kept, a.Retired = len(s.Generations), len(s.Retired)
	c.adopted = &a
}

// Owner is the cell id the catalog's generations are named after: the cell's
// own, or the one it adopted the catalog from.
func (c *Catalog) Owner() string { return c.owner }

// Adopted reports whether Open took over another cell's catalog.
func (c *Catalog) Adopted() (Adopted, bool) {
	if c.adopted == nil {
		return Adopted{}, false
	}
	return *c.adopted, true
}

// quarantine moves the unusable catalog to catalog.json.foreign-<unix>, after
// removing an earlier one: at most one is kept.
func (c *Catalog) quarantine() (string, error) {
	dir, err := c.root.Open(".")
	if err != nil {
		return "", err
	}
	defer func() { _ = dir.Close() }()
	names, err := dir.Readdirnames(-1)
	if err != nil {
		return "", err
	}
	for _, n := range names {
		if strings.HasPrefix(n, quarantinePrefix) {
			if err := c.root.Remove(n); err != nil {
				return "", err
			}
		}
	}
	now := time.Now
	if c.cfg.Now != nil {
		now = c.cfg.Now
	}
	name := quarantinePrefix + strconv.FormatInt(now().Unix(), 10)
	if err := c.root.Rename(FileName, name); err != nil {
		return "", err
	}
	if err := c.syncDir(dir); err != nil {
		return "", err
	}
	return name, nil
}

// wellFormed is whether s is a catalog of this driver, written by cell, whose
// every generation validate accepts.
func wellFormed(s state, driver, cell string, validate func(Generation) bool) bool {
	if s.Version != 1 || s.Driver != driver || s.Cell != cell || s.Generations == nil || s.Current == nil || s.Retired == nil || len(s.Generations)+len(s.Retired) > MaxGenerations || len(s.Current) > MaxGenerations {
		return false
	}
	for id := range s.Generations {
		if g := s.Generations[id]; id != g.ID || !validate(g) {
			return false
		}
	}
	for id := range s.Retired {
		if g := s.Retired[id]; id != g.ID || !validate(g) {
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
	defer func() { _ = c.root.Remove(tmp) }() // gone after the rename: nothing to report
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
	if c.closed || !ok || g.Cell != c.owner || g.Org != org || g.Environment != env {
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
	if !c.validate(g) || len(c.state.Generations)+len(c.state.Retired) >= MaxGenerations {
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
	for id := range c.state.Generations {
		g := c.state.Generations[id]
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
	for id := range next {
		if g := next[id]; old.Current[scope(g.Org, g.Environment)] != id && c.holds[id] == 0 && !c.unconfirmed[id] {
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
	for id := range retired {
		if c.holds[id] == 0 {
			drop = append(drop, retired[id])
		}
	}
	c.mu.Unlock()
	var errs []error
	for i := range drop {
		g := &drop[i]
		if err := remove(*g); err != nil {
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

// Retire makes an eligible generation retired, for Prune to remove its
// artifacts: the driver found them gone or not its own. False when id is not
// eligible or is held.
func (c *Catalog) Retire(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	g, ok := c.state.Generations[id]
	if c.closed || !ok || c.holds[id] > 0 {
		return false
	}
	old := c.state
	c.state.Generations, c.state.Retired, c.state.Current = maps.Clone(old.Generations), maps.Clone(old.Retired), maps.Clone(old.Current)
	delete(c.state.Generations, id)
	c.state.Retired[id] = g
	if c.state.Current[scope(g.Org, g.Environment)] == id {
		delete(c.state.Current, scope(g.Org, g.Environment))
	}
	delete(c.unconfirmed, id)
	if err := c.saveLocked(); err != nil && !errors.Is(err, ErrCommitUncertain) {
		c.state = old
		return false
	}
	return true
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
