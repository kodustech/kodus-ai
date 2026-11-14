// Package dockerignore decides which entries of a build context a
// .dockerignore leaves out, the way BuildKit does when it sends the
// context: the frontend parses the file (moby/patternmatcher/ignorefile)
// and the file sync walks the context through moby/patternmatcher
// (tonistiigi/fsutil). It is a self-contained reimplementation of those
// rules, slash-separated, for a Linux builder.
//
// A caller uses it to know what can never reach a build, so every place
// where the two could disagree is resolved toward leaving an entry in.
package dockerignore

import (
	"errors"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"
)

type matchKind int

const (
	exactMatch  matchKind = iota // the path is the pattern
	prefixMatch                  // "dir/**" and "name**": the path starts with what precedes "**"
	suffixMatch                  // "**/name" and "**name": the path ends with what follows "**"
	regexpMatch                  // anything with a wildcard elsewhere
)

// pattern is one cleaned line of the ignore file.
type pattern struct {
	exception bool // a "!" line: it puts back what earlier lines left out
	cleaned   string
	kind      matchKind
	re        *regexp.Regexp
}

// newPattern cleans and compiles one line as patternmatcher.New does. A
// line BuildKit refuses is an error: the build fails there, so no caller
// may treat it as excluding anything.
func newPattern(line string) (*pattern, error) {
	p := path.Clean(strings.TrimSpace(line))
	pt := &pattern{}
	if p[0] == '!' {
		if len(p) == 1 {
			return nil, errors.New(`dockerignore: illegal exclusion pattern "!"`)
		}
		pt.exception, p = true, p[1:]
	}
	// patternmatcher keeps filepath.Match's verdict on the syntax.
	if _, err := path.Match(p, "."); err != nil {
		return nil, err
	}
	pt.cleaned = p
	if err := pt.compile(); err != nil {
		return nil, err
	}
	return pt, nil
}

// compile mirrors patternmatcher's translation rune for rune, quirks
// included ("**name" is a plain suffix test, "\x" stays a regexp escape),
// because a closer-to-the-docs reading would decide differently than the
// builder for exactly those patterns.
func (p *pattern) compile() error {
	re := "^"
	kind := exactMatch
	rs := []rune(p.cleaned)
	for i, n := 0, 0; n < len(rs); i++ {
		ch := rs[n]
		n++
		switch {
		case ch == '*' && n < len(rs) && rs[n] == '*':
			n++
			if n < len(rs) && rs[n] == '/' { // "**/" is "**"
				n++
			}
			if n == len(rs) {
				if kind == exactMatch {
					kind = prefixMatch
				} else {
					re += ".*"
					kind = regexpMatch
				}
			} else {
				re += "(.*/)?" // any number of directories, even none
				kind = regexpMatch
			}
			if i == 0 {
				kind = suffixMatch
			}
		case ch == '*':
			re += "[^/]*"
			kind = regexpMatch
		case ch == '?':
			re += "[^/]"
			kind = regexpMatch
		case ch < utf8.RuneSelf && strings.ContainsRune(`.+()|{}$`, ch):
			re += `\` + string(ch)
		case ch == '\\':
			if n < len(rs) {
				re += `\` + string(rs[n])
				n++
				kind = regexpMatch
			} else {
				re += `\` // as patternmatcher does; path.Match refuses this line first
			}
		case ch == '[' || ch == ']':
			re += string(ch)
			kind = regexpMatch
		default:
			re += string(ch)
		}
	}
	p.kind = kind
	if kind != regexpMatch {
		return nil
	}
	compiled, err := regexp.Compile(re + "$")
	if err != nil {
		return err
	}
	p.re = compiled
	return nil
}

// match reports whether the pattern names exactly this slash-separated path.
func (p *pattern) match(rel string) bool {
	switch p.kind {
	case exactMatch:
		return rel == p.cleaned
	case prefixMatch:
		return strings.HasPrefix(rel, p.cleaned[:len(p.cleaned)-2])
	case suffixMatch:
		suffix := p.cleaned[2:]
		if strings.HasSuffix(rel, suffix) {
			return true
		}
		return suffix[0] == '/' && rel == suffix[1:] // "**/name" names "name" too
	default:
		return p.re.MatchString(rel)
	}
}

// matchSelfOrParent reports whether the pattern names the path or one of
// the directories above it.
func (p *pattern) matchSelfOrParent(rel string) bool {
	if p.match(rel) {
		return true
	}
	for i := 0; i < len(rel); i++ {
		if rel[i] == '/' && p.match(rel[:i]) {
			return true
		}
	}
	return false
}

// withoutTrailingGlob is the literal part of a pattern for fsutil's
// pruning test: "dir/**" and "dir/*" both stand for "dir".
func (p *pattern) withoutTrailingGlob() string {
	s := strings.TrimSuffix(p.cleaned, "/**")
	return strings.TrimSuffix(s, "/*")
}
