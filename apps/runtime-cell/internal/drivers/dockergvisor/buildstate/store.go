// Package buildstate keeps BuildKit's state per environment.
//
// BuildKit's state (its layer snapshots and the RUN --mount=type=cache
// directories, where a Go or JS build keeps its compile and module caches)
// persists per environment, so the next setup of the default branch and
// every pull request compile only what changed instead of the whole
// repository. It goes one way, as the images and the exported cache (S-52):
//
//   - a setup of the default branch (SeedsCache) mounts the environment's
//     state directly and writes it;
//   - every other build mounts a copy-on-write view of it, dropped when the
//     build ends, so nothing a pull request wrote is ever read by a later
//     build: a reflink clone where the filesystem has reflinks, the
//     kernel's overlay elsewhere (lower: the environment's, upper: the
//     machine's; see cloneMounter for what the overlay cannot do);
//   - a state another build holds the other way, or a cell that can make
//     neither view (not root, not Linux), leaves the build on its own
//     throwaway state and the exported cache, as before.
//
// A state is one environment's (cell, org, environment in its key), never
// shared across tenants: BuildKit's cache mount ids are global to a daemon.
package buildstate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
)

// Request is one build asking for its environment's state. Seeds is
// true only for a setup of the default branch (S-52): the one build that
// may write it.
type Request struct {
	Machine, Service, Org, Env string
	Seeds                      bool
}

// The two ways a build holds its environment's state.
const (
	ModeSeed    = "seed"    // the one build that writes it
	ModeOverlay = "overlay" // a copy-on-write view, dropped with the build
)

// State is what one build mounts as BuildKit's root.
type State struct {
	Dir  string // what the build mounts
	Mode string // ModeSeed | ModeOverlay
	// Fresh: a seed that found no state (never seeded, or evicted) and
	// starts an empty one.
	Fresh bool
	// env is the environment's state the build holds; overlay is the
	// machine's overlay directory ("" for a seed).
	env, overlay string
	machine      string
	// since is when a seed took the state, on the store's clock: a fresh
	// seed's hold is the state's rebuild cost (cost.go).
	since time.Time
}

// Mounter makes and removes the overlay a non-seeding build reads the
// environment's state through.
type Mounter interface {
	Overlay(lower, upper, work, target string) error
	Unmount(target string) error
	// Mounted lists the overlays mounted at or under the directory.
	Mounted(under string) ([]OverlayMount, error)
}

// Store keeps the environments' states under root: env/<key> is an
// environment's, machine/<machine>/<service> a build's overlay, and trash
// what eviction took out of env before its bytes go.
type Store struct {
	root   string
	cellID string
	// minFree is the disk floor Evict keeps; zero: no eviction.
	minFree int64
	// builderDir makes a directory only the builder can use.
	builderDir func(p string) error
	mounter    Mounter
	freeBytes  func(path string) (int64, error)
	// clock stamps a state's last use, which orders eviction, and the
	// names of what goes to the trash.
	clock clock.Clock
	log   *slog.Logger

	// seedWait bounds how long a seed waits for a state's readers to go.
	seedWait time.Duration

	// holds is who holds each environment's state (its dir); no entry:
	// nobody. One seeding build, or any number of overlays reading a
	// state, never both: an overlay's lower directory must not change
	// under it.
	mu    sync.Mutex
	holds map[string]*stateHold
	// stuck are the overlays whose unmount failed (overlays.go).
	stuck []stuckOverlay
	seq   int

	// removing are the trash entries a released view's removal is still
	// deleting; Evict leaves them to it. removeAll deletes one (os.RemoveAll).
	removing  map[string]bool
	removeAll func(string) error
	removals  sync.WaitGroup

	// Spare views (spare.go): spareViews says this store makes them (a
	// clone mounter: a view is a plain directory a rename can move). gen
	// counts each state's seeds; spares holds one made view per state, at
	// the gen it was made at; making holds the states whose spare is being
	// made.
	spareViews bool
	gen        map[string]uint64
	spares     map[string]spareView
	making     map[string]bool
	spareWork  sync.WaitGroup

	// evicted is the ledger of the states eviction removed (evicted.go), by
	// their directory's name, until a seed makes each again.
	evicted map[string]Evicted
}

// stateHold is who holds one environment's state. Writers come first: a
// seed that finds readers waits for them, and no new reader enters
// meanwhile (it builds from the exported cache), or a steady stream of
// pull requests would keep the state read and never let the default
// branch's setup write it.
type stateHold struct {
	readers int
	seed    seedPhase
	// drained is closed when the last reader goes while a seed waits.
	drained chan struct{}
}

type seedPhase int

const (
	seedNone seedPhase = iota
	// seedWaiting: a seed waits for the readers to go; no reader enters.
	seedWaiting
	seedHeld
)

// defaultSeedWait is about one pull request's build: long enough for the
// readers a seed finds to finish, short enough that a setup never stalls
// on a state it cannot get.
const defaultSeedWait = 5 * time.Minute

// Config is what New needs; Clock nil is the wall clock.
type Config struct {
	Root, CellID string
	MinFree      int64
	// BuilderDir makes p a directory only the builder (and root) can use.
	BuilderDir func(p string) error
	Mounter    Mounter
	FreeBytes  func(path string) (int64, error)
	Clock      clock.Clock
	Log        *slog.Logger
	// SeedWait bounds a seed's wait for readers; zero: defaultSeedWait.
	SeedWait time.Duration
	// SpareViews makes a view of each state ahead of the build that will
	// take it (spare.go). Only with a mounter whose view is a plain
	// directory (a clone): a mounted overlay cannot be moved.
	SpareViews bool
}

// New also unmounts the overlays a crashed cell left (see
// recoverOverlays) before it returns, so no seed writes under one.
func New(c Config) (*Store, error) {
	if c.SeedWait <= 0 {
		c.SeedWait = defaultSeedWait
	}
	s := &Store{
		root: c.Root, cellID: c.CellID, minFree: c.MinFree, builderDir: c.BuilderDir, mounter: c.Mounter, freeBytes: c.FreeBytes,
		clock: clock.Or(c.Clock), log: c.Log, seedWait: c.SeedWait, holds: map[string]*stateHold{},
		removing: map[string]bool{}, removeAll: os.RemoveAll,
		spareViews: c.SpareViews, gen: map[string]uint64{}, spares: map[string]spareView{}, making: map[string]bool{},
		evicted: map[string]Evicted{},
	}
	s.loadEvicted()
	if err := s.recoverOverlays(); err != nil {
		return nil, fmt.Errorf("buildstate: overlays: %w", err)
	}
	if err := s.dropLeftoverSpares(); err != nil {
		return nil, fmt.Errorf("buildstate: spares: %w", err)
	}
	return s, nil
}

// EnvKey names an environment's directories: cell, org and environment,
// length-prefixed so no two triples collide.
func EnvKey(cell, org, env string) string {
	h := sha256.New()
	for _, p := range []string{cell, org, env} {
		fmt.Fprintf(h, "%d:%s", len(p), p)
	}
	return hex.EncodeToString(h.Sum(nil))[:32]
}

func (s *Store) EnvDir(org, env string) string {
	return filepath.Join(s.root, "env", EnvKey(s.cellID, org, env))
}

func (s *Store) Acquire(ctx context.Context, req Request) (State, bool) {
	if req.Org == "" || req.Env == "" {
		return State{}, false
	}
	dir := s.EnvDir(req.Org, req.Env)
	var locked bool
	if req.Seeds {
		locked = s.lockSeed(ctx, dir)
	} else {
		locked = s.lockReader(dir)
	}
	if !locked {
		s.log.Info("build.state.busy", "machine", req.Machine, "service", req.Service, "seeds", req.Seeds)
		return State{}, false
	}
	if req.Seeds {
		_, statErr := os.Stat(dir)
		fresh := statErr != nil
		if err := s.builderDir(dir); err != nil {
			s.unlock(dir, true)
			s.log.Warn("build.state.failed", "machine", req.Machine, "err", err)
			return State{}, false
		}
		s.touch(dir)
		s.own(dir, req.Org, req.Env)
		s.forgetEvicted(dir)
		return State{Dir: dir, Mode: ModeSeed, Fresh: fresh, env: dir, machine: req.Machine, since: s.clock.Now()}, true
	}
	// Nothing seeded yet: an overlay of nothing is a throwaway state.
	if _, err := os.Stat(dir); err != nil {
		s.unlock(dir, false)
		if at, evicted := s.EvictedAt(req.Org, req.Env); evicted {
			// The build runs cold because the disk floor took the state: said
			// here, and to the hub through the ledger (evicted.go).
			s.log.Warn("build.state.missing", "machine", req.Machine, "service", req.Service, "evicted", true, "evictedAt", at)
		}
		return State{}, false
	}
	base := filepath.Join(s.root, "machine", req.Machine, req.Service)
	st := State{Dir: filepath.Join(base, "merged"), Mode: ModeOverlay, env: dir, overlay: base, machine: req.Machine}
	upper, work := filepath.Join(base, "upper"), filepath.Join(base, "work")
	fail := func(event string, err error) (State, bool) {
		_ = os.RemoveAll(base)
		s.unlock(dir, false)
		if err != nil {
			s.log.Warn(event, "machine", req.Machine, "err", err)
		}
		return State{}, false
	}
	if s.mounter == nil {
		return fail("", nil)
	}
	began := time.Now()
	if s.takeSpare(dir, base) {
		s.log.Info("build.state.view", "machine", req.Machine, "service", req.Service, "ms", time.Since(began).Milliseconds(), "spare", true)
		s.touch(dir)
		s.own(dir, req.Org, req.Env)
		return st, true
	}
	// Before the mount: the overlay's lower directory is not written under it.
	s.own(dir, req.Org, req.Env)
	for _, p := range []string{upper, work, st.Dir} {
		if err := s.builderDir(p); err != nil {
			return fail("build.state.failed", err)
		}
	}
	if err := s.mounter.Overlay(dir, upper, work, st.Dir); err != nil {
		return fail("build.state.overlay_failed", err)
	}
	s.log.Info("build.state.view", "machine", req.Machine, "service", req.Service, "ms", time.Since(began).Milliseconds())
	s.touch(dir)
	return st, true
}

func (s *Store) Release(st State) {
	seeds := st.Mode == ModeSeed
	if !seeds {
		// The upper layer goes only once nothing is mounted on it: removing
		// through a live overlay would delete what the build sees.
		// While it stays mounted, the state stays held as by a live reader:
		// a seed writing the lower directory, or eviction removing it,
		// would change it under the overlay.
		if err := s.mounter.Unmount(st.Dir); err != nil {
			s.log.Warn("build.state.unmount.failed", "machine", st.machine, "err", err, "alarm", true)
			s.quarantine(stuckOverlay{target: st.Dir, base: st.overlay, env: st.env})
			return
		}
		s.removeView(st)
	}
	if seeds && st.Fresh {
		// The build made the state from none: what that took is what evicting
		// it costs (cost.go).
		s.recordRebuild(st.env, s.clock.Now().Sub(st.since))
	}
	s.unlock(st.env, seeds)
	// The next build of this environment finds its view made.
	s.makeSpare(st.env)
}

// removeView takes a released view out of the tree and deletes it after,
// off the build's path: a clone of a large state holds hundreds of thousands
// of entries, and deleting them took about 25 s of a PR side's boot on a
// large TypeScript monorepo. Nothing reads it any more (it is unmounted, and a
// clone shares no file with the state), so only its bytes wait. What a
// restart interrupts stays in the trash, which Evict empties.
func (s *Store) removeView(st State) {
	s.mu.Lock()
	trash, err := s.trashLocked(st.overlay, "view")
	if err == nil {
		s.removing[trash] = true
	}
	s.mu.Unlock()
	if err != nil {
		// Not in the trash: removed here, as before.
		_ = os.RemoveAll(st.overlay)
		return
	}
	s.removals.Add(1)
	go func() {
		defer s.removals.Done()
		began := time.Now()
		err := s.removeAll(trash)
		s.mu.Lock()
		delete(s.removing, trash)
		s.mu.Unlock()
		if err != nil {
			s.log.Warn("build.state.view.remove_failed", "machine", st.machine, "err", err)
			return
		}
		s.log.Info("build.state.view.removed", "machine", st.machine, "ms", time.Since(began).Milliseconds())
	}()
}

// WaitRemovals returns once every released view's removal has ended, for a
// caller that must see the disk settled (a test, a cell that stops).
func (s *Store) WaitRemovals() { s.removals.Wait() }

// Settle returns once no spare is being made and every released view's
// removal has ended: the store's background work, which the driver's
// Shutdown waits for.
func (s *Store) Settle() {
	s.WaitSpares()
	s.WaitRemovals()
}

// lockReader takes the environment's state for one more reader, unless a
// seed holds it or waits for it.
func (s *Store) lockReader(dir string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.holdLocked(dir)
	if h.seed != seedNone {
		s.dropIfFreeLocked(dir)
		return false
	}
	h.readers++
	return true
}

// lockSeed takes the environment's state for its one seed. With readers on
// it, it closes the state to new ones and waits for those to go, at most
// seedWait and while ctx lives; then it gives up and the state is open to
// readers again.
func (s *Store) lockSeed(ctx context.Context, dir string) bool {
	s.mu.Lock()
	h := s.holdLocked(dir)
	switch {
	case h.seed != seedNone:
		s.mu.Unlock()
		return false
	case h.readers == 0:
		h.seed = seedHeld
		s.mu.Unlock()
		return true
	}
	h.seed, h.drained = seedWaiting, make(chan struct{})
	drained := h.drained
	s.mu.Unlock()

	select {
	case <-drained:
	case <-s.clock.After(s.seedWait):
	case <-ctx.Done():
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	h.drained = nil
	// The readers may have gone just as the wait ended: take it then too.
	if h.readers == 0 {
		h.seed = seedHeld
		return true
	}
	h.seed = seedNone
	return false
}

func (s *Store) unlock(dir string, seeds bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.holds[dir]
	if h == nil {
		return
	}
	if seeds {
		h.seed = seedNone
		// The seed may have written the state: a view made before is stale.
		s.gen[dir]++
		s.dropSpareLocked(dir)
	} else if h.readers > 0 {
		if h.readers--; h.readers == 0 && h.drained != nil {
			close(h.drained)
			h.drained = nil
		}
	}
	s.dropIfFreeLocked(dir)
}

// holdLocked is dir's hold, made when nobody holds it. The caller holds s.mu.
func (s *Store) holdLocked(dir string) *stateHold {
	h := s.holds[dir]
	if h == nil {
		h = &stateHold{}
		s.holds[dir] = h
	}
	return h
}

// dropIfFreeLocked forgets dir's hold once nobody holds or waits for it.
func (s *Store) dropIfFreeLocked(dir string) {
	if h := s.holds[dir]; h != nil && h.readers == 0 && h.seed == seedNone {
		delete(s.holds, dir)
	}
}

const stateUsedMark = ".kodus-last-used"

// touch records the state's last use as its mark's mtime, from the store's
// clock: the mark outlives a restart, and eviction orders states by it.
func (s *Store) touch(dir string) {
	now := s.clock.Now()
	f := filepath.Join(dir, stateUsedMark)
	if err := os.Chtimes(f, now, now); errors.Is(err, os.ErrNotExist) {
		// A new mark gets the wall's mtime; stamp it with the clock's too.
		if os.WriteFile(f, nil, 0o600) == nil {
			_ = os.Chtimes(f, now, now)
		}
	}
}

// Evict removes the environment states nobody holds that are cheapest to
// keep (cost.go: rebuild cost weighed by how recently each was used) while
// the cell's disk has less free space than the floor, then whatever an
// earlier sweep took out of the tree and did not finish removing.
// It retries the unmounts that failed first: their states stay held until then.
func (s *Store) Evict() error {
	errs := []error{s.retryStuck(), s.evictCheapest()}
	trash := filepath.Join(s.root, "trash")
	entries, _ := os.ReadDir(trash)
	for _, e := range entries {
		p := filepath.Join(trash, e.Name())
		s.mu.Lock()
		busy := s.removing[p]
		s.mu.Unlock()
		if busy {
			continue // a released view's removal is deleting it
		}
		errs = append(errs, os.RemoveAll(p))
	}
	return errors.Join(errs...)
}

func (s *Store) evictCheapest() error {
	if s.minFree <= 0 || s.freeBytes == nil {
		return nil
	}
	root := filepath.Join(s.root, "env")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil //nolint:nilerr // no env tree to list means nothing to evict; Evict still sweeps the trash
	}
	// Spares first: each is only a head start for one build.
	if s.hasSpares() {
		if free, err := s.freeBytes(root); err == nil && free < s.minFree {
			s.dropSpares()
		}
	}
	var all []evictCandidate
	for i := 0; ; i++ {
		free, err := s.freeBytes(root)
		if err != nil || free >= s.minFree {
			return err
		}
		if all == nil {
			// Ordered only once the disk is below its floor: a tie walks states.
			all = s.evictionCandidates(root, entries)
		}
		if i >= len(all) {
			return nil
		}
		st := all[i]
		trash, err := s.takeOut(st.dir)
		if err != nil {
			return err
		}
		if trash == "" {
			continue // held
		}
		owner, named := ownerOf(trash)
		var rebuild time.Duration
		if st.measured {
			rebuild = st.rebuild
		}
		s.log.Info("build.state.evicted", "state", filepath.Base(st.dir), "lastUsed", st.used, "rebuildSeconds", int64(rebuild.Seconds()), "reported", named)
		if named {
			s.recordEvicted(owner, s.clock.Now(), rebuild)
		}
		if err := os.RemoveAll(trash); err != nil {
			return err
		}
	}
}

// evictionCandidates are the states under root, cheapest to keep first (cost.go).
func (s *Store) evictionCandidates(root string, entries []os.DirEntry) []evictCandidate {
	now := s.clock.Now()
	all := make([]evictCandidate, 0, len(entries))
	for _, e := range entries {
		dir := filepath.Join(root, e.Name())
		var used time.Time
		if info, err := os.Stat(filepath.Join(dir, stateUsedMark)); err == nil {
			used = info.ModTime()
		}
		all = append(all, candidate(dir, used, now))
	}
	sort.SliceStable(all, evictionOrder(all))
	return all
}

// takeOut moves a state nobody holds out of the tree, under the lock, so
// no build acquires it half removed; its bytes go after, outside the lock.
// "" when a build holds it.
func (s *Store) takeOut(dir string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.holds[dir] != nil {
		return "", nil
	}
	s.gen[dir]++
	s.dropSpareLocked(dir)
	return s.trashLocked(dir, filepath.Base(dir))
}

// trashLocked moves dir into the trash under a name of its own; Evict
// removes the bytes. The caller holds s.mu.
func (s *Store) trashLocked(dir, name string) (string, error) {
	s.seq++
	trash := filepath.Join(s.root, "trash", name+"-"+strconv.FormatInt(s.clock.Now().UnixNano(), 36)+"-"+strconv.Itoa(s.seq))
	if err := os.MkdirAll(filepath.Dir(trash), 0o700); err != nil {
		return "", err
	}
	return trash, os.Rename(dir, trash)
}
