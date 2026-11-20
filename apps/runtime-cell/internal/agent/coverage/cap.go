package coverage

import (
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/exercised"
)

// The bound of a claim's coverage directory. The services write it as a
// bind, outside their writable layer's storage_opt cap, so the directory
// is a tmpfs of its own: past DirBytes or DirFiles a write fails (ENOSPC)
// inside the PR's process, and nothing reaches the host's disk. DirBytes is
// a little above what exercised.Collect reads, so coverage that hit the
// cap reads as coverage_too_large, never as a silent undercount.
const (
	DirBytes = exercised.MaxCoverageBytes + 1<<20
	DirFiles = 4*exercised.MaxCoverageFiles + exercised.MaxStartMarkers
)

// ErrUncapped means the coverage directory could not be bounded, so the claim
// is not instrumented.
var ErrUncapped = errors.New("coverage: the coverage directory cannot be capped")

// Capper bounds a claim's coverage directory. Cap leaves dir a mount of at
// most DirBytes and DirFiles, or fails; a dir capped already stays as it
// is (a reset's boot). Release takes the cap off, and does nothing to a dir
// that has none. Recover takes off the caps a cell that stopped without
// its releases left under claims (<workdir>/claims), and says how many.
type Capper interface {
	Cap(dir string) error
	Release(dir string) error
	Recover(claims string) (int, error)
}

// FakeCap is a Capper for tests: it records the dirs it capped, or fails
// with Err.
type FakeCap struct {
	Err    error
	mu     sync.Mutex
	capped []string
}

func (f *FakeCap) Cap(dir string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Err != nil {
		return f.Err
	}
	if !slices.Contains(f.capped, dir) {
		f.capped = append(f.capped, dir)
	}
	return nil
}

func (f *FakeCap) Release(dir string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.capped = slices.DeleteFunc(f.capped, func(d string) bool { return d == dir })
	return nil
}

// Recover takes off every cap under claims.
func (f *FakeCap) Recover(claims string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := len(f.capped)
	f.capped = slices.DeleteFunc(f.capped, func(d string) bool { return strings.HasPrefix(d, claims+string(filepath.Separator)) })
	return n - len(f.capped), nil
}

// Capped is the dirs capped now.
func (f *FakeCap) Capped() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.capped)
}
