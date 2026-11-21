package policy

import (
	"net/url"
	"slices"
	"testing"
	"time"
)

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// S-56 Inspected tier, the rule itself: POST, PUT, a path outside the
// prefix and a body are refused; the allowed GET goes out.
func TestS56InspectRulePermitsOnlyReadsUnderItsPaths(t *testing.T) {
	sheet := InspectRule{Host: "cdn.sheetjs.com", Paths: []string{"/xlsx-"}}
	npm := InspectRule{Host: "registry.npmjs.org", Paths: []string{"/"}, ExceptPaths: []string{"/-/"}}
	gh := InspectRule{Host: "github.com", Paths: []string{"/*/*/releases/download/", "/*/*/archive/"}}
	cases := []struct {
		rule   InspectRule
		method string
		url    string
		length int64
		want   string
	}{
		{sheet, "GET", "/xlsx-0.20.3/xlsx-0.20.3.tgz", 0, ""},
		{sheet, "HEAD", "/xlsx-0.20.3/xlsx-0.20.3.tgz", 0, ""},
		{sheet, "POST", "/xlsx-0.20.3/xlsx-0.20.3.tgz", 10, InspectMethod},
		{sheet, "PUT", "/xlsx-0.20.3/x.tgz", 10, InspectMethod},
		{sheet, "GET", "/other/file", 0, InspectPath},
		{sheet, "GET", "/xlsx-0.20.3/../../secret", 0, InspectPath},
		{sheet, "GET", "/xlsx-0.20.3/%2e%2e/%2e%2e/secret", 0, InspectPath},
		{sheet, "GET", "//xlsx-0.20.3", 0, InspectPath},
		{sheet, "GET", "/xlsx-0.20.3/x.tgz", 5, InspectBody},
		{sheet, "GET", "/xlsx-0.20.3/x.tgz", -1, InspectBody},
		// S-53 on the rule: npm publish is a PUT of the package document.
		{npm, "PUT", "/left-pad", 2048, InspectMethod},
		{npm, "GET", "/left-pad", 0, ""},
		{npm, "GET", "/@scope%2fpkg", 0, ""},
		{npm, "GET", "/left-pad/-/left-pad-1.3.0.tgz", 0, ""},
		{npm, "GET", "/-/npm/v1/tokens", 0, InspectPath},
		{npm, "GET", "/%2d/whoami", 0, InspectPath},
		{gh, "GET", "/owner/repo/releases/download/v1/tool.tar.gz", 0, ""},
		{gh, "GET", "/owner/repo/archive/refs/tags/v1.tar.gz", 0, ""},
		{gh, "GET", "/owner/repo.git/info/refs?service=git-upload-pack", 0, InspectPath},
		{gh, "GET", "/owner/repo/issues", 0, InspectPath},
		{gh, "GET", "//repo/releases/download/x", 0, InspectPath},
	}
	for _, c := range cases {
		if got := c.rule.Permits(c.method, mustURL(t, c.url), c.length); got != c.want {
			t.Errorf("%s %s %s (body %d): %q, want %q", c.rule.Host, c.method, c.url, c.length, got, c.want)
		}
	}
	long := "/xlsx-" + string(make([]byte, MaxInspectedURI))
	if got := sheet.Permits("GET", &url.URL{Path: long}, 0); got != InspectURI {
		t.Errorf("a long URL: %q", got)
	}
}

// An opaque URL ("https:@evil.example/-/whoami") or one with no path says
// nothing about the path the server serves: it is refused, never read as "/"
// (finding 1 of the 2026-11-14 review: that got past ExceptPaths).
func TestInspectRuleRefusesAnEmptyOrOpaquePath(t *testing.T) {
	npm := InspectRule{Host: "registry.npmjs.org", Paths: []string{"/"}, ExceptPaths: []string{"/-/"}}
	for _, u := range []*url.URL{
		{},
		{Scheme: "https", Host: "registry.npmjs.org"},
		mustURL(t, "https:@evil.example/-/whoami"),
		{Opaque: "/-/whoami"},
	} {
		if got := npm.Permits("GET", u, 0); got != InspectPath {
			t.Errorf("%q: %q, want %q", u.String(), got, InspectPath)
		}
	}
}

// S-57 Git as a channel, the rule: a fetch goes out, a push never does.
func TestS57GitFetchRuleRefusesPush(t *testing.T) {
	git := InspectRule{Host: "github.com", GitFetch: true}
	for _, c := range []struct{ method, url, want string }{
		{"GET", "/org/repo.git/info/refs?service=git-upload-pack", ""},
		{"POST", "/org/repo.git/git-upload-pack", ""},
		{"GET", "/org/repo.git/info/refs?service=git-receive-pack", InspectPush},
		{"POST", "/attacker/drop.git/git-receive-pack", InspectPush},
		{"POST", "/org/repo/issues", InspectMethod},
	} {
		length := int64(0)
		if c.method == "POST" {
			length = 100
		}
		if got := git.Permits(c.method, mustURL(t, c.url), length); got != c.want {
			t.Errorf("%s %s: %q, want %q", c.method, c.url, got, c.want)
		}
	}
}

func TestBuildSignsOnlyTheInspectedHostsOnTheAllowlist(t *testing.T) {
	now := time.Now()
	spec := Spec{
		ClaimID: "c", OrgID: "o", Phase: PhaseBuild, Sources: []string{"10.0.0.2", "10.0.0.9"},
		Base:           []string{"cdn.sheetjs.com", "registry.npmjs.org"},
		Inspect:        []InspectRule{{Host: "cdn.sheetjs.com", Paths: []string{"/xlsx-"}}, {Host: "pypi.org", Paths: []string{"/simple/"}}, {Host: "registry.npmjs.org", Paths: []string{"/"}}},
		InspectSources: []string{"10.0.0.2", "10.9.9.9"},
		ExpiresAt:      now.Add(time.Hour), IssuedAt: now,
	}
	p, _, err := Build(spec, func(h string) bool { return h == "registry.npmjs.org" })
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Inspected) != 1 || p.Inspected[0].Host != "cdn.sheetjs.com" {
		t.Fatalf("inspected %+v: only an allowed, not denied host keeps its rule", p.Inspected)
	}
	if len(p.InspectSources) != 1 || p.InspectSources[0] != "10.0.0.2" {
		t.Fatalf("inspect sources %v: only the claim's own", p.InspectSources)
	}
	if !p.InspectsFrom("cdn.sheetjs.com", "10.0.0.2") || p.InspectsFrom("cdn.sheetjs.com", "10.0.0.9") {
		t.Fatal("the builder's source is inspected, or the machine's is not")
	}
	// A policy without the tier is the bytes an older cell signed.
	spec.Inspect, spec.InspectSources = nil, nil
	q, _, err := Build(spec, nil)
	if err != nil {
		t.Fatal(err)
	}
	if q.Inspected != nil || q.InspectSources != nil {
		t.Fatal("empty tier serialized")
	}
}

func TestBuildSignsTheBuilderAndOnlyItsAllowedPassthroughHosts(t *testing.T) {
	now := time.Now()
	p, _, err := Build(Spec{
		ClaimID: "c", OrgID: "o", Phase: PhaseBuild, Sources: []string{"10.0.0.2", "10.0.0.250"},
		Base:         []string{"cdn.sheetjs.com", "registry.npmjs.org"},
		BuildSources: []string{"10.0.0.250", "10.9.9.9"}, BuildPassthrough: []string{"cdn.sheetjs.com", "absent.example"},
		ExpiresAt: now.Add(time.Hour), IssuedAt: now,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.BuildSources) != 1 || p.BuildSources[0] != "10.0.0.250" || len(p.BuildPassthrough) != 1 || p.BuildPassthrough[0] != "cdn.sheetjs.com" {
		t.Fatalf("build %v %v", p.BuildSources, p.BuildPassthrough)
	}
	if p.BuildRefuses("10.0.0.250", "registry.npmjs.org", true) != BuildNeedsInspection || p.BuildRefuses("10.0.0.250", "cdn.sheetjs.com", true) != "" || p.BuildRefuses("10.0.0.2", "registry.npmjs.org", true) != "" {
		t.Fatal("the build rule")
	}
	if len(p.InspectSources) != 0 {
		t.Fatalf("an untrusted builder signed as an inspect source: %v", p.InspectSources)
	}
}

// A builder whose RUN steps trust the cell CA (BuildTrusted) is an inspect
// source, with or without an inspected host: over TLS it reaches an inspected
// registry and a secret's host (both through the injector), its passthrough
// hosts straight, and still nothing else. It used to be refused every TLS
// host but its passthrough ones, a registry and a secret's host included.
func TestATrustedBuilderReachesInspectedAndSecretHostsThroughTheInjector(t *testing.T) {
	now := time.Now()
	builder := "10.0.0.250"
	p, _, err := Build(Spec{
		ClaimID: "c", OrgID: "o", Phase: PhaseBuild, Sources: []string{"10.0.0.2", builder},
		Base:           []string{"deb.debian.org", "registry.npmjs.org", "operator.example"},
		Inspect:        []InspectRule{{Host: "deb.debian.org", Paths: []string{"/"}}, {Host: "registry.npmjs.org", Paths: []string{"/"}, ExceptPaths: []string{"/-/"}}},
		Secrets:        []Secret{{ID: "npm", Placeholder: placeholder(t), Hosts: []string{"npm.corp.example"}}},
		InspectSources: []string{"10.0.0.2"},
		BuildSources:   []string{builder}, BuildPassthrough: []string{"deb.debian.org"}, BuildTrusted: true,
		ExpiresAt: now.Add(time.Hour), IssuedAt: now,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(p.InspectSources, builder) || !p.FromBuild(builder) {
		t.Fatalf("inspect %v build %v", p.InspectSources, p.BuildSources)
	}
	for _, h := range []string{"registry.npmjs.org", "npm.corp.example", "deb.debian.org"} {
		if why := p.BuildRefuses(builder, h, true); why != "" {
			t.Errorf("%s refused to the trusted builder: %s", h, why)
		}
	}
	if !p.InspectsFrom("registry.npmjs.org", builder) {
		t.Error("the registry is not inspected from the trusted builder")
	}
	if p.InspectsFrom("deb.debian.org", builder) || !p.InspectsFrom("deb.debian.org", "10.0.0.2") {
		t.Error("a build passthrough host is inspected from the builder, or not from a machine")
	}
	if p.BuildRefuses(builder, "operator.example", true) != BuildNeedsInspection {
		t.Error("an allowed host with no inspected rule went out uninspected from the build")
	}

	// Without an inspected host the trusted builder still reaches a secret's.
	q, _, err := Build(Spec{
		ClaimID: "c", OrgID: "o", Phase: PhaseBuild, Sources: []string{builder},
		Secrets:      []Secret{{ID: "npm", Placeholder: placeholder(t), Hosts: []string{"npm.corp.example"}}},
		BuildSources: []string{builder}, BuildTrusted: true,
		ExpiresAt: now.Add(time.Hour), IssuedAt: now,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if q.BuildRefuses(builder, "npm.corp.example", true) != "" {
		t.Fatalf("the secret's host refused to the trusted builder: %v", q.InspectSources)
	}
}
