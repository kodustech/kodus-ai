package netguard

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// listsJSON is a byte-identical copy of libs/runtime/protocol/egress-lists.json:
// the deny list the API refuses approvals with and the recommended list
// (docs/runtime/egress-allowlist.md §7). lists_test.go fails when they differ.
//
//go:embed egress-lists.json
var listsJSON []byte

// Tier is how the cell reaches a recommended host.
type Tier string

const (
	// TierMirror: through the cell's read-only mirror; until the mirror
	// serves the ecosystem to a claim, the host is inspected.
	TierMirror Tier = "mirror"
	// TierInspected: TLS ends at the cell (the injector), GET and HEAD
	// only, under the entry's paths, no request body.
	TierInspected Tier = "inspected"
)

// RecommendedEntry is one host of the Kodus recommended list.
type RecommendedEntry struct {
	Host      string `json:"host"`
	Ecosystem string `json:"ecosystem"`
	Tier      Tier   `json:"tier"`
	// Paths are the prefixes a request may name; "*" is one path segment.
	Paths []string `json:"paths"`
	// ExceptPaths are refused under Paths.
	ExceptPaths []string `json:"exceptPaths,omitempty"`
	// Untrusted "refuse": never reached over TLS from a source that does not
	// trust the cell CA (the image builder): the host takes writes, and only
	// the inspected tier keeps them out.
	Untrusted string `json:"untrusted,omitempty"`
	// Build "passthrough": a read-only package or download CDN with no
	// write API, which an image build (whose RUN steps do not trust the cell
	// CA) reaches uninspected. Every other host is refused to a build.
	Build string `json:"build,omitempty"`
	Why   string `json:"why"`
	Doc   string `json:"doc"`
	Since int    `json:"since"`
}

type listsFile struct {
	About string `json:"about"`
	Deny  struct {
		Patterns []string `json:"patterns"`
		Cases    struct {
			Denied  []string `json:"denied"`
			Allowed []string `json:"allowed"`
		} `json:"cases"`
	} `json:"deny"`
	MirrorBuildArgs struct {
		About string   `json:"about"`
		NPM   []string `json:"npm"`
		PyPI  []string `json:"pypi"`
		Go    []string `json:"go"`
	} `json:"mirrorBuildArgs"`
	Recommended struct {
		Version int                `json:"version"`
		Entries []RecommendedEntry `json:"entries"`
	} `json:"recommended"`
}

var (
	lists     = mustLists(listsJSON)
	kodusDeny = mustDenyRegexp(lists.Deny.Patterns)
)

func mustLists(b []byte) listsFile {
	var f listsFile
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		panic(fmt.Sprintf("netguard: egress-lists.json: %v", err))
	}
	if len(f.Deny.Patterns) == 0 || f.Recommended.Version < 1 {
		panic("netguard: egress-lists.json has no deny patterns or no recommended version")
	}
	return f
}

// patternSource is the expression a deny pattern stands for: "*" is one or
// more host characters, dots included, as matchesEgressPattern in
// libs/runtime/protocol/egress-catalog.ts.
func patternSource(p string) string {
	p = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(p)), ".")
	parts := strings.Split(p, "*")
	for i, part := range parts {
		parts[i] = regexp.QuoteMeta(part)
	}
	return strings.Join(parts, `[a-z0-9_-]+(?:\.[a-z0-9_-]+)*`)
}

func mustDenyRegexp(patterns []string) *regexp.Regexp {
	alts := make([]string, 0, len(patterns))
	for _, p := range patterns {
		if strings.TrimSpace(p) == "" {
			continue
		}
		alts = append(alts, "(?:"+patternSource(p)+")")
	}
	return regexp.MustCompile("^(?:" + strings.Join(alts, "|") + ")$")
}

// MatchesPattern reports whether the normalized host matches one deny
// pattern.
func MatchesPattern(host, pattern string) bool {
	return regexp.MustCompile("^" + patternSource(pattern) + "$").MatchString(host)
}

// RecommendedVersion is the version of the recommended list this cell was
// built with.
func RecommendedVersion() int { return lists.Recommended.Version }

// Recommended is the Kodus recommended list this cell was built with, a
// copy the caller may keep.
func Recommended() []RecommendedEntry {
	out := make([]RecommendedEntry, len(lists.Recommended.Entries))
	copy(out, lists.Recommended.Entries)
	for i := range out {
		out[i].Paths = slices.Clone(out[i].Paths)
		out[i].ExceptPaths = slices.Clone(out[i].ExceptPaths)
	}
	return out
}

// RecommendedInspectRules are the recommended list as the inspected tier's
// rules. A mirror-tier host is inspected too until the cell's mirror serves
// its ecosystem to the claim (the machines still reach it by name): either
// way a read is the only request that leaves.
func RecommendedInspectRules() []policy.InspectRule {
	out := make([]policy.InspectRule, 0, len(lists.Recommended.Entries))
	for i := range lists.Recommended.Entries {
		e := &lists.Recommended.Entries[i]
		out = append(out, policy.InspectRule{Host: e.Host, Paths: slices.Clone(e.Paths), ExceptPaths: slices.Clone(e.ExceptPaths), RefuseUntrusted: e.Untrusted == "refuse"})
	}
	return out
}

// RecommendedBuildPassthrough are the recommended hosts an image build
// reaches uninspected: read-only CDNs with no write API.
func RecommendedBuildPassthrough() []string {
	var out []string
	for i := range lists.Recommended.Entries {
		if lists.Recommended.Entries[i].Build == "passthrough" {
			out = append(out, lists.Recommended.Entries[i].Host)
		}
	}
	return out
}

// MirrorBuildArgNames are the build args the cell passes every image build
// with its mirror, by ecosystem: the names Kody's recipe author declares in
// the Dockerfiles it writes (MIRROR_BUILD_ARGS in egress-catalog.ts).
func MirrorBuildArgNames() (npm, pypi, goproxy []string) {
	a := lists.MirrorBuildArgs
	return slices.Clone(a.NPM), slices.Clone(a.PyPI), slices.Clone(a.Go)
}
