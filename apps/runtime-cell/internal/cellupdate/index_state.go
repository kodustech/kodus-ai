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
	// Minimum is the highest minimum of every index the host accepted: the
	// security floor no rollback goes below.
	Minimum string `json:"minimum,omitempty"`
	// ReleaseKeys is the key that signed each release this host installed,
	// by release directory name: a rollback never returns to a release
	// whose key was revoked since.
	ReleaseKeys map[string]string `json:"releaseKeys,omitempty"`
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
		return indexState{}, fmt.Errorf("cell update: %s is unreadable (%w); restore it or remove it knowingly", filepath.Join(root, IndexStateName), err)
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

// higherFloor is the higher of two minimums; one that is not semver never
// replaces a floor that is.
func higherFloor(seen, index string) string {
	a, okA := parseRelease(seen)
	b, okB := parseRelease(index)
	switch {
	case !okB:
		return seen
	case !okA || compareRelease(b, a) > 0:
		return index
	default:
		return seen
	}
}

// belowFloor says why the host must not return to the release in dir: it
// is below the highest minimum the host accepted, or it was signed with a
// key since revoked. A release whose name is not semver is below any floor.
// "" when it may be returned to. A release installed before the host kept
// its key (an older cell update, or the installer) is checked against the
// floor only.
func belowFloor(s indexState, dir string) string {
	name := releaseNameOf(dir)
	if floor, ok := parseRelease(s.Minimum); ok {
		if r, ok := parseRelease(name); !ok || compareRelease(r, floor) < 0 {
			return fmt.Sprintf("%s is below the minimum %s of the release index this host accepted", name, s.Minimum)
		}
	}
	if k, ok := s.ReleaseKeys[filepath.Base(dir)]; ok && slices.Contains(s.RevokedKeys, k) {
		return fmt.Sprintf("%s is signed with key %s, which is revoked", name, k)
	}
	return ""
}
