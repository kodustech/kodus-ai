// Package claims is the cell's record of the claims it holds: each claim's
// state machine (acquiring, ready, failed, held, released), its machines,
// the steps running on it and its egress policy, all behind the claim's own
// lock; and the registry that bounds how many a cell holds.
package claims

import (
	"errors"
	"path/filepath"
	"regexp"
)

// idPattern is what a claim id may be. The id names the claim's work
// directory, which the cell removes when the claim ends: a separator, "." or
// ".." from the hub would point that removal outside the work dir. The hub
// makes ids as claim-<hash>.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// ValidID reports whether id is a claim id the cell accepts.
func ValidID(id string) bool { return idPattern.MatchString(id) }

// WorkDir is the claim's directory under base, refused for an id that is
// not a plain path segment.
func WorkDir(base, claimID string) (string, error) {
	if !ValidID(claimID) {
		return "", errors.New("claim id is not a path segment")
	}
	return filepath.Join(base, "claims", claimID), nil
}
