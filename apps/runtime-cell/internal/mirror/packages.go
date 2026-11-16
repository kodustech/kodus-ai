package mirror

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// PackageProxy is the read-only pull-through of a public package registry
// (npm under /npm/, PyPI under /pypi/; docs/runtime/egress-allowlist.md §6,
// D9): a GET or HEAD of an index or a file goes to the ecosystem's fixed
// upstream, and the index comes back with its file URLs pointing at the
// mirror, so the machine never names the upstream. Nothing else is served:
// a publish, a login, a search or a token route is refused before anything
// leaves, and so is a request that carries a credential, so a private
// package never enters the mirror and nothing it serves belongs to one org.
//
// A package is fetched by name, not by the lockfile: what a claim downloads
// is checked by its client against the lockfile's integrity.
type PackageProxy struct {
	// Ecosystem names the routes: "npm" or "pypi".
	Ecosystem string
	// Index is where index documents come from (https://registry.npmjs.org,
	// https://pypi.org); Files where package files do when the index names
	// another host (https://files.pythonhosted.org), nil: Index.
	Index, Files *url.URL
	// Public is the mirror's own base URL as the machines reach it
	// (http://mirror.cell.internal:8080): file URLs in an index are
	// rewritten under it.
	Public *url.URL
	// Allowed decides whether the request's source is a claim of this cell;
	// nil refuses everything.
	Allowed func(r *http.Request) bool
	// Client fetches the upstream; nil: one that follows no redirect.
	Client *http.Client
	// MaxBytes bounds one response (default 512 MiB).
	MaxBytes int64
}

const defaultPackageMax = 512 << 20

// NewNPM is the npm mirror under /npm/.
func NewNPM(registry, public *url.URL, allowed func(*http.Request) bool) *PackageProxy {
	return &PackageProxy{Ecosystem: "npm", Index: registry, Public: public, Allowed: allowed}
}

// NewPyPI is the PyPI mirror under /pypi/: the simple index of pypi.org and
// the files of files.pythonhosted.org.
func NewPyPI(index, files, public *url.URL, allowed func(*http.Request) bool) *PackageProxy {
	return &PackageProxy{Ecosystem: "pypi", Index: index, Files: files, Public: public, Allowed: allowed}
}

// errNotServed is a path this mirror does not serve.
var errNotServed = errors.New("mirror: not a path this mirror serves")

func (p *PackageProxy) client() *http.Client {
	if p.Client != nil {
		return p.Client
	}
	return &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (p *PackageProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "the mirror is read only: a publish goes nowhere from a claim", http.StatusMethodNotAllowed)
		return
	}
	if r.Header.Get("Authorization") != "" || r.Header.Get("Npm-Otp") != "" {
		http.Error(w, "the mirror serves public packages only; a private registry is an org secret with its host (Settings, Secrets)", http.StatusUnauthorized)
		return
	}
	if p.Allowed == nil || !p.Allowed(r) {
		http.Error(w, "not a claim of this cell", http.StatusForbidden)
		return
	}
	base, path, index, err := p.route(r.URL)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	p.fetch(w, r, base, path, index)
}

// route maps a mirror path to its upstream: the base, the upstream path (as
// escaped on the wire) and whether the answer is an index to rewrite.
func (p *PackageProxy) route(u *url.URL) (*url.URL, string, bool, error) {
	raw := u.EscapedPath()
	if u.RawQuery != "" || strings.Contains(raw, "//") || strings.ContainsAny(u.Path, "\\") || hasDot(u.Path) {
		return nil, "", false, errNotServed
	}
	switch p.Ecosystem {
	case "npm":
		rest, ok := strings.CutPrefix(raw, "/npm/")
		if !ok || rest == "" || strings.HasPrefix(rest, "-/") || strings.HasPrefix(rest, "%2d/") || strings.HasPrefix(rest, "%2D/") {
			return nil, "", false, errNotServed
		}
		// <name>, @scope%2f<name> or @scope/<name>: the document; and
		// <name>/-/<file>.tgz: the tarball.
		if i := strings.Index(rest, "/-/"); i > 0 {
			if !strings.HasSuffix(rest, ".tgz") || strings.Count(rest[i+3:], "/") != 0 {
				return nil, "", false, errNotServed
			}
			return p.Index, rest, false, nil
		}
		if strings.Count(rest, "/") > 1 || strings.Contains(rest, "/") && !strings.HasPrefix(rest, "@") {
			return nil, "", false, errNotServed
		}
		return p.Index, rest, true, nil
	case "pypi":
		if rest, ok := strings.CutPrefix(raw, "/pypi/simple/"); ok {
			if rest == "" || strings.Count(strings.TrimSuffix(rest, "/"), "/") != 0 {
				return nil, "", false, errNotServed
			}
			return p.Index, "simple/" + rest, true, nil
		}
		if rest, ok := strings.CutPrefix(raw, "/pypi/files/packages/"); ok && rest != "" {
			return p.filesBase(), "packages/" + rest, false, nil
		}
	}
	return nil, "", false, errNotServed
}

func (p *PackageProxy) filesBase() *url.URL {
	if p.Files != nil {
		return p.Files
	}
	return p.Index
}

func hasDot(path string) bool {
	for _, seg := range strings.Split(path, "/") {
		if seg == "." || seg == ".." {
			return true
		}
	}
	return false
}

// rewrites are the upstream file URL prefixes an index names and what the
// machine gets instead.
func (p *PackageProxy) rewrites() [][2]string {
	pub := strings.TrimSuffix(p.Public.String(), "/")
	switch p.Ecosystem {
	case "npm":
		reg := strings.TrimSuffix(p.Index.String(), "/")
		return [][2]string{{`"tarball":"` + reg + `/`, `"tarball":"` + pub + `/npm/`}}
	case "pypi":
		files := strings.TrimSuffix(p.filesBase().String(), "/")
		return [][2]string{{files + "/packages/", pub + "/pypi/files/packages/"}}
	}
	return nil
}

func (p *PackageProxy) fetch(w http.ResponseWriter, r *http.Request, base *url.URL, path string, index bool) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	up := strings.TrimSuffix(base.String(), "/") + "/" + path
	req, err := http.NewRequestWithContext(ctx, r.Method, up, nil) //nolint:gosec // G704: base is the operator's upstream; only the path comes from the request, checked by route
	if err != nil {
		http.Error(w, "bad upstream request", http.StatusBadGateway)
		return
	}
	if a := r.Header.Get("Accept"); a != "" {
		req.Header.Set("Accept", a) // npm's abbreviated document, PEP 691's JSON
	}
	resp, err := p.client().Do(req) //nolint:gosec // G704: same operator upstream as above
	if err != nil {
		http.Error(w, "upstream unreachable: "+base.Host, http.StatusBadGateway)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		code := http.StatusBadGateway
		if resp.StatusCode == http.StatusNotFound {
			code = http.StatusNotFound
		}
		http.Error(w, fmt.Sprintf("upstream answered %d", resp.StatusCode), code)
		return
	}
	limit := p.MaxBytes
	if limit <= 0 {
		limit = defaultPackageMax
	}
	if resp.ContentLength > limit {
		http.Error(w, "file larger than the mirror serves", http.StatusBadGateway)
		return
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if !index {
		if resp.ContentLength >= 0 {
			w.Header().Set("Content-Length", fmt.Sprint(resp.ContentLength))
		}
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			_, _ = io.Copy(w, io.LimitReader(resp.Body, limit))
		}
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		http.Error(w, "index unreadable or larger than the mirror serves", http.StatusBadGateway)
		return
	}
	for _, rw := range p.rewrites() {
		body = bytes.ReplaceAll(body, []byte(rw[0]), []byte(rw[1]))
	}
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}
