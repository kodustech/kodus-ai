package cellupdate

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/releasesig"
)

// IndexStateName is what a host keeps of the release indexes it accepted
// (index.go in releasesig): the latest issue time, so an older index is
// refused, and every key ever revoked, so a revocation is never forgotten.
const IndexStateName = "release-index.state"

type indexState struct {
	Issued      time.Time `json:"issued"`
	RevokedKeys []string  `json:"revokedKeys"`
}

func loadIndexState(root string) (indexState, error) {
	b, err := os.ReadFile(filepath.Join(root, IndexStateName)) //nolint:gosec // G304: the installer's directory
	if errors.Is(err, os.ErrNotExist) {
		return indexState{}, nil
	}
	if err != nil {
		return indexState{}, err
	}
	var s indexState
	if err := json.Unmarshal(b, &s); err != nil {
		// A state the host cannot read is refused, never treated as empty: that would forget revocations.
		return indexState{}, fmt.Errorf("cell update: %s is unreadable (%v); restore it or remove it knowingly", filepath.Join(root, IndexStateName), err)
	}
	return s, nil
}

func saveIndexState(root string, s indexState) error {
	if err := os.MkdirAll(root, 0o755); err != nil { //nolint:gosec // G301: the installer's directory
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	p := filepath.Join(root, IndexStateName)
	tmp := p + ".tmp-" + strconv.Itoa(os.Getpid())
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil { //nolint:gosec // G306: public release metadata
		return err
	}
	return os.Rename(tmp, p)
}

// allowedByIndex: a semver release between the index's minimum and latest,
// or exactly the index's latest when either is not semver (a dev build is
// installed only when an index names it).
func allowedByIndex(release string, ix releasesig.Index) error {
	want, okWant := parseRelease(release)
	latest, okLatest := parseRelease(ix.Latest)
	if !okWant || !okLatest {
		if release != ix.Latest {
			return refuseOrder("release %s is not the release index's latest (%s)", release, ix.Latest)
		}
		return nil
	}
	if compareRelease(want, latest) > 0 {
		return refuseOrder("release %s is newer than the release index's latest (%s): fetch the current index", release, ix.Latest)
	}
	if minimum, ok := parseRelease(ix.Minimum); ok && compareRelease(want, minimum) < 0 {
		return refuseOrder("release %s is below the release index's minimum %s, which no host may install", release, ix.Minimum)
	}
	return nil
}

func union(a, b []string) []string {
	out := append([]string{}, a...)
	for _, k := range b {
		if !slices.Contains(out, k) {
			out = append(out, k)
		}
	}
	slices.Sort(out)
	return out
}

func unrevoked(keys []releasesig.PublicKey, revoked []string) []releasesig.PublicKey {
	return slices.DeleteFunc(slices.Clone(keys), func(k releasesig.PublicKey) bool { return slices.Contains(revoked, k.ID) })
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}
