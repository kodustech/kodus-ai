package mirror

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

type pkgRig struct {
	mirror   *httptest.Server
	upstream atomic.Int32
	paths    chan string
}

func newPkgRig(t *testing.T, ecosystem string) *pkgRig {
	t.Helper()
	r := &pkgRig{paths: make(chan string, 16)}
	var upURL string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.upstream.Add(1)
		r.paths <- req.Method + " " + req.URL.EscapedPath()
		switch {
		case strings.HasSuffix(req.URL.Path, ".tgz"), strings.HasPrefix(req.URL.Path, "/packages/"):
			_, _ = io.WriteString(w, "file-bytes")
		case strings.HasPrefix(req.URL.Path, "/simple/"):
			_, _ = io.WriteString(w, `<a href="`+upURL+`/packages/ab/cd/pkg-1.0.tar.gz#sha256=00">pkg-1.0.tar.gz</a>`)
		default:
			_, _ = io.WriteString(w, `{"name":"pkg","versions":{"1.0.0":{"dist":{"tarball":"`+upURL+`/pkg/-/pkg-1.0.0.tgz","integrity":"sha512-x"}}}}`)
		}
	}))
	t.Cleanup(up.Close)
	upURL = up.URL
	upstream, _ := url.Parse(up.URL)
	public, _ := url.Parse("http://mirror.cell.internal:8080")
	allowed := func(*http.Request) bool { return true }
	var p *PackageProxy
	if ecosystem == "npm" {
		p = NewNPM(upstream, public, allowed)
	} else {
		p = NewPyPI(upstream, upstream, public, allowed)
	}
	r.mirror = httptest.NewServer(p)
	t.Cleanup(r.mirror.Close)
	return r
}

func (r *pkgRig) do(t *testing.T, method, path string, header ...string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, r.mirror.URL+path, strings.NewReader(""))
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestNPMMirrorServesTheDocumentWithTarballsOnTheMirror(t *testing.T) {
	r := newPkgRig(t, "npm")
	code, body := r.do(t, http.MethodGet, "/npm/pkg")
	if code != http.StatusOK || !strings.Contains(body, `"tarball":"http://mirror.cell.internal:8080/npm/pkg/-/pkg-1.0.0.tgz"`) {
		t.Fatalf("%d %s", code, body)
	}
	if got := <-r.paths; got != "GET /pkg" {
		t.Fatalf("upstream got %q", got)
	}
	if code, body := r.do(t, http.MethodGet, "/npm/pkg/-/pkg-1.0.0.tgz"); code != http.StatusOK || body != "file-bytes" {
		t.Fatalf("tarball %d %q", code, body)
	}
	<-r.paths
	if code, _ := r.do(t, http.MethodGet, "/npm/@scope%2fpkg"); code != http.StatusOK {
		t.Fatalf("scoped %d", code)
	}
	if got := <-r.paths; got != "GET /@scope%2fpkg" {
		t.Fatalf("scoped upstream path %q", got)
	}
	if code, _ := r.do(t, http.MethodGet, "/npm/@scope/pkg/-/pkg-1.0.0.tgz"); code != http.StatusOK {
		t.Fatalf("scoped tarball %d", code)
	}
}

// S-53 at the mirror: a publish, a login, a token or search route, and a
// request carrying a credential never reach the upstream.
func TestS53NPMMirrorIsReadOnlyAndPublicOnly(t *testing.T) {
	r := newPkgRig(t, "npm")
	for _, c := range []struct {
		method, path string
		header       []string
		want         int
	}{
		{http.MethodPut, "/npm/pkg", nil, http.StatusMethodNotAllowed},
		{http.MethodPost, "/npm/-/npm/v1/security/advisories/bulk", nil, http.StatusMethodNotAllowed},
		{http.MethodDelete, "/npm/pkg/-rev/1", nil, http.StatusMethodNotAllowed},
		{http.MethodGet, "/npm/-/whoami", nil, http.StatusNotFound},
		{http.MethodGet, "/npm/-/npm/v1/tokens", nil, http.StatusNotFound},
		{http.MethodGet, "/npm/%2d/whoami", nil, http.StatusNotFound},
		{http.MethodGet, "/npm/-/v1/search?text=x", nil, http.StatusNotFound},
		{http.MethodGet, "/npm/pkg/../-/whoami", nil, http.StatusNotFound},
		{http.MethodGet, "/npm/pkg/other/path", nil, http.StatusNotFound},
		{http.MethodGet, "/npm/pkg", []string{"Authorization", "Bearer npm_x"}, http.StatusUnauthorized},
	} {
		if code, _ := r.do(t, c.method, c.path, c.header...); code != c.want {
			t.Errorf("%s %s: %d, want %d", c.method, c.path, code, c.want)
		}
	}
	if n := r.upstream.Load(); n != 0 {
		t.Fatalf("%d refused requests reached the upstream", n)
	}
}

func TestPyPIMirrorServesTheSimpleIndexWithFilesOnTheMirror(t *testing.T) {
	r := newPkgRig(t, "pypi")
	code, body := r.do(t, http.MethodGet, "/pypi/simple/pkg/")
	if code != http.StatusOK || !strings.Contains(body, `href="http://mirror.cell.internal:8080/pypi/files/packages/ab/cd/pkg-1.0.tar.gz#sha256=00"`) {
		t.Fatalf("%d %s", code, body)
	}
	<-r.paths
	if code, body := r.do(t, http.MethodGet, "/pypi/files/packages/ab/cd/pkg-1.0.tar.gz"); code != http.StatusOK || body != "file-bytes" {
		t.Fatalf("file %d %q", code, body)
	}
	if got := <-r.paths; got != "GET /packages/ab/cd/pkg-1.0.tar.gz" {
		t.Fatalf("upstream got %q", got)
	}
	for _, c := range []struct{ method, path string }{
		{http.MethodPost, "/pypi/legacy/"}, // twine upload
		{http.MethodGet, "/pypi/legacy/"},
		{http.MethodGet, "/pypi/simple/pkg/../../admin"},
		{http.MethodGet, "/pypi/simple/a/b/"},
	} {
		if code, _ := r.do(t, c.method, c.path); code < 400 {
			t.Errorf("%s %s: %d", c.method, c.path, code)
		}
	}
}

func TestPackageMirrorRefusesAnUnknownSource(t *testing.T) {
	upstream, _ := url.Parse("http://127.0.0.1:9")
	p := NewNPM(upstream, upstream, func(*http.Request) bool { return false })
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/npm/pkg", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("%d", rec.Code)
	}
}
