package dockergvisor

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

// BuildKit's state (its layer snapshots and the RUN --mount=type=cache
// directories, where a Go or JS build keeps its compile and module caches)
// persists per environment, so the next setup of the default branch and
// every pull request compile only what changed instead of the whole
// repository. It goes one way, as the images and the exported cache (S-52):
//
//   - a setup of the default branch (SeedsCache) mounts the environment's
//     state directly and writes it;
//   - every other build mounts a copy-on-write overlay of it (lower: the
//     environment's, upper: the machine's), dropped when the build ends, so
//     nothing a pull request wrote is ever read by a later build;
//   - a state another build holds the other way, or a cell that cannot
//     mount an overlay (not root, not Linux), leaves the build on its own
//     throwaway state and the exported cache, as before.
//
// A state is one environment's (cell, org, environment in its key), never
// shared across tenants: BuildKit's cache mount ids are global to a daemon.

// stateStore is what a build needs of the environments' BuildKit states.
type stateStore interface {
	// Acquire picks the state the build mounts as BuildKit's root; false:
	// the build runs on a throwaway state of its own. It does no work
	// proportional to a state's size: it runs on the build's path. A seed
	// may wait, bounded and until ctx ends, for the state's readers to go.
	Acquire(ctx context.Context, req stateRequest) (buildState, bool)
	// Release gives back what Acquire handed out.
	Release(st buildState)
	// Evict removes the least recently used states nobody holds while the
	// disk is below its floor. It may remove gigabytes, so the cell's
	// periodic sweep runs it, never a build.
	Evict() error
}

// stateRequest is one build asking for its environment's state. Seeds is
// true only for a setup of the default branch (S-52): the one build that
// may write it.
type stateRequest struct {
	Machine, Service, Org, Env string
	Seeds                      bool
}

// buildState is what one build mounts as BuildKit's root.
type buildState struct {
	dir  string // what the build mounts
	mode string // seed | overlay
	// env is the environment's state the build holds; overlay is the
	// machine's overlay directory ("" for a seed).
	env, overlay string
	machine      string
}

// noStates is the store of a cell that keeps no state (PersistBuildState
// off): every build runs on its own throwaway state.
type noStates struct{}

func (noStates) Acquire(context.Context, stateRequest) (buildState, bool) {
	return buildState{}, false
}
func (noStates) Release(buildState) {}
func (noStates) Evict() error       { return nil }

// stateMounter makes and removes the overlay a non-seeding build reads the
// environment's state through.
type stateMounter interface {
	Overlay(lower, upper, work, target string) error
	Unmount(target string) error
	// Mounted lists the overlays mounted at or under the directory.
	Mounted(under string) ([]overlayMount, error)
}

// buildStates keeps the environments' states under root: env/<key> is an
// environment's, machine/<machine>/<service> a build's overlay, and trash
// what eviction took out of env before its bytes go.
type buildStates struct {
	root   string
	cellID string
	// minFree is the disk floor Evict keeps; zero: no eviction.
	minFree   int64
	dirs      hostDirs
	mounter   stateMounter
	freeBytes func(path string) (int64, error)
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
	// stuck are the overlays whose unmount failed (state_overlays.go).
	stuck []stuckOverlay
	seq   int
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

// buildStatesConfig is what newBuildStates needs; Clock nil is the wall clock.
type buildStatesConfig struct {
	Root, CellID string
	MinFree      int64
	Dirs         hostDirs
	Mounter      stateMounter
	FreeBytes    func(path string) (int64, error)
	Clock        clock.Clock
	Log          *slog.Logger
	// SeedWait bounds a seed's wait for readers; zero: defaultSeedWait.
	SeedWait time.Duration
}

// newBuildStates also unmounts the overlays a crashed cell left (see
// recoverOverlays) before it returns, so no seed writes under one.
func newBuildStates(c buildStatesConfig) (*buildStates, error) {
	if c.SeedWait <= 0 {
		c.SeedWait = defaultSeedWait
	}
	s := &buildStates{root: c.Root, cellID: c.CellID, minFree: c.MinFree, dirs: c.Dirs, mounter: c.Mounter, freeBytes: c.FreeBytes,
		clock: clock.Or(c.Clock), log: c.Log, seedWait: c.SeedWait, holds: map[string]*stateHold{}}
	if err := s.recoverOverlays(); err != nil {
		return nil, fmt.Errorf("dockergvisor: build state overlays: %w", err)
	}
	return s, nil
}

// envDirKey names an environment's directories: cell, org and environment,
// length-prefixed so no two triples collide.
func envDirKey(cell, org, env string) string {
	h := sha256.New()
	for _, p := range []string{cell, org, env} {
		fmt.Fprintf(h, "%d:%s", len(p), p)
	}
	return hex.EncodeToString(h.Sum(nil))[:32]
}

func (s *buildStates) envDir(org, env string) string {
	return filepath.Join(s.root, "env", envDirKey(s.cellID, org, env))
}

func (s *buildStates) Acquire(ctx context.Context, req stateRequest) (buildState, bool) {
	if req.Org == "" || req.Env == "" {
		return buildState{}, false
	}
	dir := s.envDir(req.Org, req.Env)
	locked := false
	if req.Seeds {
		locked = s.lockSeed(ctx, dir)
	} else {
		locked = s.lockReader(dir)
	}
	if !locked {
		s.log.Info("build.state.busy", "machine", req.Machine, "service", req.Service, "seeds", req.Seeds)
		return buildState{}, false
	}
	if req.Seeds {
		if err := s.dirs.builderDir(dir); err != nil {
			s.unlock(dir, true)
			s.log.Warn("build.state.failed", "machine", req.Machine, "err", err)
			return buildState{}, false
		}
		s.touch(dir)
		return buildState{dir: dir, mode: "seed", env: dir, machine: req.Machine}, true
	}
	// Nothing seeded yet: an overlay of nothing is a throwaway state.
	if _, err := os.Stat(dir); err != nil {
		s.unlock(dir, false)
		return buildState{}, false
	}
	base := filepath.Join(s.root, "machine", req.Machine, req.Service)
	st := buildState{dir: filepath.Join(base, "merged"), mode: "overlay", env: dir, overlay: base, machine: req.Machine}
	upper, work := filepath.Join(base, "upper"), filepath.Join(base, "work")
	fail := func(event string, err error) (buildState, bool) {
		_ = os.RemoveAll(base)
		s.unlock(dir, false)
		if err != nil {
			s.log.Warn(event, "machine", req.Machine, "err", err)
		}
		return buildState{}, false
	}
	for _, p := range []string{upper, work, st.dir} {
		if err := s.dirs.builderDir(p); err != nil {
			return fail("build.state.failed", err)
		}
	}
	if s.mounter == nil {
		return fail("", nil)
	}
	if err := s.mounter.Overlay(dir, upper, work, st.dir); err != nil {
		return fail("build.state.overlay_failed", err)
	}
	s.touch(dir)
	return st, true
}

func (s *buildStates) Release(st buildState) {
	seeds := st.mode == "seed"
	if !seeds {
		// The upper layer goes only once nothing is mounted on it: removing
		// through a live overlay would delete what the build sees.
		// While it stays mounted, the state stays held as by a live reader:
		// a seed writing the lower directory, or eviction removing it,
		// would change it under the overlay.
		if err := s.mounter.Unmount(st.dir); err != nil {
			s.log.Warn("build.state.unmount.failed", "machine", st.machine, "err", err, "alarm", true)
			s.quarantine(stuckOverlay{target: st.dir, base: st.overlay, env: st.env})
			return
		}
		_ = os.RemoveAll(st.overlay)
	}
	s.unlock(st.env, seeds)
}

// lockReader takes the environment's state for one more reader, unless a
// seed holds it or waits for it.
func (s *buildStates) lockReader(dir string) bool {
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
func (s *buildStates) lockSeed(ctx context.Context, dir string) bool {
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

func (s *buildStates) unlock(dir string, seeds bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.holds[dir]
	if h == nil {
		return
	}
	if seeds {
		h.seed = seedNone
	} else if h.readers > 0 {
		if h.readers--; h.readers == 0 && h.drained != nil {
			close(h.drained)
			h.drained = nil
		}
	}
	s.dropIfFreeLocked(dir)
}

// holdLocked is dir's hold, made when nobody holds it. The caller holds s.mu.
func (s *buildStates) holdLocked(dir string) *stateHold {
	h := s.holds[dir]
	if h == nil {
		h = &stateHold{}
		s.holds[dir] = h
	}
	return h
}

// dropIfFreeLocked forgets dir's hold once nobody holds or waits for it.
func (s *buildStates) dropIfFreeLocked(dir string) {
	if h := s.holds[dir]; h != nil && h.readers == 0 && h.seed == seedNone {
		delete(s.holds, dir)
	}
}

const stateUsedMark = ".kodus-last-used"

// touch records the state's last use as its mark's mtime, from the store's
// clock: the mark outlives a restart, and eviction orders states by it.
func (s *buildStates) touch(dir string) {
	now := s.clock.Now()
	f := filepath.Join(dir, stateUsedMark)
	if err := os.Chtimes(f, now, now); errors.Is(err, os.ErrNotExist) {
		// A new mark gets the wall's mtime; stamp it with the clock's too.
		if os.WriteFile(f, nil, 0o644) == nil {
			_ = os.Chtimes(f, now, now)
		}
	}
}

// Evict removes the least recently used environment states nobody holds
// while the cell's disk has less free space than the floor, then whatever
// an earlier sweep took out of the tree and did not finish removing.
// It retries the unmounts that failed first: their states stay held until then.
func (s *buildStates) Evict() error {
	errs := []error{s.retryStuck(), s.evictLRU()}
	trash := filepath.Join(s.root, "trash")
	entries, _ := os.ReadDir(trash)
	for _, e := range entries {
		errs = append(errs, os.RemoveAll(filepath.Join(trash, e.Name())))
	}
	return errors.Join(errs...)
}

func (s *buildStates) evictLRU() error {
	if s.minFree <= 0 || s.freeBytes == nil {
		return nil
	}
	root := filepath.Join(s.root, "env")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	type state struct {
		dir  string
		used time.Time
	}
	var all []state
	for _, e := range entries {
		dir := filepath.Join(root, e.Name())
		var used time.Time
		if info, err := os.Stat(filepath.Join(dir, stateUsedMark)); err == nil {
			used = info.ModTime()
		}
		all = append(all, state{dir, used})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].used.Before(all[j].used) })
	for _, st := range all {
		free, err := s.freeBytes(root)
		if err != nil || free >= s.minFree {
			return err
		}
		trash, err := s.takeOut(st.dir)
		if err != nil {
			return err
		}
		if trash == "" {
			continue // held
		}
		s.log.Info("build.state.evicted", "state", filepath.Base(st.dir), "lastUsed", st.used)
		if err := os.RemoveAll(trash); err != nil {
			return err
		}
	}
	return nil
}

// takeOut moves a state nobody holds out of the tree, under the lock, so
// no build acquires it half removed; its bytes go after, outside the lock.
// "" when a build holds it.
func (s *buildStates) takeOut(dir string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.holds[dir] != nil {
		return "", nil
	}
	return s.trashLocked(dir, filepath.Base(dir))
}

// trashLocked moves dir into the trash under a name of its own; Evict
// removes the bytes. The caller holds s.mu.
func (s *buildStates) trashLocked(dir, name string) (string, error) {
	s.seq++
	trash := filepath.Join(s.root, "trash", name+"-"+strconv.FormatInt(s.clock.Now().UnixNano(), 36)+"-"+strconv.Itoa(s.seq))
	if err := os.MkdirAll(filepath.Dir(trash), 0o700); err != nil {
		return "", err
	}
	return trash, os.Rename(dir, trash)
}
