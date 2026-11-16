package buildstate

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// What eviction took, kept until a seed makes the state again, so the cell
// can tell the hub (heartbeat evictedBuildStates) and a build that finds its
// environment's state gone can say why it builds cold. An environment whose
// state the disk floor removed has to be set up again: until then each of its
// pull requests builds with no cache, which a large repository may not finish
// within its boot's ceiling (calcom, docs/runtime/measurements-2026-11-13.md
// "H1 recount"). The hub learned nothing of it, and the environment stayed
// "active".
//
// A state's directory name is EnvKey, a hash: eviction learns whose state it
// removes from the owner mark each build writes beside the last-used mark.
// A state made before the mark existed gets it on its next use; one evicted
// without it is logged as before and not reported.

// Evicted is one environment whose state this cell's eviction removed.
type Evicted struct {
	Org, Env string
	At       time.Time
	// Rebuild is how long the last build that made the state from none took
	// (cost.go), the cost of the next one that finds it gone with no cache;
	// zero: not measured (a state made before the mark existed).
	Rebuild time.Duration
}

// stateOwnerMark names the org and environment of a state, inside it.
const stateOwnerMark = ".kodus-env"

// maxEvicted bounds the ledger: the newest are kept.
const maxEvicted = 64

type ownerMark struct {
	Org string `json:"org"`
	Env string `json:"env"`
}

type evictedEntry struct {
	Org            string    `json:"org"`
	Env            string    `json:"env"`
	At             time.Time `json:"at"`
	RebuildSeconds int64     `json:"rebuildSeconds,omitempty"`
}

func (e evictedEntry) evicted() Evicted {
	return Evicted{Org: e.Org, Env: e.Env, At: e.At, Rebuild: time.Duration(e.RebuildSeconds) * time.Second}
}

func (s *Store) evictedDir() string { return filepath.Join(s.root, "evicted") }

// own writes the state's owner mark when it has none. It is a cell file in
// the state's root, as the last-used mark is: BuildKit never reads it.
func (s *Store) own(dir, org, env string) {
	f := filepath.Join(dir, stateOwnerMark)
	if _, err := os.Lstat(f); err == nil {
		return
	}
	b, err := json.Marshal(ownerMark{Org: org, Env: env})
	if err != nil {
		return
	}
	_ = os.WriteFile(f, b, 0o600)
}

// ownerOf reads the owner mark of a state (or of what eviction moved to the
// trash). A mark that is not a regular file, or not the cell's shape, names
// nobody: the state's root is shared with the builder.
func ownerOf(dir string) (ownerMark, bool) {
	f := filepath.Join(dir, stateOwnerMark)
	info, err := os.Lstat(f)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return ownerMark{}, false
	}
	b, err := os.ReadFile(f) //nolint:gosec // G304: the owner mark of a state directory of the cell's own
	if err != nil {
		return ownerMark{}, false
	}
	var m ownerMark
	if json.Unmarshal(b, &m) != nil || m.Org == "" || m.Env == "" || len(m.Org) > 128 || len(m.Env) > 128 {
		return ownerMark{}, false
	}
	return m, true
}

// loadEvicted reads the ledger a previous run of the cell left. An entry
// whose state exists again (a seed made it after) or that does not parse
// is dropped.
func (s *Store) loadEvicted() {
	entries, _ := os.ReadDir(s.evictedDir())
	for _, e := range entries {
		p := filepath.Join(s.evictedDir(), e.Name())
		b, err := os.ReadFile(p) //nolint:gosec // G304: an entry of the cell's own eviction ledger
		var en evictedEntry
		if err != nil || json.Unmarshal(b, &en) != nil || en.Org == "" || en.Env == "" || e.Name() != EnvKey(s.cellID, en.Org, en.Env) {
			_ = os.Remove(p)
			continue
		}
		if _, err := os.Stat(s.EnvDir(en.Org, en.Env)); err == nil {
			_ = os.Remove(p)
			continue
		}
		s.evicted[e.Name()] = en.evicted()
	}
}

// recordEvicted adds an environment to the ledger, on disk and in memory,
// with what the state cost to make (zero: not measured), and keeps the newest
// maxEvicted. The caller holds no lock.
func (s *Store) recordEvicted(owner ownerMark, at time.Time, rebuild time.Duration) {
	key := EnvKey(s.cellID, owner.Org, owner.Env)
	en := evictedEntry{Org: owner.Org, Env: owner.Env, At: at.UTC(), RebuildSeconds: int64(rebuild / time.Second)}
	if b, err := json.Marshal(en); err == nil {
		if err := os.MkdirAll(s.evictedDir(), 0o700); err == nil {
			_ = os.WriteFile(filepath.Join(s.evictedDir(), key), b, 0o600)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.evicted[key] = en.evicted()
	for len(s.evicted) > maxEvicted {
		oldest := ""
		for k, v := range s.evicted {
			if oldest == "" || v.At.Before(s.evicted[oldest].At) {
				oldest = k
			}
		}
		delete(s.evicted, oldest)
		_ = os.Remove(filepath.Join(s.evictedDir(), oldest))
	}
}

// forgetEvicted drops an environment from the ledger: a seed is making its
// state again.
func (s *Store) forgetEvicted(dir string) {
	key := filepath.Base(dir)
	s.mu.Lock()
	_, had := s.evicted[key]
	delete(s.evicted, key)
	s.mu.Unlock()
	if had {
		if err := os.Remove(filepath.Join(s.evictedDir(), key)); err != nil && !errors.Is(err, os.ErrNotExist) {
			s.log.Warn("build.state.evicted.forget_failed", "err", err)
		}
	}
}

// Evicted lists the environments whose state eviction removed and no seed
// made again, newest first.
func (s *Store) Evicted() []Evicted {
	s.mu.Lock()
	out := make([]Evicted, 0, len(s.evicted))
	for _, v := range s.evicted {
		out = append(out, v)
	}
	s.mu.Unlock()
	sort.Slice(out, func(i, j int) bool {
		if !out[i].At.Equal(out[j].At) {
			return out[i].At.After(out[j].At)
		}
		return out[i].Env < out[j].Env
	})
	return out
}

// EvictedAt says when eviction removed the environment's state, when it did
// and no seed made it again.
func (s *Store) EvictedAt(org, env string) (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.evicted[EnvKey(s.cellID, org, env)]
	return e.At, ok
}
