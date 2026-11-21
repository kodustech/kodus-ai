package cellupdate

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/releasesig"
)

// Downgrade protection. A signature binds a release to its name, not to the
// host's history: any older signed release, a vulnerable one included,
// verifies. So Install orders the release asked for against the one that
// runs `cell update` (the installed one) and refuses a lower one unless the
// operator says -allow-downgrade.
//
// Release names are the release workflow's: "v1.2.3" for a tag
// runtime-cell/v1.2.3 (the "runtime-cell/" prefix is accepted too), and
// "v0.0.0-dev+<sha>" for a build dispatched from a branch. They are ordered
// as semver 2.0.0: build metadata is ignored and a pre-release is lower than
// its release, so
//
//   - a dev build sorts below every release: installing one over a release
//     is a downgrade and needs -allow-downgrade;
//   - two dev builds are the same version (only their +<sha> differs): one
//     replaces the other freely, as a dev host expects;
//   - an installed binary whose version is not semver (a local build, which
//     reports "dev") has no release to protect: nothing is refused;
//   - a release name that is not semver cannot be ordered against an
//     installed release: refused without -allow-downgrade.

var semverRE = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)

type semver struct {
	core [3]string
	pre  []string
}

func parseRelease(name string) (semver, bool) {
	m := semverRE.FindStringSubmatch(strings.TrimPrefix(name, "runtime-cell/"))
	if m == nil {
		return semver{}, false
	}
	v := semver{core: [3]string{m[1], m[2], m[3]}}
	if m[4] != "" {
		v.pre = strings.Split(m[4], ".")
	}
	return v, true
}

// compareRelease orders a and b as semver: -1, 0 or 1.
func compareRelease(a, b semver) int {
	for i := range a.core {
		if c := compareNumeric(a.core[i], b.core[i]); c != 0 {
			return c
		}
	}
	switch {
	case len(a.pre) == 0 && len(b.pre) == 0:
		return 0
	case len(a.pre) == 0:
		return 1
	case len(b.pre) == 0:
		return -1
	}
	for i := 0; i < len(a.pre) && i < len(b.pre); i++ {
		if c := comparePre(a.pre[i], b.pre[i]); c != 0 {
			return c
		}
	}
	return compareInt(len(a.pre), len(b.pre))
}

// comparePre orders two pre-release identifiers: numeric ones numerically
// and below alphanumeric ones, alphanumeric ones in ASCII order.
func comparePre(a, b string) int {
	an, bn := isNumeric(a), isNumeric(b)
	switch {
	case an && bn:
		return compareNumeric(a, b)
	case an:
		return -1
	case bn:
		return 1
	}
	return strings.Compare(a, b)
}

// compareNumeric orders two decimal strings without converting them, so no
// length overflows. Leading zeros are not expected (semverRE refuses them in
// the core).
func compareNumeric(a, b string) int {
	a, b = strings.TrimLeft(a, "0"), strings.TrimLeft(b, "0")
	if c := compareInt(len(a), len(b)); c != 0 {
		return c
	}
	return strings.Compare(a, b)
}

func compareInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func isNumeric(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

// checkOrder refuses release when it is lower than installed, or cannot be
// ordered against it, unless allowDowngrade.
func checkOrder(installed, release string, allowDowngrade bool) error {
	if allowDowngrade {
		return nil
	}
	have, ok := parseRelease(installed)
	if !ok {
		return nil
	}
	want, ok := parseRelease(release)
	if !ok {
		return refuseOrder("%q is not a semver release name and cannot be ordered against the installed %s; pass -allow-downgrade to install it anyway", release, installed)
	}
	if compareRelease(want, have) < 0 {
		return refuseOrder("%s is older than the installed %s; pass -allow-downgrade to install it anyway", release, installed)
	}
	return nil
}

func refuseOrder(format string, a ...any) error {
	return &releasesig.Error{Reason: fmt.Sprintf(format, a...)}
}
