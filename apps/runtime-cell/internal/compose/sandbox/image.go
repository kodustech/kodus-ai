package sandbox

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"regexp"
	"strings"
)

// Every tenant of a docker-gvisor cell shares the host's Docker, which holds
// every org's images: the cell's own builds (kodus-build/), bakes
// (kodus-bake/) and shared bakes (kodus-shared/). A service the cell did not
// build may therefore name only an image of a registry: never one the host
// already holds by a name or an ID of its own.
//
// The rule (imageRefusal):
//   - an image ID (sha256:<hex>) or a bare hex string, which Docker resolves
//     as a prefix of any local image's ID, is refused;
//   - a repository whose first component is the cell's (kodus- or kodus/),
//     on any registry, is refused;
//   - a registry that is not a public name (localhost, an IP address, a
//     single label such as registry:5000) is refused: the host's daemon
//     would reach it, and a loopback registry is where the cell's own
//     transfers run;
//   - anything that does not read as an image reference is refused.
//
// Apply then gives every service pull_policy: never, so compose never pulls:
// the driver pulls each named image itself before compose runs (anonymously,
// within the cell's image bound), and VerifyCanonical checks both again.

var (
	// domainComponent and pathComponent are the distribution reference
	// grammar's (github.com/distribution/reference).
	domainComponent = `(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])`
	pathComponent   = `[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*`
	domainRE        = regexp.MustCompile(`^(` + domainComponent + `(?:\.` + domainComponent + `)*|\[[0-9a-fA-F:.]+\])(?::([0-9]{1,5}))?$`)
	pathRE          = regexp.MustCompile(`^` + pathComponent + `(?:/` + pathComponent + `)*$`)
	tagRE           = regexp.MustCompile(`^[\w][\w.-]{0,127}$`)
	digestRE        = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	bareHexRE       = regexp.MustCompile(`^(?i)(sha256:)?[0-9a-f]+$`)
)

// ImageRef is an image reference as the cell reads it: Domain is empty for
// Docker Hub's short form ("postgres:16").
type ImageRef struct {
	Domain, Path, Tag, Digest string
}

// ParseImageRef reads ref as the distribution reference grammar does:
// [domain[:port]/]path[:tag][@sha256:<hex>]. The first component is a
// domain when it holds a '.' or a ':', is "localhost", or holds an upper
// case letter, as Docker reads it.
func ParseImageRef(ref string) (ImageRef, error) {
	var r ImageRef
	if ref == "" || len(ref) > 255+128+72 || strings.TrimSpace(ref) != ref {
		return r, fmt.Errorf("%q is not an image reference", ref)
	}
	rest := ref
	if name, digest, ok := strings.Cut(rest, "@"); ok {
		if !digestRE.MatchString(digest) {
			return r, fmt.Errorf("%q: the digest is not sha256:<64 hex>", ref)
		}
		r.Digest, rest = digest, name
	}
	// The tag is after the last ':' that follows the last '/': a ':' before
	// it is a domain's port.
	if i := strings.LastIndex(rest, ":"); i > strings.LastIndex(rest, "/") {
		r.Tag, rest = rest[i+1:], rest[:i]
		if !tagRE.MatchString(r.Tag) {
			return r, fmt.Errorf("%q: the tag is not a tag", ref)
		}
	}
	if first, after, ok := strings.Cut(rest, "/"); ok && (strings.ContainsAny(first, ".:") || first == "localhost" || strings.ToLower(first) != first) {
		if !domainRE.MatchString(first) {
			return r, fmt.Errorf("%q: the registry is not a host name", ref)
		}
		r.Domain, rest = first, after
	}
	if !pathRE.MatchString(rest) || len(rest) > 255 {
		return r, fmt.Errorf("%q: the repository is not a repository name", ref)
	}
	r.Path = rest
	return r, nil
}

// dockerHub are the names Docker gives Docker Hub: an image under one of
// them is the image of the short form.
var dockerHub = map[string]bool{"": true, "docker.io": true, "index.docker.io": true, "registry-1.docker.io": true}

// imageRefusal says why a service the cell did not build may not run ref,
// or "" when it may.
func imageRefusal(ref string) string {
	if bareHexRE.MatchString(ref) {
		return "an image ID names whatever image this host holds; name a registry image"
	}
	r, err := ParseImageRef(ref)
	if err != nil {
		return err.Error()
	}
	first, _, _ := strings.Cut(r.Path, "/")
	if dockerHub[strings.ToLower(r.Domain)] {
		first = strings.TrimPrefix(r.Path, "library/")
		first, _, _ = strings.Cut(first, "/")
	}
	if first == "kodus" || strings.HasPrefix(first, "kodus-") {
		return "the kodus namespaces are the cell's own images"
	}
	if r.Domain != "" && !dockerHub[strings.ToLower(r.Domain)] {
		if reason := registryRefusal(r.Domain); reason != "" {
			return reason
		}
	}
	return ""
}

// registryRefusal refuses a registry the host's daemon must not reach for a
// compose file: localhost, an address, or a name of a single label.
func registryRefusal(domain string) string {
	host := domain
	if m := domainRE.FindStringSubmatch(domain); m != nil {
		host = m[1]
	}
	host = strings.Trim(host, "[]")
	if _, err := netip.ParseAddr(host); err == nil {
		return "a registry named by its address is refused; name a public registry"
	}
	lower := strings.ToLower(host)
	if lower == "localhost" || strings.HasSuffix(lower, ".localhost") || !strings.Contains(lower, ".") ||
		strings.HasSuffix(lower, ".local") || strings.HasSuffix(lower, ".internal") {
		return "a registry on the host's own network is refused; name a public registry"
	}
	return ""
}

// checkImage checks the image of a service the cell does not build.
func (c *checker) checkImage(name string, svc map[string]any) {
	path := "services." + name + ".image"
	ref, ok := svc["image"].(string)
	if !ok || ref == "" {
		c.add(path, "a service the cell does not build names a registry image")
		return
	}
	if reason := imageRefusal(ref); reason != "" {
		c.add(path, reason)
	}
}

// PullImages are the images compose will run that the cell did not build
// (Options.Built), in the order of the services, each once: what the driver
// pulls before compose runs, compose itself never pulling. canonical is
// the JSON VerifyCanonical accepted.
func PullImages(canonical []byte, o Options) ([]string, error) {
	var doc struct {
		Services map[string]map[string]any `json:"services"`
	}
	if err := json.Unmarshal(canonical, &doc); err != nil {
		return nil, fmt.Errorf("sandbox: compose config: %w", err)
	}
	services := doc.Services
	seen := map[string]bool{}
	var out []string
	for _, name := range sortedKeys(services) {
		if o.Built[name] != "" || sharedBuilt(services, o.Built)[name] != "" {
			continue
		}
		if ref, _ := services[name]["image"].(string); ref != "" && !seen[ref] {
			seen[ref] = true
			out = append(out, ref)
		}
	}
	return out, nil
}

// refKey reads an image reference the way compose compares them: a name
// with no tag or digest is its :latest.
func refKey(ref string) string {
	last := ref[strings.LastIndex(ref, "/")+1:]
	if strings.ContainsAny(last, ":@") {
		return ref
	}
	return ref + ":latest"
}

// sharedBuilt finds the image-only services that run an image another
// service of the same project builds: their image is that service's image:
// (the raw file) or the tag the cell built it as (the canonical config).
// It returns each by service with the cell's tag. They are satisfied by
// that build, compose starting them after it, so the cell never pulls them
// and the checks treat their image as the cell's own, not an external one.
func sharedBuilt(services map[string]map[string]any, built map[string]string) map[string]string {
	byRef := map[string]string{}
	for name, tag := range built {
		if tag == "" {
			continue
		}
		byRef[refKey(tag)] = tag
		if ref, _ := services[name]["image"].(string); ref != "" {
			byRef[refKey(ref)] = tag
		}
	}
	out := map[string]string{}
	for name, svc := range services {
		if built[name] != "" || svc["build"] != nil {
			continue
		}
		if ref, _ := svc["image"].(string); ref != "" && byRef[refKey(ref)] != "" {
			out[name] = byRef[refKey(ref)]
		}
	}
	return out
}

// anyServices reads a decoded services mapping as service maps.
func anyServices(v any) map[string]map[string]any {
	out := map[string]map[string]any{}
	m, _ := v.(map[string]any)
	for name, s := range m {
		if sm, ok := s.(map[string]any); ok {
			out[name] = sm
		}
	}
	return out
}
