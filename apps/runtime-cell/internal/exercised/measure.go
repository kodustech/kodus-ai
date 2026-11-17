// Package exercised counts which of a PR's changed lines its Node services
// ran (feature exercisedLines), from the V8 coverage they wrote
// (NODE_V8_COVERAGE). The coverage never leaves the claim: Measure returns
// line counts per file.
package exercised

import (
	"encoding/json"
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
	// MaxPaint: the most range units painted for one script.
	MaxPaint = 256 << 20
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

// Coverage is one NODE_V8_COVERAGE file.
type Coverage struct {
	Result []struct {
		URL       string `json:"url"`
		Functions []struct {
			Ranges []struct {
				Start int `json:"startOffset"`
				End   int `json:"endOffset"`
				Count int `json:"count"`
			} `json:"ranges"`
		} `json:"functions"`
	} `json:"result"`
	SourceMapCache map[string]struct {
		URL         string `json:"url"`
		LineLengths []int  `json:"lineLengths"`
		Data        *struct {
			Sources    []string `json:"sources"`
			SourceRoot string   `json:"sourceRoot"`
			Mappings   string   `json:"mappings"`
		} `json:"data"`
	} `json:"source-map-cache"`
}

// ParseCoverage reads one coverage file.
func ParseCoverage(raw []byte) (*Coverage, error) {
	var c Coverage
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("exercised: coverage: %w", err)
	}
	return &c, nil
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
// request mapped, which proves the mapping works.
func Measure(files []File, coverages []*Coverage, read Source) []Result {
	out := make([]Result, len(files))
	ran := make([]map[int]bool, len(files))
	mapped := make([]bool, len(files))
	broken := make([]bool, len(files))
	var paths []string
	for i, f := range files {
		out[i] = Result{Path: f.Path, Changed: len(uniq(f.Lines))}
		ran[i] = map[int]bool{}
		paths = append(paths, f.Path)
	}
	if len(coverages) == 0 {
		for i := range out {
			out[i].Reason = ReasonNoCoverageWritten
			if !IsJS(files[i].Path) {
				out[i].Reason = ReasonUnsupportedLanguage
			}
		}
		return out
	}
	for _, cov := range coverages {
		for _, script := range cov.Result {
			counted, ok := paint(script.Functions)
			if !ok {
				continue
			}
			if sm, has := cov.SourceMapCache[script.URL]; has && sm.Data != nil {
				segs, err := decodeMappings(sm.Data.Mappings)
				starts := lineStarts(sm.LineLengths)
				for si, src := range sm.Data.Sources {
					i := match(paths, resolve(script.URL, sm.URL, sm.Data.SourceRoot, src))
					if i < 0 {
						continue
					}
					if err != nil {
						broken[i] = true
						continue
					}
					mapped[i] = true
					for _, s := range segs {
						if s.source != si || s.genLine >= len(starts) {
							continue
						}
						if at := starts[s.genLine] + s.genCol; at < len(counted) && counted[at] {
							ran[i][s.srcLine+1] = true
						}
					}
				}
				continue
			}
			i := match(paths, script.URL)
			if i < 0 {
				continue
			}
			text, err := read(files[i].Path)
			units := utf16.Encode([]rune(string(text)))
			if err != nil || len(units) < len(counted) {
				broken[i] = true // not the script the service ran
				continue
			}
			mapped[i] = true
			line := 1
			for at, u := range units {
				if u == '\n' {
					line++
					continue
				}
				if at < len(counted) && counted[at] && !unicode.IsSpace(rune(u)) {
					ran[i][line] = true
				}
			}
		}
	}
	proven := false
	for i := range files {
		proven = proven || mapped[i]
	}
	for i, f := range files {
		switch {
		case !IsJS(f.Path):
			out[i].Reason = ReasonUnsupportedLanguage
		case mapped[i]:
			out[i].Measured = true
			for _, l := range uniq(f.Lines) {
				if ran[i][l] {
					out[i].Exercised++
				}
			}
		case broken[i]:
			out[i].Reason = ReasonUnmappedSource
		case proven:
			out[i].Measured = true
		default:
			out[i].Reason = ReasonNotLoadedUnproven
		}
	}
	return out
}

// paint says, per UTF-16 unit of a script, whether its innermost range ran:
// wider ranges first, narrower ones over them. False when the script is
// past the bounds.
func paint(functions []struct {
	Ranges []struct {
		Start int `json:"startOffset"`
		End   int `json:"endOffset"`
		Count int `json:"count"`
	} `json:"ranges"`
}) ([]bool, bool) {
	type rng struct{ start, end, count int }
	var rs []rng
	size, work := 0, 0
	for _, fn := range functions {
		for _, r := range fn.Ranges {
			if r.Start < 0 || r.End < r.Start || r.End > MaxScriptUnits {
				return nil, false
			}
			rs = append(rs, rng{r.Start, r.End, r.Count})
			size = max(size, r.End)
			work += r.End - r.Start
			if work > MaxPaint {
				return nil, false
			}
		}
	}
	sort.SliceStable(rs, func(a, b int) bool { return rs[a].end-rs[a].start > rs[b].end-rs[b].start })
	counted := make([]bool, size)
	for _, r := range rs {
		for at := r.start; at < r.end; at++ {
			counted[at] = r.count > 0
		}
	}
	return counted, true
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
