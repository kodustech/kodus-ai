package toollayer

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	layerIdleBeforeGC = 24 * time.Hour
	keyIdleBeforeGC   = 30 * 24 * time.Hour
)

// GCReport counts what one pass removed.
type GCReport struct {
	KeysRemoved   int
	LayersRemoved int
	FilesRemoved  int
	MissesRemoved int
}

// GC removes keys unused for 30 days, then layers that no key points to, no
// sandbox holds and that were last mounted 24 h ago, then the org-store files
// only files/ still links to (link count 1). A layer a key points to or that
// is held is never removed here; limits evict by LRU at ingest.
func (s *Store) GC(ctx context.Context) (GCReport, error) {
	var rep GCReport
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.cfg.Now()
	for _, od := range s.orgDirs() {
		if err := ctx.Err(); err != nil {
			return rep, err
		}
		s.gcOrg(od, now, &rep)
	}
	return rep, nil
}

func (s *Store) gcOrg(od string, now time.Time, rep *GCReport) {
	// Keys: stale or pointing at nothing.
	referenced := map[string]bool{}
	if des, err := os.ReadDir(filepath.Join(od, "keys")); err == nil {
		for _, d := range des {
			p := filepath.Join(od, "keys", d.Name())
			info, err := d.Info()
			if err != nil || !hexRe.MatchString(d.Name()) {
				continue
			}
			b, _ := os.ReadFile(p)
			digest := strings.TrimSpace(string(b))
			_, lerr := os.Lstat(filepath.Join(od, "layers", digest, "layer.json"))
			if now.Sub(info.ModTime()) >= keyIdleBeforeGC || !hexRe.MatchString(digest) || lerr != nil {
				if os.Remove(p) == nil {
					rep.KeysRemoved++
				}
				continue
			}
			referenced[digest] = true
		}
	}

	// Layers: unreferenced, unheld, idle; and half-built ones a crash left.
	if des, err := os.ReadDir(filepath.Join(od, "layers")); err == nil {
		for _, d := range des {
			if !hexRe.MatchString(d.Name()) || referenced[d.Name()] || s.holds[s.holdKey(od, d.Name())] > 0 {
				continue
			}
			lp := filepath.Join(od, "layers", d.Name())
			if _, err := os.Lstat(filepath.Join(lp, "layer.json")); err != nil {
				if removeTree(lp) == nil {
					rep.LayersRemoved++
				}
				continue
			}
			used := time.Time{}
			if fi, err := os.Stat(filepath.Join(lp, "used")); err == nil {
				used = fi.ModTime()
			} else if l, err := readLayer(lp); err == nil {
				used = l.BuiltAt
			}
			if now.Sub(used) >= layerIdleBeforeGC {
				s.evictLocked(od, d.Name(), nil)
				rep.LayersRemoved++
			}
		}
	}

	// Files nothing but the store links to.
	if des, err := os.ReadDir(filepath.Join(od, "files")); err == nil {
		for _, d := range des {
			info, err := d.Info()
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			if sys, ok := sysOf(info); ok && sys.nlink == 1 {
				if os.Remove(filepath.Join(od, "files", d.Name())) == nil {
					rep.FilesRemoved++
				}
			}
		}
	}

	// Miss records whose every timestamp left the window.
	if des, err := os.ReadDir(filepath.Join(od, "misses")); err == nil {
		for _, d := range des {
			p := filepath.Join(od, "misses", d.Name())
			if b, err := os.ReadFile(p); err == nil {
				var f missFile
				if json.Unmarshal(b, &f) == nil && len(s.recentMisses(p, now)) == 0 {
					if os.Remove(p) == nil {
						rep.MissesRemoved++
					}
				}
			}
		}
	}
}
