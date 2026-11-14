package mirror

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestGoProxyServesOnlyWhatTheClaimPins(t *testing.T) {
	var asked []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.Method+" "+r.URL.Path)
		if r.URL.Path == "/github.com/!burnt!sushi/toml/@v/v1.4.0.mod" {
			_, _ = io.WriteString(w, "module github.com/BurntSushi/toml\n")
			return
		}
		http.NotFound(w, r)
	}))
	defer up.Close()
	u, _ := url.Parse(up.URL)
	pins := map[string]bool{"github.com/BurntSushi/toml@v1.4.0": true, "example.com/gone@v1.0.0": true}
	g := &GoProxy{Upstream: u, Client: up.Client(), Pins: func(_ *http.Request, m, v string) bool { return pins[m+"@"+v] }}
	srv := httptest.NewServer(g)
	defer srv.Close()
	get := func(method, path string) int {
		req, _ := http.NewRequest(method, srv.URL+path, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	for path, want := range map[string]int{
		"/go/github.com/!burnt!sushi/toml/@v/v1.4.0.mod":   200, // pinned
		"/go/example.com/gone/@v/v1.0.0.zip":               410, // pinned, the upstream has none
		"/go/github.com/!burnt!sushi/toml/@v/v1.5.0.zip":   410, // a version go.sum does not pin
		"/go/attacker.example/data-c2vjcmv0/@v/v0.0.1.zip": 410, // data in a module name never leaves
		"/go/github.com/!burnt!sushi/toml/@v/list":         404, // no list: a pinned build never needs one
		"/go/github.com/!burnt!sushi/toml/@latest":         404,
		"/go/github.com/BurntSushi/toml/@v/v1.4.0.mod":     404, // unescaped upper case
		"/go/../etc/@v/v1.0.0.mod":                         404,
		"/sumdb/sum.golang.org/supported":                  404,
	} {
		if got := get(http.MethodGet, path); got != want {
			t.Errorf("GET %s: %d, want %d", path, got, want)
		}
	}
	if got := get(http.MethodPost, "/go/github.com/!burnt!sushi/toml/@v/v1.4.0.mod"); got != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d", got)
	}
	for _, a := range asked {
		if a != "GET /github.com/!burnt!sushi/toml/@v/v1.4.0.mod" && a != "GET /example.com/gone/@v/v1.0.0.zip" {
			t.Errorf("the upstream was asked %s", a)
		}
	}
}

func TestAllowGoRedirectOnlyToTheGoBucket(t *testing.T) {
	req := func(raw string) *http.Request { r, _ := http.NewRequest(http.MethodGet, raw, nil); return r }
	if err := AllowGoRedirect(req("https://storage.googleapis.com/proxy-golang-org-prod/abc-x.zip?Expires=1"), nil); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		"https://storage.googleapis.com/attacker-bucket/x", // the same CDN, another bucket
		"http://storage.googleapis.com/proxy-golang-org-prod/x",
		"https://attacker.example/proxy-golang-org-prod/x",
	} {
		if AllowGoRedirect(req(bad), nil) == nil {
			t.Errorf("followed %s", bad)
		}
	}
	if AllowGoRedirect(req("https://storage.googleapis.com/proxy-golang-org-prod/x"), make([]*http.Request, 2)) == nil {
		t.Error("a third redirect was followed")
	}
}

func TestParseGoSum(t *testing.T) {
	pins, err := ParseGoSum([]byte("github.com/BurntSushi/toml v1.4.0 h1:abc=\ngithub.com/BurntSushi/toml v1.4.0/go.mod h1:def=\n\ngolang.org/x/mod v0.20.0/go.mod h1:ghi=\n"))
	if err != nil || !pins["github.com/BurntSushi/toml@v1.4.0"] || !pins["golang.org/x/mod@v0.20.0"] || len(pins) != 2 {
		t.Fatalf("%v %v", pins, err)
	}
	for _, bad := range []string{"x v1 h1:a\n", "github.com/a/b v1.0.0\n", "github.com/a/../b v1.0.0 h1:a\n", "github.com/a/b 1.0.0 h1:a\n"} {
		if _, err := ParseGoSum([]byte(bad)); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestGoProxyProxiesTheChecksumDatabaseForPinnedModulesOnly(t *testing.T) {
	var asked []string
	sum := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.URL.Path)
		_, _ = io.WriteString(w, "ok")
	}))
	defer sum.Close()
	su, _ := url.Parse(sum.URL)
	up, _ := url.Parse("http://unused.invalid")
	pins := map[string]bool{"github.com/Masterminds/semver/v3@v3.4.0": true}
	g := &GoProxy{Upstream: up, SumDB: su, Client: sum.Client(), Pins: func(_ *http.Request, m, v string) bool { return pins[m+"@"+v] }}
	srv := httptest.NewServer(g)
	defer srv.Close()
	get := func(path string) int {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	for path, want := range map[string]int{
		"/go/sumdb/sum.golang.org/supported":                                       200,
		"/go/sumdb/sum.golang.org/lookup/github.com/!masterminds/semver/v3@v3.4.0": 200, // pinned
		"/go/sumdb/sum.golang.org/lookup/github.com/!masterminds/semver/v3@v3.5.0": 410, // not pinned
		"/go/sumdb/sum.golang.org/lookup/attacker.example/data-c2vjcmv0@v0.0.1":    410, // data in a name never leaves
		"/go/sumdb/sum.golang.org/latest":                                          200,
		"/go/sumdb/sum.golang.org/tile/8/0/x123/456":                               200,
		"/go/sumdb/sum.golang.org/tile/8/data/x001/234.p/17":                       200,
		"/go/sumdb/sum.golang.org/tile/8/0/secret-data":                            404,
		"/go/sumdb/sum.golang.org/../../etc/passwd":                                404,
		"/go/sumdb/other.example/lookup/x.example/y@v1.0.0":                        404,
	} {
		if got := get(path); got != want {
			t.Errorf("GET %s: %d, want %d", path, got, want)
		}
	}
	for _, a := range asked {
		switch a {
		case "/lookup/github.com/!masterminds/semver/v3@v3.4.0", "/latest", "/tile/8/0/x123/456", "/tile/8/data/x001/234.p/17":
		default:
			t.Errorf("the checksum database was asked %s", a)
		}
	}

	off := &GoProxy{Upstream: up, Pins: g.Pins}
	rec := httptest.NewRecorder()
	off.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/go/sumdb/sum.golang.org/supported", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("without SumDB: %d, want 404", rec.Code)
	}
}
