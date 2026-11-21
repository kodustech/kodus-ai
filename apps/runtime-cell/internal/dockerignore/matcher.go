package dockerignore

import (
	"bufio"
	"bytes"
	"path"
	"strings"
)

// Parse reads an ignore file into its pattern lines as BuildKit's frontend
// does: a UTF-8 BOM is dropped, a line starting with "#" in its first
// column is a comment, whitespace is trimmed, blank lines are skipped, and
// each pattern (after any "!") is cleaned and loses a leading "/". A line
// longer than bufio.Scanner's limit is an error there and here.
func Parse(data []byte) ([]string, error) {
	var lines []string
	sc := bufio.NewScanner(bytes.NewReader(data))
	for first := true; sc.Scan(); first = false {
		raw := sc.Bytes()
		if first {
			raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
		}
		line := string(raw)
		if strings.HasPrefix(line, "#") { // before trimming: " #x" is a pattern
			continue
		}
		if line = strings.TrimSpace(line); line == "" {
			continue
		}
		lines = append(lines, cleanLine(line))
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}

// cleanLine normalizes one non-blank line, keeping its "!".
func cleanLine(line string) string {
	exception := line[0] == '!'
	if exception {
		line = strings.TrimSpace(line[1:])
	}
	if line != "" {
		line = path.Clean(line)
		if len(line) > 1 && line[0] == '/' {
			line = line[1:]
		}
	}
	if exception {
		return "!" + line
	}
	return line
}

// Matcher holds an ignore file's patterns, in order: the last one that
// names a path decides whether it is left out.
type Matcher struct {
	patterns   []*pattern
	exceptions bool
	// literalExceptions: every "!" pattern is a plain path (once a trailing
	// "/*" or "/**" is dropped), which is when fsutil prunes a left-out
	// directory that no exception reaches into.
	literalExceptions bool
}

// Compile parses and compiles an ignore file. Any error is one BuildKit
// fails the build on.
func Compile(data []byte) (*Matcher, error) {
	lines, err := Parse(data)
	if err != nil {
		return nil, err
	}
	return New(lines)
}

// New compiles pattern lines as patternmatcher.New does.
func New(lines []string) (*Matcher, error) {
	m := &Matcher{literalExceptions: true}
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		p, err := newPattern(line)
		if err != nil {
			return nil, err
		}
		if p.exception {
			m.exceptions = true
			if strings.ContainsAny(p.withoutTrailingGlob(), `*[]?^\`) {
				m.literalExceptions = false
			}
		}
		m.patterns = append(m.patterns, p)
	}
	return m, nil
}

// Matches reports whether a slash-separated path, relative to the context,
// is left out when judged on its own: the last pattern that names it or a
// directory above it decides (patternmatcher.MatchesOrParentMatches).
func (m *Matcher) Matches(rel string) bool {
	matched := false
	for _, p := range m.patterns {
		// A pattern that cannot change the verdict is not evaluated.
		if p.exception != matched {
			continue
		}
		if p.matchSelfOrParent(rel) {
			matched = !p.exception
		}
	}
	return matched
}
