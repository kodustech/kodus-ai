package toollayer

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// A layer is built on the second miss of the same key within 7 days (U9):
// the first miss already pays one install inside the review, and a CLI used
// once should not pay for a second one in the background.
const (
	missWindow    = 7 * 24 * time.Hour
	missesKept    = 8
	missesToBuild = 2
)

type missFile struct {
	At []int64 `json:"at"` // unix seconds
}

func (s *Store) missPath(org, key string) (string, error) {
	if org == "" {
		return "", errors.New("toollayer: no org")
	}
	if !hexRe.MatchString(key) {
		return "", errors.New("toollayer: key is not a sha256 hex")
	}
	return filepath.Join(s.OrgDir(org), "misses", key), nil
}

func (s *Store) recentMisses(p string, now time.Time) []int64 {
	raw, err := os.ReadFile(p) //nolint:gosec // G304: p comes from missPath: the org id is hashed and the key must be a sha256 hex
	if err != nil {
		return nil
	}
	var f missFile
	if json.Unmarshal(raw, &f) != nil {
		return nil
	}
	var keep []int64
	for _, at := range f.At {
		if now.Sub(time.Unix(at, 0)) < missWindow {
			keep = append(keep, at)
		}
	}
	return keep
}

// RecordMiss notes that a review found no layer for the key. It is kept on
// disk, so a cell restart does not forget it.
func (s *Store) RecordMiss(org, key string) error {
	p, err := s.missPath(org, key)
	if err != nil {
		return err
	}
	if _, err := s.ensureOrg(org); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.cfg.Now()
	at := append(s.recentMisses(p, now), now.Unix())
	if len(at) > missesKept {
		at = at[len(at)-missesKept:]
	}
	raw, err := json.Marshal(missFile{At: at})
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Dir(p), filepath.Base(p), raw, 0o600)
}

// ShouldBuild is true once the key has missed twice within 7 days.
func (s *Store) ShouldBuild(org, key string) bool {
	p, err := s.missPath(org, key)
	if err != nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.recentMisses(p, s.cfg.Now())) >= missesToBuild
}
