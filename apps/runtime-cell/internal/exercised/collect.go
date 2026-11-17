package exercised

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Bounds on what Collect reads from a claim's coverage directory.
const (
	MaxCoverageFiles = 64
	MaxCoverageBytes = 64 << 20 // all files together
)

// ErrCoverageTooLarge: the claim wrote more coverage than Collect reads.
var ErrCoverageTooLarge = errors.New("exercised: coverage past the bound")

// Collect reads the coverage files (coverage-*.json, regular files only, no
// link followed) a claim's Node services wrote to dir. A missing or empty
// dir is no coverage, not an error; a file that does not parse is skipped.
func Collect(dir string) ([]*Coverage, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("exercised: read %s: %w", dir, err)
	}
	var names []string
	for _, e := range entries {
		if e.Type().IsRegular() && strings.HasPrefix(e.Name(), "coverage-") && strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	if len(names) > MaxCoverageFiles {
		return nil, ErrCoverageTooLarge
	}
	sort.Strings(names)
	var out []*Coverage
	left := int64(MaxCoverageBytes)
	for _, n := range names {
		raw, err := readBounded(filepath.Join(dir, n), left)
		if err != nil {
			return nil, err
		}
		left -= int64(len(raw))
		if c, err := ParseCoverage(raw); err == nil {
			out = append(out, c)
		}
	}
	return out, nil
}

func readBounded(p string, left int64) ([]byte, error) {
	f, err := os.OpenFile(p, os.O_RDONLY|noFollow, 0)
	if err != nil {
		return nil, fmt.Errorf("exercised: open coverage: %w", err)
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, left+1))
	if err != nil {
		return nil, fmt.Errorf("exercised: read coverage: %w", err)
	}
	if int64(len(raw)) > left {
		return nil, ErrCoverageTooLarge
	}
	return raw, nil
}

// Answer turns a request into results: coverage past the bound makes every
// JS file unknown (coverage_too_large).
func Answer(files []File, dir string, read Source) []Result {
	covs, err := Collect(dir)
	if err != nil {
		reason := ReasonNoCoverageWritten
		if errors.Is(err, ErrCoverageTooLarge) {
			reason = ReasonCoverageTooLarge
		}
		out := Measure(files, nil, read)
		for i := range out {
			if out[i].Reason == ReasonNoCoverageWritten {
				out[i].Reason = reason
			}
		}
		return out
	}
	return Measure(files, covs, read)
}
