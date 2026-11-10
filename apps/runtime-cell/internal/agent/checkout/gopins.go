package checkout

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/mirror"
)

// Bounds on what GoSumPins reads: a Go workspace (go.work) has one go.sum
// per module plus go.work.sum.
const (
	maxGoSumFiles = 500
	maxGoSumBytes = 32 << 20
)

// GoSumPins is what the checkout's go.sum and go.work.sum files pin, as
// module@version, sorted; none without one. Only regular files count (a
// symlink is not followed), node_modules is skipped, and past the bounds the
// checkout is refused rather than half pinned.
func GoSumPins(repo string) ([]string, error) {
	set := map[string]bool{}
	files, total := 0, int64(0)
	err := filepath.WalkDir(repo, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "node_modules" || d.Name() == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if (d.Name() != "go.sum" && d.Name() != "go.work.sum") || !d.Type().IsRegular() {
			return nil
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		if files++; files > maxGoSumFiles {
			return errors.New("more go.sum files than the mirror pins")
		}
		if total += fi.Size(); total > maxGoSumBytes {
			return errors.New("go.sum files larger than the mirror pins")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		pins, err := mirror.ParseGoSum(data)
		if err != nil {
			rel, _ := filepath.Rel(repo, path)
			return errors.New(rel + ": " + err.Error())
		}
		for p := range pins {
			set[p] = true
		}
		if len(set) > mirror.MaxGoPins {
			return errors.New("the checkout pins more Go modules than the mirror serves")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(set) == 0 {
		return nil, nil
	}
	out := make([]string, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	slices.Sort(out)
	return out, nil
}
