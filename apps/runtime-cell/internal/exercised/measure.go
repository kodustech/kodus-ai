// Package exercised counts which of a PR's changed lines its Node services
// ran (feature exercisedLines), from the V8 coverage they wrote
// (NODE_V8_COVERAGE). The coverage never leaves the claim: Measure returns
// line counts per file.
//
// The coverage is written by the PR's own processes, so it is evidence the
// PR could forge. Four things bound what a forgery buys: only the scripts
// that map to a changed file are read at all, under one work budget per
// answer; a script is counted only when its shape matches the checkout's
// file (its length, or for a source mapped file the lines and the source
// text its map names); a coverage file counts only when a process the
// cell's preload started wrote it (collect.go, start markers); and coverage
// no V8 writes (a range outside its own function, a negative or reversed
// range, line lengths that do not add up to the script) is refused whole,
// failing closed (Untrusted). Coverage shaped like V8's that claims lines ran which did
// not cannot be told from the real thing inside the claim: the count is
// advisory against a hostile PR (docs/runtime/exercised-lines.md).
package exercised

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path"
	"sort"
	"strings"
	"unicode"
	"unicode/utf16"
)

// Reasons a file is unknown (EXERCISED_UNKNOWN_REASONS).
const (
	ReasonNoCoverageWritten   = "no_coverage_written"
	ReasonNotLoadedUnproven   = "not_loaded_unproven"
	ReasonUnmappedSource      = "unmapped_source"
	ReasonUnsupportedLanguage = "unsupported_language"
	ReasonUnsupportedDriver   = "unsupported_driver"
	ReasonCoverageTooLarge    = "coverage_too_large"
)

// Limits on what Measure reads.
const (
	// MaxScriptUnits: a script longer than this (UTF-16 units) is not painted.
	MaxScriptUnits = 16 << 20
	// MaxPaint: the most range units painted for one answer, every script
	// of every coverage file together. Past it the answer is
	// coverage_too_large.
	MaxPaint = 256 << 20
)

// paintBudget is MaxPaint, lowered by a test to decide on the work counted.
var paintBudget = MaxPaint

var (
	// ErrBudget: the answer went past MaxPaint (or its context ended).
	ErrBudget = errors.New("exercised: coverage past the work budget")
	// ErrUntrusted: the coverage holds what V8 never writes.
	ErrUntrusted = errors.New("exercised: coverage no V8 writes")
)

// File is one changed file: its repository path and changed lines (1-based, new side).
type File struct {
	Path  string
	Lines []int
}

// Result is one file's count. Exercised is meaningful only when Measured.
type Result struct {
	Path      string
	Changed   int
	Exercised int
	Measured  bool
	Reason    string
}

// Range is one V8 range: UTF-16 offsets and how many times it ran.
type Range struct {
	Start int `json:"startOffset"`
	End   int `json:"endOffset"`
	Count int `json:"count"`
}

// Function is one V8 function: its own range first, its blocks after.
type Function struct {
	Ranges []Range `json:"ranges"`
}

// Script is one script of a coverage file.
type Script struct {
	URL       string     `json:"url"`
	Functions []Function `json:"functions"`
}

// SourceMap is one entry of the coverage's source-map-cache.
type SourceMap struct {
	URL         string `json:"url"`
	LineLengths []int  `json:"lineLengths"`
	Data        *struct {
		Sources        []string  `json:"sources"`
		SourcesContent []*string `json:"sourcesContent"`
		SourceRoot     string    `json:"sourceRoot"`
		Mappings       string    `json:"mappings"`
	} `json:"data"`
}

// Coverage is one NODE_V8_COVERAGE file.
type Coverage struct {
	Result         []Script             `json:"result"`
	SourceMapCache map[string]SourceMap `json:"source-map-cache"`
}

// Source reads a repository file from the claim's checkout (plain JS is
// matched to the script by its text), or fails.
type Source func(repoPath string) ([]byte, error)

// IsJS says whether a path is a JS or TS file, the only ones measured.
func IsJS(p string) bool {
	switch path.Ext(p) {
	case ".js", ".cjs", ".mjs", ".jsx", ".ts", ".cts", ".mts", ".tsx":
		return true
	}
	return false
}

// Measure counts each file's changed lines that ran in any of the coverage
// files (each takeCoverage resets the counters, so a character ran when it
// ran in one of them). A character counts by its innermost range; a line of
// a script ran when a non-blank character on it ran; a line of a source
// mapped file ran when a segment mapping to it starts on a character that
// ran, and a line no segment maps to did not. A file nothing maps to is
// unknown (not_loaded_unproven), or measured at 0 when another file of the
// request mapped, which proves the mapping works. Coverage past the budget
// is coverage_too_large; coverage no V8 writes fails closed (Untrusted).
func Measure(files []File, coverages []*Coverage, read Source) []Result {
	m := newMeasurer(context.Background(), files, read)
	for _, cov := range coverages {
		for _, s := range cov.Result {
			if !m.relevant(s.URL, cov.SourceMapCache) {
				continue
			}
			if err := m.add(s, cov.SourceMapCache); err != nil {
				return m.failed(err)
			}
		}
	}
	return m.results(len(coverages) > 0)
}

// measurer is one answer's state: what each changed file ran, and the
// budget left.
type measurer struct {
	ctx    context.Context
	files  []File
	paths  []string
	read   Source
	ran    []map[int]bool
	mapped []bool
	broken []bool
	texts  map[int]checkoutText
	paint  int
}

// checkoutText is a changed file as the checkout holds it.
type checkoutText struct {
	text  string
	units []uint16
	lines int
	err   error
}

func newMeasurer(ctx context.Context, files []File, read Source) *measurer {
	m := &measurer{ctx: ctx, files: files, read: read, ran: make([]map[int]bool, len(files)), mapped: make([]bool, len(files)),
		broken: make([]bool, len(files)), texts: map[int]checkoutText{}, paint: paintBudget}
	for i, f := range files {
		m.paths = append(m.paths, f.Path)
		m.ran[i] = map[int]bool{}
	}
	return m
}

// relevant: the script is a changed file, or its source map names one. Only
// those are decoded and painted.
func (m *measurer) relevant(scriptURL string, smc map[string]SourceMap) bool {
	if sm, has := smc[scriptURL]; has && sm.Data != nil {
		for _, src := range sm.Data.Sources {
			if match(m.paths, resolve(scriptURL, sm.URL, sm.Data.SourceRoot, src)) >= 0 {
				return true
			}
		}
		return false
	}
	return match(m.paths, scriptURL) >= 0
}

// text is changed file i as the checkout holds it, read once.
func (m *measurer) text(i int) checkoutText {
	if t, ok := m.texts[i]; ok {
		return t
	}
	raw, err := m.read(m.files[i].Path)
	t := checkoutText{err: err}
	if err == nil {
		t.text = string(raw)
		t.units = utf16.Encode([]rune(t.text))
		t.lines = strings.Count(t.text, "\n") + 1
	}
	m.texts[i] = t
	return t
}

// add counts one relevant script.
func (m *measurer) add(script Script, smc map[string]SourceMap) error {
	if err := m.ctx.Err(); err != nil {
		return errors.Join(ErrBudget, err)
	}
	size, err := scriptSize(script.Functions)
	if err != nil || size > MaxScriptUnits {
		return err // past MaxScriptUnits: not painted
	}
	// What the script would count for is checked against the checkout
	// first: a script of no changed file's shape is never painted.
	if sm, has := smc[script.URL]; has && sm.Data != nil {
		if err := fitsTheScript(sm.LineLengths, size); err != nil {
			return err
		}
		segs, derr := decodeMappings(sm.Data.Mappings)
		targets := map[int]int{} // source index to changed file
		for si, src := range sm.Data.Sources {
			i := match(m.paths, resolve(script.URL, sm.URL, sm.Data.SourceRoot, src))
			if i < 0 {
				continue
			}
			if derr != nil || !m.mapsTheCheckout(i, si, sm, segs) {
				m.broken[i] = true // not a map of this checkout's file
				continue
			}
			targets[si] = i
		}
		if len(targets) == 0 {
			return nil
		}
		counted, err := m.paintScript(script.Functions, size)
		if err != nil {
			return err
		}
		starts := lineStarts(sm.LineLengths)
		for _, i := range targets {
			m.mapped[i] = true
		}
		for _, s := range segs {
			i, ok := targets[s.source]
			if !ok || s.genLine >= len(starts) {
				continue
			}
			if at := starts[s.genLine] + s.genCol; at < len(counted) && counted[at] {
				m.ran[i][s.srcLine+1] = true
			}
		}
		return nil
	}
	i := match(m.paths, script.URL)
	if i < 0 {
		return nil
	}
	// A script's top-level range spans its whole source, so a script of
	// another length is another file with the same path (a service of
	// another repository, a different build), never painted over this one.
	t := m.text(i)
	if t.err != nil || len(t.units) != size {
		m.broken[i] = true
		return nil
	}
	counted, err := m.paintScript(script.Functions, size)
	if err != nil {
		return err
	}
	m.mapped[i] = true
	line := 1
	for at, u := range t.units {
		if u == '\n' {
			line++
			continue
		}
		if counted[at] && !unicode.IsSpace(rune(u)) {
			m.ran[i][line] = true
		}
	}
	return nil
}

// mapsTheCheckout: source si of the map is changed file i as the checkout
// holds it. Its text, when the map carries it, is the checkout's; and no
// segment maps past the file's last line.
func (m *measurer) mapsTheCheckout(i, si int, sm SourceMap, segs []segment) bool {
	t := m.text(i)
	if t.err != nil {
		return false
	}
	if c := sm.Data.SourcesContent; si < len(c) && c[si] != nil && *c[si] != t.text {
		return false
	}
	for _, s := range segs {
		if s.source == si && s.srcLine >= t.lines {
			return false
		}
	}
	return true
}

// fitsTheScript checks the line lengths Node recorded for a generated
// script against the script V8 ran (size, its top-level range): the lines
// and one terminator between each two (two for a CRLF) add up to it. Lines
// that do not are coverage no V8 writes (S1-04). None recorded: nothing to
// check.
func fitsTheScript(lengths []int, size int) error {
	if len(lengths) == 0 {
		return nil
	}
	sum := 0
	for _, n := range lengths {
		if n < 0 || n > MaxScriptUnits {
			return fmt.Errorf("%w: a line of %d units", ErrUntrusted, n)
		}
		sum += n
	}
	if gaps := len(lengths) - 1; size < sum+gaps || size > sum+2*gaps {
		return fmt.Errorf("%w: %d lines of %d units in a script of %d", ErrUntrusted, len(lengths), sum, size)
	}
	return nil
}

// scriptSize is how long the script is (its widest range's end), or
// ErrUntrusted when a range is what V8 never writes: negative, reversed,
// or a block outside its own function's range.
func scriptSize(functions []Function) (int, error) {
	size := 0
	for _, fn := range functions {
		for k, r := range fn.Ranges {
			if r.Start < 0 || r.End < r.Start {
				return 0, fmt.Errorf("%w: a range from %d to %d", ErrUntrusted, r.Start, r.End)
			}
			if own := fn.Ranges[0]; k > 0 && (r.Start < own.Start || r.End > own.End) {
				return 0, fmt.Errorf("%w: a block outside its function", ErrUntrusted)
			}
			size = max(size, r.End)
		}
	}
	return size, nil
}

// paintScript says, per UTF-16 unit of a script of size units (checked by
// scriptSize), whether its innermost range ran: wider ranges first,
// narrower ones over them. ErrBudget when the answer's paint budget is
// spent.
func (m *measurer) paintScript(functions []Function, size int) ([]bool, error) {
	n, work := 0, 0
	for _, fn := range functions {
		n += len(fn.Ranges)
		for _, r := range fn.Ranges {
			work += r.End - r.Start
			if work > m.paint {
				return nil, ErrBudget
			}
		}
	}
	m.paint -= work
	rs := make([]Range, 0, n)
	for _, fn := range functions {
		rs = append(rs, fn.Ranges...)
	}
	sort.SliceStable(rs, func(a, b int) bool { return rs[a].End-rs[a].Start > rs[b].End-rs[b].Start })
	counted := make([]bool, size)
	for k, r := range rs {
		if k&1023 == 0 && m.ctx.Err() != nil {
			return nil, errors.Join(ErrBudget, m.ctx.Err())
		}
		ran := r.Count > 0
		for at := r.Start; at < r.End; at++ {
			counted[at] = ran
		}
	}
	return counted, nil
}

// results is what the answer says per file; any is whether a coverage
// file was read at all.
func (m *measurer) results(any bool) []Result {
	out := make([]Result, len(m.files))
	proven := false
	for i := range m.files {
		proven = proven || m.mapped[i]
	}
	for i, f := range m.files {
		out[i] = Result{Path: f.Path, Changed: len(uniq(f.Lines))}
		switch {
		case !IsJS(f.Path):
			out[i].Reason = ReasonUnsupportedLanguage
		case !any:
			out[i].Reason = ReasonNoCoverageWritten
		case m.mapped[i]:
			out[i].Measured = true
			for _, l := range uniq(f.Lines) {
				if m.ran[i][l] {
					out[i].Exercised++
				}
			}
		case m.broken[i]:
			out[i].Reason = ReasonUnmappedSource
		case proven:
			out[i].Measured = true
		default:
			out[i].Reason = ReasonNotLoadedUnproven
		}
	}
	return out
}

// failed is the answer when the coverage could not be counted: past the
// budget, every JS file is coverage_too_large; coverage no V8 writes is
// Untrusted.
func (m *measurer) failed(err error) []Result {
	if errors.Is(err, ErrUntrusted) {
		return Untrusted(m.files)
	}
	out := m.results(false)
	for i := range out {
		if out[i].Reason == ReasonNoCoverageWritten {
			out[i].Reason = ReasonCoverageTooLarge
		}
	}
	return out
}

// Untrusted is the answer to coverage no V8 writes: every JS file measured
// with none of its changed lines run. It fails closed: a green Run whose
// coverage was forged is held back (below any threshold above 0), never
// cleared by it.
func Untrusted(files []File) []Result {
	out := make([]Result, len(files))
	for i, f := range files {
		out[i] = Result{Path: f.Path, Changed: len(uniq(f.Lines))}
		if IsJS(f.Path) {
			out[i].Measured = true
		} else {
			out[i].Reason = ReasonUnsupportedLanguage
		}
	}
	return out
}

// lineStarts turns a generated script's line lengths into the offset of each
// line, a one-unit terminator between lines (lineLengths leaves it out).
func lineStarts(lengths []int) []int {
	starts := make([]int, len(lengths))
	at := 0
	for i, n := range lengths {
		starts[i] = at
		at += n + 1
	}
	return starts
}

// resolve gives a source map source as an absolute URL: relative to the map,
// which is relative to the script.
func resolve(scriptURL, mapURL, root, source string) string {
	base, err := url.Parse(scriptURL)
	if err != nil {
		return source
	}
	if mapURL != "" && !strings.HasPrefix(mapURL, "data:") {
		if m, err := base.Parse(mapURL); err == nil {
			base = m
		}
	}
	ref := source
	if root != "" {
		ref = strings.TrimSuffix(root, "/") + "/" + source
	}
	u, err := base.Parse(ref)
	if err != nil {
		return source
	}
	return u.String()
}

// match is the index of the longest repository path the URL's path ends
// with ("/" + path), or -1.
func match(paths []string, rawURL string) int {
	p := rawURL
	if u, err := url.Parse(rawURL); err == nil && u.Scheme == "file" {
		p = u.Path
	} else if err == nil && u.Scheme != "" {
		return -1 // node:internal and friends
	}
	best := -1
	for i, rp := range paths {
		if (p == "/"+rp || strings.HasSuffix(p, "/"+rp)) && (best < 0 || len(rp) > len(paths[best])) {
			best = i
		}
	}
	return best
}

func uniq(lines []int) []int {
	seen := map[int]bool{}
	var out []int
	for _, l := range lines {
		if !seen[l] {
			seen[l] = true
			out = append(out, l)
		}
	}
	return out
}
