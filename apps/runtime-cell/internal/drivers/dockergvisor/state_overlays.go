package dockergvisor

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// An overlay that is still mounted keeps its environment's state held, as
// a live reader does, whatever ended the build that mounted it: its unmount
// failed, or the cell crashed with it mounted. Until it is gone, no seed
// writes the lower directory and no eviction removes it.

// stuckOverlay is an overlay whose unmount failed: target is where it is
// mounted, base the machine's overlay directory removed once it is not,
// env the state it holds ("" when it holds none).
type stuckOverlay struct {
	target, base, env string
}

// quarantine keeps o's reader hold until retryStuck unmounts it.
func (s *buildStates) quarantine(o stuckOverlay) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stuck = append(s.stuck, o)
}

// retryStuck unmounts the overlays whose unmount failed and gives their
// states back. It runs on the reclaim loop (Evict), never on a build's path.
func (s *buildStates) retryStuck() error {
	s.mu.Lock()
	stuck := s.stuck
	s.stuck = nil
	s.mu.Unlock()
	var errs []error
	for _, o := range stuck {
		if err := s.mounter.Unmount(o.target); err != nil {
			s.quarantine(o)
			errs = append(errs, err)
			continue
		}
		if o.base != "" {
			errs = append(errs, os.RemoveAll(o.base))
		}
		if o.env != "" {
			s.unlock(o.env, false)
		}
	}
	return errors.Join(errs...)
}

// recoverOverlays unmounts what a crashed cell left mounted under the
// overlays' directory, and takes out of the tree what it left unmounted.
// An overlay that does not unmount is quarantined, its state held, and the
// reclaim loop retries it.
func (s *buildStates) recoverOverlays() error {
	if s.mounter == nil {
		return nil
	}
	machines := filepath.Join(s.root, "machine")
	mounts, err := s.mounter.Mounted(machines)
	if err != nil {
		return err
	}
	envRoot := filepath.Join(s.root, "env")
	for _, m := range mounts {
		o := stuckOverlay{target: m.Target}
		// Only what the cell lays out is removed or held: base is
		// machine/<m>/<svc> of a .../merged target, env a state's directory.
		if filepath.Base(m.Target) == "merged" && filepath.Dir(filepath.Dir(filepath.Dir(m.Target))) == machines {
			o.base = filepath.Dir(m.Target)
		}
		if filepath.Dir(m.Lower) == envRoot {
			o.env = m.Lower
		}
		err := s.mounter.Unmount(m.Target)
		if err == nil {
			continue
		}
		s.log.Warn("build.state.unmount.failed", "target", m.Target, "err", err, "alarm", true)
		s.mu.Lock()
		if o.env != "" {
			s.holdLocked(o.env).readers++
		}
		s.stuck = append(s.stuck, o)
		s.mu.Unlock()
	}
	return s.trashLeftoverMachines(machines)
}

// trashLeftoverMachines takes the machines' overlay directories out of the
// tree, but those a quarantined overlay is still mounted in.
func (s *buildStates) trashLeftoverMachines(machines string) error {
	entries, err := os.ReadDir(machines)
	if err != nil {
		return nil // none
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var errs []error
	for _, e := range entries {
		dir := filepath.Join(machines, e.Name())
		if s.mountedUnderLocked(dir) {
			continue
		}
		_, err := s.trashLocked(dir, "machine-"+e.Name())
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func (s *buildStates) mountedUnderLocked(dir string) bool {
	for _, o := range s.stuck {
		if strings.HasPrefix(o.target, dir+string(filepath.Separator)) {
			return true
		}
	}
	return false
}
