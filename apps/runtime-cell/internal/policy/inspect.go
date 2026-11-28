package policy

import (
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
)

// InspectRule is one host of the inspected tier (docs/runtime/egress-allowlist.md
// §6): the cell reads the request itself (the injector over TLS, the proxy
// over plain HTTP), and only a GET or HEAD with no body, under one of Paths
// and none of ExceptPaths, goes out. A registry reached this way is read
// only: npm publish, twine upload and a docker push are writes (S-53, S-56).
type InspectRule struct {
	Host string `json:"host"`
	// Paths are prefixes of the request path; "*" is one path segment.
	Paths []string `json:"paths"`
	// ExceptPaths are refused under Paths (npm's /-/ account and token routes).
	ExceptPaths []string `json:"exceptPaths,omitempty"`
	// GitFetch also lets a git fetch through (its POST to git-upload-pack);
	// a push (git-receive-pack) is refused everywhere (G8, S-57).
	GitFetch bool `json:"gitFetch,omitempty"`
	// RefuseUntrusted: TLS to the host from a source that is not an inspect
	// source (the image builder) is refused instead of going out as SNI
	// passthrough: the host takes writes and only inspection keeps them out.
	RefuseUntrusted bool `json:"refuseUntrusted,omitempty"`
}

// MaxInspectedURI caps an inspected request's path and query: a GET can
// still carry data out in its URL, so it carries little.
const MaxInspectedURI = 4096

// Refusal reasons of the inspected tier, as egress.blocked and the
// injector's logs name them.
const (
	InspectMethod = "inspect_method"
	InspectPath   = "inspect_path"
	InspectBody   = "inspect_body"
	InspectURI    = "inspect_uri"
	InspectPush   = "inspect_git_push"
)

// Permits decides one request: "" lets it go out, else the reason it is
// refused. contentLength is the request's declared length (-1 unknown, a
// chunked body); a body is refused except on a git fetch.
func (r InspectRule) Permits(method string, u *url.URL, contentLength int64) string {
	// An opaque URL or an empty path names no path the prefix check can
	// read: "https:@evil.example/-/whoami" has Path "", and reading that as
	// "/" let it past ExceptPaths. Refused, never defaulted.
	if u == nil || u.Opaque != "" || u.Path == "" {
		return InspectPath
	}
	if len(u.RequestURI()) > MaxInspectedURI {
		return InspectURI
	}
	p := u.Path
	// A dot segment or a doubled slash makes the prefix check say one path
	// and the server serve another.
	if !strings.HasPrefix(p, "/") || strings.Contains(p, "//") || hasDotSegment(p) || strings.ContainsRune(p, '\\') {
		return InspectPath
	}
	if isGitPush(p, u.RawQuery) {
		return InspectPush
	}
	if r.GitFetch && isGitFetch(method, p, u.RawQuery) {
		return ""
	}
	if method != http.MethodGet && method != http.MethodHead {
		return InspectMethod
	}
	if contentLength != 0 {
		return InspectBody
	}
	for _, x := range r.ExceptPaths {
		if pathUnder(p, x) {
			return InspectPath
		}
	}
	for _, x := range r.Paths {
		if pathUnder(p, x) {
			return ""
		}
	}
	return InspectPath
}

// hasDotSegment: u.Path is decoded, so %2e%2e is caught here too.
func hasDotSegment(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == "." || seg == ".." {
			return true
		}
	}
	return false
}

// pathUnder reports whether p starts with prefix, where a "*" segment of the
// prefix stands for one segment of p. A prefix that ends inside a segment
// ("/xlsx-") matches the segment's start.
func pathUnder(p, prefix string) bool {
	if !strings.Contains(prefix, "*") {
		return strings.HasPrefix(p, prefix)
	}
	ps, xs := strings.Split(p, "/"), strings.Split(prefix, "/")
	if len(ps) < len(xs) {
		return false
	}
	for i, x := range xs {
		last := i == len(xs)-1
		switch {
		case x == "*":
			if ps[i] == "" {
				return false
			}
		case last:
			if !strings.HasPrefix(ps[i], x) {
				return false
			}
		case ps[i] != x:
			return false
		}
	}
	return true
}

// isGitFetch is the smart HTTP fetch: the ref advertisement of upload-pack
// and its POST.
func isGitFetch(method, p, query string) bool {
	switch method {
	case http.MethodGet:
		return strings.HasSuffix(p, "/info/refs") && query == "service=git-upload-pack"
	case http.MethodPost:
		return strings.HasSuffix(p, "/git-upload-pack")
	}
	return false
}

func isGitPush(p, query string) bool {
	return strings.HasSuffix(p, "/git-receive-pack") || strings.Contains(query, "git-receive-pack")
}

// Inspects reports the inspected rule of the host, if it has one.
func (p ClaimPolicy) Inspects(host string) (InspectRule, bool) {
	for _, r := range p.Inspected {
		if r.Host == host {
			return r, true
		}
	}
	return InspectRule{}, false
}

// InspectsFrom reports whether a TLS connection from source to host goes
// through the injector for inspection: the host has a rule and the source's
// machine trusts the cell CA (InspectSources). A trusted builder's
// passthrough hosts (read-only CDNs, full access) still go straight: a tool
// that ignores the trust variables (apt over HTTPS) reaches them as before,
// and a layer or a wheel is not cut at the injector's response bound. Plain
// HTTP is inspected from every source; the proxy reads it itself.
func (p ClaimPolicy) InspectsFrom(host, source string) bool {
	if _, ok := p.Inspects(host); !ok || !slices.Contains(p.InspectSources, source) {
		return false
	}
	return !p.FromBuild(source) || !slices.Contains(p.BuildPassthrough, host)
}

// withInspected keeps the candidate rules whose host is on the final
// allowlist (a denied or absent host has none), normalized and sorted, and
// the inspect sources that are the claim's.
func withInspected(p *ClaimPolicy, rules []InspectRule, sources []string) error {
	seen := map[string]bool{}
	for _, r := range rules {
		n, err := NormalizeHost(r.Host)
		if err != nil || strings.Contains(r.Host, "*") {
			return fmt.Errorf("policy: inspected host %q is not an exact host", r.Host)
		}
		if !p.Allows(n) || seen[n] {
			continue
		}
		seen[n] = true
		r.Host = n
		r.Paths = slices.Clone(r.Paths)
		r.ExceptPaths = slices.Clone(r.ExceptPaths)
		p.Inspected = append(p.Inspected, r)
	}
	slices.SortFunc(p.Inspected, func(a, b InspectRule) int { return strings.Compare(a.Host, b.Host) })
	if len(p.Inspected) == 0 {
		return nil
	}
	for _, s := range sources {
		if slices.Contains(p.Sources, s) && !slices.Contains(p.InspectSources, s) {
			p.InspectSources = append(p.InspectSources, s)
		}
	}
	slices.Sort(p.InspectSources)
	return nil
}

func (p ClaimPolicy) validateInspected() error {
	seen := map[string]bool{}
	for _, r := range p.Inspected {
		if !p.Allows(r.Host) || seen[r.Host] {
			return fmt.Errorf("policy: inspected host %q is not on the allowlist or repeated", r.Host)
		}
		seen[r.Host] = true
		if len(r.Paths) == 0 && !r.GitFetch {
			return fmt.Errorf("policy: inspected host %q has no path", r.Host)
		}
		for _, x := range append(slices.Clone(r.Paths), r.ExceptPaths...) {
			if !strings.HasPrefix(x, "/") {
				return fmt.Errorf("policy: inspected host %q path %q does not start with /", r.Host, x)
			}
		}
	}
	for _, s := range p.InspectSources {
		if !slices.Contains(p.Sources, s) {
			return fmt.Errorf("policy: inspect source %q is not a source of the claim", s)
		}
	}
	return nil
}
