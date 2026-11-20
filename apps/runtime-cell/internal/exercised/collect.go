package exercised

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Bounds on what Answer reads from a claim's coverage directory.
const (
	MaxCoverageFiles = 64
	MaxCoverageBytes = 64 << 20 // all files together
	// MaxStartMarkers: the most process starts Answer reads.
	MaxStartMarkers = 1024
)

// StartMarkerPrefix names the empty file the cell's preload leaves in the
// coverage directory when a Node process starts (compose.PreloadSource):
// started-<pid>-<ms>. A coverage file (coverage-<pid>-...json, Node's name)
// counts only when its pid has one: a file no process the preload started
// wrote is skipped, so it can lower the count, never raise it. The PR can
// write a marker too: this bounds a naive forgery, no more (the count stays
// advisory, docs/runtime/exercised-lines.md).
const StartMarkerPrefix = "started-"

// ErrCoverageTooLarge means the claim wrote more coverage than Answer reads.
var ErrCoverageTooLarge = errors.New("exercised: coverage past the bound")

// Answer turns a request into results from the coverage files
// (coverage-*.json, regular files only, no link followed) a claim's Node
// services wrote to dir. A missing or empty dir is no coverage; a file
// that does not parse is skipped. Only the scripts that map to a changed
// file are decoded (internal/exercised measure.go): the rest of a file is
// scanned, never kept. The error says why the answer is not a count:
// ErrCoverageTooLarge (more than the bounds, MaxPaint, or ctx ended: every
// JS file coverage_too_large) or ErrUntrusted (coverage no V8 writes:
// Untrusted, every JS file measured with none of its lines run).
func Answer(ctx context.Context, files []File, dir string, read Source) ([]Result, error) {
	m := newMeasurer(ctx, files, read)
	names, starts, err := coverageFiles(dir)
	if err != nil {
		if errors.Is(err, ErrCoverageTooLarge) {
			return m.failed(ErrBudget), err
		}
		return m.results(false), err
	}
	left := int64(MaxCoverageBytes)
	read1 := 0
	for _, n := range names {
		if !starts[pidOf(n, "coverage-")] {
			continue // no process the preload started wrote it
		}
		raw, err := readBounded(filepath.Join(dir, n), left)
		if err != nil {
			if errors.Is(err, ErrCoverageTooLarge) {
				return m.failed(ErrBudget), err
			}
			return m.results(false), err
		}
		left -= int64(len(raw))
		ok, err := m.addFile(raw)
		if err != nil {
			if errors.Is(err, ErrUntrusted) {
				return m.failed(err), err
			}
			return m.failed(ErrBudget), errors.Join(ErrCoverageTooLarge, err)
		}
		if ok {
			read1++
		}
	}
	return m.results(read1 > 0), nil
}

// coverageFiles names the coverage files of dir, sorted, and the pids the
// preload saw start, within the bounds.
func coverageFiles(dir string) ([]string, map[string]bool, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("exercised: read %s: %w", dir, err)
	}
	var names []string
	starts := map[string]bool{}
	markers := 0
	for _, e := range entries {
		switch {
		case !e.Type().IsRegular():
		case strings.HasPrefix(e.Name(), "coverage-") && strings.HasSuffix(e.Name(), ".json"):
			names = append(names, e.Name())
		case strings.HasPrefix(e.Name(), StartMarkerPrefix):
			markers++
			if pid := pidOf(e.Name(), StartMarkerPrefix); pid != "" {
				starts[pid] = true
			}
		}
	}
	if len(names) > MaxCoverageFiles || markers > MaxStartMarkers {
		return nil, nil, ErrCoverageTooLarge
	}
	sort.Strings(names)
	return names, starts, nil
}

// pidOf is the pid a coverage file or start marker name carries after
// prefix (the digits up to the next '-' or '.'), "" when none.
func pidOf(name, prefix string) string {
	rest := strings.TrimPrefix(name, prefix)
	end := strings.IndexAny(rest, "-.")
	if end < 0 {
		end = len(rest)
	}
	pid := rest[:end]
	if pid == "" || strings.Trim(pid, "0123456789") != "" {
		return ""
	}
	return pid
}

func readBounded(p string, left int64) ([]byte, error) {
	f, err := os.OpenFile(p, os.O_RDONLY|noFollow, 0) //nolint:gosec // G304: a file of the claim's own coverage directory, never followed through a link
	if err != nil {
		return nil, fmt.Errorf("exercised: open coverage: %w", err)
	}
	defer func() { _ = f.Close() }()
	raw, err := io.ReadAll(io.LimitReader(f, left+1))
	if err != nil {
		return nil, fmt.Errorf("exercised: read coverage: %w", err)
	}
	if int64(len(raw)) > left {
		return nil, ErrCoverageTooLarge
	}
	return raw, nil
}

// addFile counts the relevant scripts of one coverage file in two passes:
// the source map cache first (it follows the result in Node's files, and
// says which scripts map to a changed file), then the result, script by
// script, decoding the ranges of a relevant one only. ok is false when the
// file is not JSON (written while read): skipped. JSON that is not the
// shape V8 writes is ErrUntrusted.
func (m *measurer) addFile(raw []byte) (ok bool, err error) {
	var head struct {
		SourceMapCache map[string]SourceMap `json:"source-map-cache"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		var syntax *json.SyntaxError
		if errors.As(err, &syntax) {
			return false, nil
		}
		return true, fmt.Errorf("%w: a source map cache of another shape", ErrUntrusted)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := delim(dec, '{'); err != nil {
		return true, err
	}
	for dec.More() {
		key, err := token[string](dec)
		if err != nil {
			return true, err
		}
		if key != "result" {
			if err := skip(dec); err != nil {
				return true, err
			}
			continue
		}
		if err := delim(dec, '['); err != nil {
			return true, err
		}
		for dec.More() {
			if err := m.ctx.Err(); err != nil {
				return true, errors.Join(ErrBudget, err)
			}
			s, relevant, err := m.nextScript(dec, head.SourceMapCache)
			if err != nil {
				return true, err
			}
			if !relevant {
				continue
			}
			if err := m.add(s, head.SourceMapCache); err != nil {
				return true, err
			}
		}
		if err := delim(dec, ']'); err != nil {
			return true, err
		}
	}
	return true, nil
}

// nextScript reads one script of the result. Its ranges are decoded only
// when its URL (V8 writes it before the functions) is relevant; a script
// that names its functions first is decoded whole.
func (m *measurer) nextScript(dec *json.Decoder, smc map[string]SourceMap) (s Script, relevant bool, err error) {
	if err := delim(dec, '{'); err != nil {
		return s, false, err
	}
	known := false
	for dec.More() {
		key, err := token[string](dec)
		if err != nil {
			return s, false, err
		}
		switch {
		case key == "url":
			if dec.Decode(&s.URL) != nil {
				return s, false, fmt.Errorf("%w: a script url that is not a string", ErrUntrusted)
			}
			known = true
		case key == "functions" && known && !m.relevant(s.URL, smc):
			err = skip(dec)
		case key == "functions":
			if dec.Decode(&s.Functions) != nil {
				err = fmt.Errorf("%w: functions of another shape", ErrUntrusted)
			}
		default:
			err = skip(dec)
		}
		if err != nil {
			return s, false, err
		}
	}
	if err := delim(dec, '}'); err != nil {
		return s, false, err
	}
	return s, m.relevant(s.URL, smc), nil
}

// skipValue decodes into nothing: objects and arrays of objects keep no
// field, scalars are dropped.
type skipValue struct{}

func (*skipValue) UnmarshalJSON([]byte) error { return nil }

// skip passes over the next value, keeping none of it.
func skip(dec *json.Decoder) error {
	var v skipValue
	if dec.Decode(&v) != nil {
		return fmt.Errorf("%w: not the JSON of a coverage file", ErrUntrusted)
	}
	return nil
}

func delim(dec *json.Decoder, want json.Delim) error {
	d, err := token[json.Delim](dec)
	if err != nil || d != want {
		return fmt.Errorf("%w: a coverage file of another shape", ErrUntrusted)
	}
	return nil
}

func token[T any](dec *json.Decoder) (T, error) {
	var zero T
	t, err := dec.Token()
	if err != nil {
		return zero, fmt.Errorf("%w: not the JSON of a coverage file", ErrUntrusted)
	}
	v, ok := t.(T)
	if !ok {
		return zero, fmt.Errorf("%w: a coverage file of another shape", ErrUntrusted)
	}
	return v, nil
}
