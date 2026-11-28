package buildstate

import (
	"encoding/json"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"time"
)

// What a state costs to make again, so eviction takes the cheap ones first.
// Pure least-recently-used eviction took the states of the heaviest
// repositories as readily as the lightest: overnight on the dev cell it took
// six of seven, and the next pull requests built cold (directus 1,000 s,
// payload 894 s, immich 363 s against 118 s warm, calcom past its 30 min
// ceiling against 217 s warm; measured on the dev cell, 2026-11-13).
//
// The cost is how long the last build that made the state from none took (a
// seed that found no state), from when it took the state to when it gave it
// back. It is written as a cell file in the state's root beside the
// last-used and owner marks, so it outlives a restart and goes with the
// state; a warm seed leaves it as it is.

// stateRebuildMark holds the state's rebuild cost, inside it.
const stateRebuildMark = ".kodus-rebuild"

type rebuildMark struct {
	Seconds int64 `json:"seconds"`
}

// unknownRebuild is the cost of a state with no mark (made before the mark
// existed): between the warm and the cold builds measured on the dev cell,
// so such a state is neither kept over a known heavy one nor taken before a
// known light one.
const unknownRebuild = 5 * time.Minute

// keepHalfLife is how fast an unused state's cost stops counting: its weight
// halves for each day nobody used it. Two states of the same cost go least
// recently used first, as before; a heavy state used today stays over a
// light one, and one nobody used for days goes before a light one in use.
const keepHalfLife = 24 * time.Hour

// recordRebuild writes the rebuild cost of a state a seed made from none. At
// least a second: a build's cost is never nothing.
func (s *Store) recordRebuild(dir string, took time.Duration) {
	secs := int64(math.Ceil(took.Seconds()))
	if secs < 1 {
		secs = 1
	}
	b, err := json.Marshal(rebuildMark{Seconds: secs})
	if err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, stateRebuildMark), b, 0o600)
}

// rebuildOf reads a state's rebuild cost (or that of what eviction moved to
// the trash). A mark that is not a regular file or not the cell's shape says
// nothing: the state's root is shared with the builder.
func rebuildOf(dir string) (time.Duration, bool) {
	f := filepath.Join(dir, stateRebuildMark)
	info, err := os.Lstat(f)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 256 {
		return 0, false
	}
	b, err := os.ReadFile(f) //nolint:gosec // G304: the rebuild mark of a state directory of the cell's own
	if err != nil {
		return 0, false
	}
	var m rebuildMark
	// A week bounds what a mark may say: no build runs that long.
	if json.Unmarshal(b, &m) != nil || m.Seconds <= 0 || m.Seconds > 7*24*3600 {
		return 0, false
	}
	return time.Duration(m.Seconds) * time.Second, true
}

// evictCandidate is one state eviction may take.
type evictCandidate struct {
	dir     string
	used    time.Time
	rebuild time.Duration
	// measured: rebuild is the state's own mark, not unknownRebuild.
	measured bool
	// keep is what keeping it is worth: its rebuild cost, halved for each
	// keepHalfLife since its last use. The lowest goes first.
	keep float64
}

func candidate(dir string, used, now time.Time) evictCandidate {
	cost, measured := rebuildOf(dir)
	if !measured {
		cost = unknownRebuild
	}
	// Bounded so a mark far in the past or the future stays a finite weight.
	halves := math.Max(-60, math.Min(60, now.Sub(used).Hours()/keepHalfLife.Hours()))
	if used.IsZero() {
		halves = 60 // never marked used: the oldest of all
	}
	return evictCandidate{dir: dir, used: used, rebuild: cost, measured: measured, keep: cost.Seconds() * math.Exp2(-halves)}
}

// evictionOrder sorts the candidates cheapest to keep first. Equal worth:
// the larger first (it frees more for the same loss), then the least
// recently used. Sizes are walked only for such ties, and once each.
func evictionOrder(all []evictCandidate) func(i, j int) bool {
	sizes := map[string]int64{}
	size := func(dir string) int64 {
		if n, ok := sizes[dir]; ok {
			return n
		}
		n := treeBytes(dir)
		sizes[dir] = n
		return n
	}
	return func(i, j int) bool {
		a, b := all[i], all[j]
		if a.keep != b.keep {
			return a.keep < b.keep
		}
		if sa, sb := size(a.dir), size(b.dir); sa != sb {
			return sa > sb
		}
		if !a.used.Equal(b.used) {
			return a.used.Before(b.used)
		}
		return a.dir < b.dir
	}
}

// treeBytes is what the regular files under dir hold. It follows no link;
// what it cannot read counts as nothing.
func treeBytes(dir string) int64 {
	var n int64
	_ = filepath.WalkDir(dir, func(_ string, e fs.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // an entry that cannot be read counts as nothing; the walk goes on
		}
		if e.Type().IsRegular() {
			if info, err := e.Info(); err == nil {
				n += info.Size()
			}
		}
		return nil
	})
	return n
}
