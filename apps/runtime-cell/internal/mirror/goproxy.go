// Package mirror is the cell's registry mirror (docs §4, "Espelho de
// registry"): a read-only pull-through of public registries for the claims
// of this cell. The VM reaches only the mirror; the mirror alone reaches a
// fixed upstream per ecosystem, so a shared CDN (storage.googleapis.com
// behind the Go proxy) never enters a claim's allowlist. A claim gets only
// what its lockfile pins: a package fetched by name is a way out (a Go
// "module" named attacker.example/<data> makes the upstream proxy call the
// attacker), so nothing else is served.
package mirror

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// GoPins answers whether a claim's lockfile (go.sum) pins module at
// version; the request names the claim by its source address.
type GoPins func(r *http.Request, module, version string) bool

// GoProxy serves the GOPROXY protocol under /go/: only
// <module>/@v/<version>.{info,mod,zip} of a pinned module@version. List and
// latest queries are refused: a pinned build never needs them.
//
// It also proxies the Go checksum database under /go/sumdb/sum.golang.org/
// (the protocol's "proxying a checksum database"), so a build that verifies
// a module (go work sync, go mod download of a module new to a go.sum) keeps
// verifying it instead of failing on a host the sandbox does not reach: the
// lookup of a pinned module@version only, the tree's tiles and its latest
// signed head. Tiles are content-addressed numbers; nothing a claim names
// reaches the upstream but a pinned module@version.
type GoProxy struct {
	// Upstream is the Go module proxy (https://proxy.golang.org).
	Upstream *url.URL
	// SumDB is the checksum database (https://sum.golang.org); nil: the
	// checksum database is not proxied (the go command then reports it).
	SumDB *url.URL
	// Pins decides per claim; nil refuses everything.
	Pins GoPins
	// Client fetches the upstream; nil: a client whose redirects may only
	// go to the Go proxy's own bucket (AllowGoRedirect).
	Client *http.Client
	// MaxBytes bounds one file (a module zip is at most 500 MiB by the Go
	// proxy's own rule).
	MaxBytes int64
}

// GoProxyBucket is where proxy.golang.org redirects module zips; the only
// storage.googleapis.com path the mirror follows.
const GoProxyBucket = "/proxy-golang-org-prod/"

// AllowGoRedirect follows a redirect only to the Go proxy's bucket over
// HTTPS, at most twice.
func AllowGoRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 2 {
		return errors.New("mirror: too many redirects")
	}
	u := req.URL
	if u.Scheme != "https" || u.Host != "storage.googleapis.com" || !strings.HasPrefix(u.Path, GoProxyBucket) {
		return fmt.Errorf("mirror: redirect to %s refused", u.Redacted())
	}
	return nil
}

func (g *GoProxy) client() *http.Client {
	if g.Client != nil {
		return g.Client
	}
	return &http.Client{Timeout: 5 * time.Minute, CheckRedirect: AllowGoRedirect}
}

func (g *GoProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "the mirror is read only", http.StatusMethodNotAllowed)
		return
	}
	if rest, ok := strings.CutPrefix(r.URL.Path, sumDBPrefix); ok {
		g.serveSumDB(w, r, rest)
		return
	}
	escaped, file, ok := strings.Cut(strings.TrimPrefix(r.URL.Path, "/go/"), "/@v/")
	if !ok || !strings.HasPrefix(r.URL.Path, "/go/") || r.URL.RawQuery != "" {
		http.Error(w, "only <module>/@v/<version>.{info,mod,zip} is served", http.StatusNotFound)
		return
	}
	ext := ""
	for _, e := range []string{".info", ".mod", ".zip"} {
		if strings.HasSuffix(file, e) {
			ext = e
		}
	}
	module, merr := unescapeGo(escaped)
	version, verr := unescapeGo(strings.TrimSuffix(file, ext))
	if ext == "" || merr != nil || verr != nil || !validModule(module) || !validVersion(version) {
		http.Error(w, "not a module file this mirror serves", http.StatusNotFound)
		return
	}
	if g.Pins == nil || !g.Pins(r, module, version) {
		// 410: the go command stops here instead of trying another proxy.
		http.Error(w, fmt.Sprintf("%s@%s is not pinned by this claim's go.sum", module, version), http.StatusGone)
		return
	}
	g.fetch(w, r, escaped+"/@v/"+file)
}

// sumDBPrefix is where the go command asks a GOPROXY of …/go for sum.golang.org.
const sumDBPrefix = "/go/sumdb/sum.golang.org/"

// sumTile is a tile of the checksum database's tree (tile/<H>/<L>/<N>[.p/<W>],
// data tiles under tile/<H>/data/): numbers only.
var sumTile = regexp.MustCompile(`^tile/[0-9]{1,2}/(?:data|[0-9]{1,2})/(?:x[0-9]{3}/){0,6}[0-9]{3}(?:\.p/[0-9]{1,3})?$`)

func (g *GoProxy) serveSumDB(w http.ResponseWriter, r *http.Request, rest string) {
	if g.SumDB == nil || r.URL.RawQuery != "" {
		http.Error(w, "the checksum database is not proxied", http.StatusNotFound)
		return
	}
	switch {
	case rest == "supported":
		w.WriteHeader(http.StatusOK)
	case rest == "latest" || sumTile.MatchString(rest):
		g.fetchFrom(w, r, g.SumDB, rest)
	case strings.HasPrefix(rest, "lookup/"):
		escaped, escVersion, ok := strings.Cut(strings.TrimPrefix(rest, "lookup/"), "@")
		module, merr := unescapeGo(escaped)
		version, verr := unescapeGo(escVersion)
		if !ok || merr != nil || verr != nil || !validModule(module) || !validVersion(version) {
			http.Error(w, "not a lookup this mirror serves", http.StatusNotFound)
			return
		}
		if g.Pins == nil || !g.Pins(r, module, version) {
			http.Error(w, fmt.Sprintf("%s@%s is not pinned by this claim's go.sum", module, version), http.StatusGone)
			return
		}
		g.fetchFrom(w, r, g.SumDB, rest)
	default:
		http.Error(w, "not a checksum database path this mirror serves", http.StatusNotFound)
	}
}

func (g *GoProxy) fetch(w http.ResponseWriter, r *http.Request, path string) {
	g.fetchFrom(w, r, g.Upstream, path)
}

func (g *GoProxy) fetchFrom(w http.ResponseWriter, r *http.Request, base *url.URL, path string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	up := base.JoinPath(path)
	req, err := http.NewRequestWithContext(ctx, r.Method, up.String(), nil)
	if err != nil {
		http.Error(w, "bad upstream request", http.StatusBadGateway)
		return
	}
	resp, err := g.client().Do(req)
	if err != nil {
		http.Error(w, "upstream unreachable: "+base.Host, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// The upstream's own "not found" stays a not found for the go command.
		code := http.StatusBadGateway
		if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
			code = http.StatusGone
		}
		http.Error(w, fmt.Sprintf("upstream answered %d", resp.StatusCode), code)
		return
	}
	max := g.MaxBytes
	if max <= 0 {
		max = 500 << 20
	}
	if resp.ContentLength > max {
		http.Error(w, "file larger than the mirror serves", http.StatusBadGateway)
		return
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.Copy(w, io.LimitReader(resp.Body, max))
}

// unescapeGo undoes the module path escaping of the proxy protocol: "!x"
// is "X"; a bare upper-case letter is refused.
func unescapeGo(s string) (string, error) {
	var b strings.Builder
	bang := false
	for _, c := range s {
		switch {
		case bang:
			if c < 'a' || c > 'z' {
				return "", errors.New("bad escape")
			}
			b.WriteRune(c - 'a' + 'A')
			bang = false
		case c == '!':
			bang = true
		case c >= 'A' && c <= 'Z':
			return "", errors.New("unescaped upper case")
		default:
			b.WriteRune(c)
		}
	}
	if bang {
		return "", errors.New("trailing escape")
	}
	return b.String(), nil
}

func validModule(m string) bool {
	if m == "" || len(m) > 512 || strings.HasPrefix(m, "/") || strings.HasSuffix(m, "/") || strings.Contains(m, "//") {
		return false
	}
	for _, part := range strings.Split(m, "/") {
		if part == "." || part == ".." || strings.HasPrefix(part, ".") {
			return false
		}
	}
	for _, c := range m {
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-._~/", c)
		if !ok {
			return false
		}
	}
	host, _, _ := strings.Cut(m, "/")
	return strings.Contains(host, ".")
}

func validVersion(v string) bool {
	if !strings.HasPrefix(v, "v") || len(v) > 128 || strings.ContainsAny(v, "/\\") || strings.Contains(v, "..") {
		return false
	}
	for _, c := range v {
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-.+", c)
		if !ok {
			return false
		}
	}
	return true
}
