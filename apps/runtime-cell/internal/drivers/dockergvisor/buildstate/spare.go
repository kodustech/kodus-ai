package buildstate

import (
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// A spare view is a build's view of an environment's state made ahead of the
// build that takes it. Cloning a large state is a walk of every entry (49.6 s
// for kr-twenty's, Run 95c0f2f1), and it ran on the pull request's path, after
// the claim was already waiting on its build. A spare is made off that path,
// after the build that last used the state (a seed or a view), and the next
// build takes it with one rename.
//
// It is the same view a build would make for itself, made earlier, and it
// never makes a seed wait:
//   - it is cloned only while no seed holds the state or waits for it, and it
//     takes no hold itself, so a seed that comes meanwhile starts at once;
//   - every seed and every eviction moves the state's generation on, and a
//     spare is kept and taken only at the generation it started at: one that
//     a seed or an eviction overlapped, even in part, is dropped, never read
//     (a seed holding the state also keeps every build off it until its
//     release moves the generation);
//   - a clone shares no file with the state, so once made it needs no hold;
//   - a spare a stopped cell left is never taken: New drops them all.
//
// Only with a mounter whose view is a plain directory (Config.SpareViews): a
// kernel overlay is a mount, made at once, and cannot be moved.

// spareView is one made view: its directory (upper, work, merged, as a
// build's) and the generation of the state it was cloned at.
type spareView struct {
	dir string
	gen uint64
}

func (s *Store) sparesRoot() string { return filepath.Join(s.root, "spare") }

// takeSpare moves the state's spare to base, the build's view directory, when
// one was made at the state's current generation. false: none, stale, or the
// move failed (the build then makes its own view).
func (s *Store) takeSpare(env, base string) bool {
	if !s.spareViews {
		return false
	}
	s.mu.Lock()
	sp, ok := s.spares[env]
	fresh := ok && sp.gen == s.gen[env]
	if ok {
		delete(s.spares, env)
	}
	if ok && !fresh {
		s.trashSpareLocked(sp.dir)
	}
	s.mu.Unlock()
	if !fresh {
		return false
	}
	if err := os.MkdirAll(filepath.Dir(base), 0o700); err == nil {
		if err = os.Rename(sp.dir, base); err == nil {
			return true
		}
		s.log.Warn("build.state.spare.take_failed", "err", err)
	}
	s.mu.Lock()
	s.trashSpareLocked(sp.dir)
	s.mu.Unlock()
	return false
}

// makeSpare makes the state's next spare in the background, unless one is
// made or being made, or the store makes none.
func (s *Store) makeSpare(env string) {
	if !s.spareViews || s.mounter == nil || env == "" {
		return
	}
	s.mu.Lock()
	if sp, ok := s.spares[env]; s.making[env] || (ok && sp.gen == s.gen[env]) {
		s.mu.Unlock()
		return
	}
	s.making[env] = true
	s.seq++
	dir := filepath.Join(s.sparesRoot(), filepath.Base(env)+"-"+strconv.Itoa(s.seq))
	s.mu.Unlock()
	s.spareWork.Add(1)
	go func() {
		defer s.spareWork.Done()
		s.cloneSpare(env, dir)
	}()
}

// cloneSpare clones the state into dir and keeps it as the state's spare,
// unless a seed or an eviction moved the state's generation meanwhile.
func (s *Store) cloneSpare(env, dir string) {
	defer func() {
		s.mu.Lock()
		delete(s.making, env)
		s.mu.Unlock()
	}()
	if _, err := os.Stat(env); err != nil {
		return // nothing seeded, or evicted
	}
	// A seed holds the state or waits for it: no spare now; its release makes one.
	s.mu.Lock()
	seeding := s.holds[env] != nil && s.holds[env].seed != seedNone
	gen := s.gen[env]
	s.mu.Unlock()
	if seeding {
		return
	}
	began := time.Now()
	err := s.cloneInto(env, dir)
	if err != nil {
		s.log.Warn("build.state.spare.failed", "err", err)
		_ = os.RemoveAll(dir)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// A seed that started meanwhile and still holds the state is caught at its
	// release, which moves the generation before any build can read again.
	if _, taken := s.spares[env]; taken || s.gen[env] != gen {
		s.trashSpareLocked(dir)
		return
	}
	s.spares[env] = spareView{dir: dir, gen: gen}
	s.log.Info("build.state.spare.ready", "ms", time.Since(began).Milliseconds())
}

// cloneInto lays dir out as a build's view directory and clones env into its merged.
func (s *Store) cloneInto(env, dir string) error {
	upper, work, merged := filepath.Join(dir, "upper"), filepath.Join(dir, "work"), filepath.Join(dir, "merged")
	for _, p := range []string{upper, work, merged} {
		if err := s.builderDir(p); err != nil {
			return err
		}
	}
	return s.mounter.Overlay(env, upper, work, merged)
}

// dropSpareLocked makes the state's spare stale: out of the map, into the
// trash. The caller holds s.mu.
func (s *Store) dropSpareLocked(env string) {
	if sp, ok := s.spares[env]; ok {
		delete(s.spares, env)
		s.trashSpareLocked(sp.dir)
	}
}

// trashSpareLocked moves a spare's directory into the trash, for Evict to
// delete; one that cannot move is deleted here. The caller holds s.mu.
func (s *Store) trashSpareLocked(dir string) {
	if _, err := s.trashLocked(dir, "spare"); err != nil {
		_ = os.RemoveAll(dir)
	}
}

// dropLeftoverSpares takes what a stopped cell left under the spares'
// directory out of the tree: it was made at a generation this store never saw.
func (s *Store) dropLeftoverSpares() error {
	if _, err := os.Stat(s.sparesRoot()); err != nil {
		return nil // no spares' directory: nothing to drop
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.trashLocked(s.sparesRoot(), "spare-leftover")
	return err
}

// dropSpares makes every spare stale, for eviction under disk pressure: a
// spare costs the state's metadata again, and is only a head start.
func (s *Store) dropSpares() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for env := range s.spares {
		s.dropSpareLocked(env)
	}
}

func (s *Store) hasSpares() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.spares) > 0
}

// WaitSpares returns once no spare is being made, for a caller that must see
// the disk settled (a test, a cell that stops).
func (s *Store) WaitSpares() { s.spareWork.Wait() }
