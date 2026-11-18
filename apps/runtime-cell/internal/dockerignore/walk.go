package dockerignore

import "strings"

// Walk judges the entries of a context in the order a depth-first walk
// visits them (a directory before what it holds), the way BuildKit's file
// sync does: fsutil carries each directory's per-pattern results down to
// what it holds (patternmatcher.MatchesUsingParentResults), which can
// decide otherwise than judging a path on its own (Matcher.Matches).
//
// An entry is left out only when both readings leave it out. The two are
// the algorithms builders have shipped; where they disagree, keeping the
// entry in costs a spurious rebuild and leaving it out could reuse an
// image the build would not have made.
type Walk struct {
	m       *Matcher
	parents []visitedDir // the directories above the entry, outermost first
}

type visitedDir struct {
	prefix  string // the directory's path and a trailing "/"
	matched []bool // which patterns named it or a directory above it
}

// Walk starts a walk of a context.
func (m *Matcher) Walk() *Walk { return &Walk{m: m} }

// Visit judges one entry, given its slash-separated path relative to the
// context (never "."). skip is true for a left-out directory that nothing
// below can be put back into: the walk may skip it whole, as fsutil does.
func (w *Walk) Visit(rel string, isDir bool) (excluded, skip bool) {
	for len(w.parents) > 0 && !strings.HasPrefix(rel, w.parents[len(w.parents)-1].prefix) {
		w.parents = w.parents[:len(w.parents)-1]
	}
	var parent []bool
	if len(w.parents) > 0 {
		parent = w.parents[len(w.parents)-1].matched
	}
	walked, matched := w.m.matchUsingParent(rel, parent)
	excluded = walked && w.m.Matches(rel)
	if isDir {
		if excluded && w.m.prunable(rel) {
			return true, true
		}
		w.parents = append(w.parents, visitedDir{prefix: rel + "/", matched: matched})
	}
	return excluded, false
}

// matchUsingParent is fsutil's reading: a pattern that named the directory
// above names the entry too, and a pattern is checked against the parents
// only at the top of the context, where no directory above has results.
func (m *Matcher) matchUsingParent(rel string, parent []bool) (bool, []bool) {
	matched := false
	results := make([]bool, len(m.patterns))
	for i, p := range m.patterns {
		hit := len(parent) != 0 && parent[i]
		if !hit {
			if p.exception != matched {
				continue
			}
			if len(parent) == 0 {
				hit = p.matchSelfOrParent(rel)
			} else {
				hit = p.match(rel)
			}
		}
		results[i] = hit
		if hit {
			matched = !p.exception
		}
	}
	return matched, results
}

// prunable reports whether nothing below a left-out directory can be put
// back, under fsutil's own test: no "!" pattern at all, or only literal
// ones and none of them below this directory. It is also sound for
// Matches: below such a directory, the only extra patterns that can name
// an entry are ones that leave it out, so the last one to name it still
// leaves it out.
func (m *Matcher) prunable(dir string) bool {
	if !m.exceptions {
		return true
	}
	if !m.literalExceptions {
		return false
	}
	for _, p := range m.patterns {
		if p.exception && strings.HasPrefix(p.withoutTrailingGlob()+"/", dir+"/") {
			return false
		}
	}
	return true
}
