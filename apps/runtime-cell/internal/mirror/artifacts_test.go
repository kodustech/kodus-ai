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

type artRig struct {
	mirror   *httptest.Server
	upstream atomic.Int32
	paths    chan string
}

// newArtRig serves one entry shaped like the Firebase one (a bucket prefix on
// a host that also holds other paths) from a test upstream.
func newArtRig(t *testing.T, maxBytes int64, body string) *artRig {
	t.Helper()
	r := &artRig{paths: make(chan string, 16)}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.upstream.Add(1)
		r.paths <- req.Method + " " + req.URL.RequestURI()
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(up.Close)
	u, _ := url.Parse(up.URL)
	entries := []ArtifactEntry{{
		ID: "emu", Upstream: u, PathPrefix: "/firebase-preview-drop/emulator/",
		Name: nameRE(`[a-z0-9._-]+\.(?:jar|zip)`), MaxBytes: maxBytes,
	}}
	r.mirror = httptest.NewServer(NewArtifacts(entries, func(*http.Request) bool { return true }))
	t.Cleanup(r.mirror.Close)
	return r
}

func (r *artRig) do(t *testing.T, method, path string, header ...string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, r.mirror.URL+path, strings.NewReader(""))
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err.Error()
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestAListedArtifactIsServedFromItsFixedUpstreamPath(t *testing.T) {
	r := newArtRig(t, 1<<20, "jar-bytes")
	code, body := r.do(t, http.MethodGet, "/artifacts/emu/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.19.8.jar")
	if code != http.StatusOK || body != "jar-bytes" {
		t.Fatalf("%d %q", code, body)
	}
	if got := <-r.paths; got != "GET /firebase-preview-drop/emulator/cloud-firestore-emulator-v1.19.8.jar" {
		t.Fatalf("upstream got %q", got)
	}
	if code, body := r.do(t, http.MethodHead, "/artifacts/emu/firebase-preview-drop/emulator/ui-v1.13.0.zip"); code != http.StatusOK || body != "" {
		t.Fatalf("head %d %q", code, body)
	}
}

// A write, or any path, bucket or query a listed entry does not name, never
// reaches the upstream.
func TestNothingButAListedReadReachesTheUpstream(t *testing.T) {
	r := newArtRig(t, 1<<20, "x")
	for _, c := range []struct {
		method, path string
		header       []string
		want         int
	}{
		{http.MethodPut, "/artifacts/emu/firebase-preview-drop/emulator/a.jar", nil, http.StatusMethodNotAllowed},
		{http.MethodPost, "/artifacts/emu/firebase-preview-drop/emulator/a.jar", nil, http.StatusMethodNotAllowed},
		{http.MethodDelete, "/artifacts/emu/firebase-preview-drop/emulator/a.jar", nil, http.StatusMethodNotAllowed},
		{http.MethodPatch, "/artifacts/emu/firebase-preview-drop/emulator/a.jar", nil, http.StatusMethodNotAllowed},
		{http.MethodGet, "/artifacts/emu/other-bucket/emulator/a.jar", nil, http.StatusNotFound},
		{http.MethodGet, "/artifacts/emu/firebase-preview-drop/emulator/", nil, http.StatusNotFound},
		{http.MethodGet, "/artifacts/emu/firebase-preview-drop/emulator/sub/a.jar", nil, http.StatusNotFound},
		{http.MethodGet, "/artifacts/emu/firebase-preview-drop/..%2fsecret/emulator/a.jar", nil, http.StatusNotFound},
		{http.MethodGet, "/artifacts/emu/firebase-preview-drop/emulator/%2e%2e/a.jar", nil, http.StatusNotFound},
		{http.MethodGet, "/artifacts/emu/firebase-preview-drop/emulator/a.jar%2fb.jar", nil, http.StatusNotFound},
		{http.MethodGet, "/artifacts/emu/firebase-preview-drop/emulator/a.txt", nil, http.StatusNotFound},
		{http.MethodGet, "/artifacts/emu/firebase-preview-drop/emulator/a.jar?uploadType=media&name=x", nil, http.StatusNotFound},
		{http.MethodGet, "/artifacts/emu/firebase-preview-drop/emulator/a.jar?x=1", nil, http.StatusNotFound},
		{http.MethodGet, "/artifacts/emu/firebase-preview-drop//emulator/a.jar", nil, http.StatusNotFound},
		{http.MethodGet, "/artifacts/emu/firebase-preview-drop/emulator/a.jar", []string{"Authorization", "Bearer t"}, http.StatusUnauthorized},
		{http.MethodGet, "/artifacts/emu/firebase-preview-drop/emulator/a.jar", []string{"X-Goog-Api-Key", "k"}, http.StatusUnauthorized},
		{http.MethodGet, "/artifacts/emu/firebase-preview-drop/emulator/a.jar", []string{"Cookie", "a=b"}, http.StatusUnauthorized},
	} {
		if code, _ := r.do(t, c.method, c.path, c.header...); code != c.want {
			t.Errorf("%s %s %v: %d, want %d", c.method, c.path, c.header, code, c.want)
		}
	}
	if n := r.upstream.Load(); n != 0 {
		t.Fatalf("%d refused requests reached the upstream: %s", n, <-r.paths)
	}
}

func TestAnArtifactRequestFromNoClaimIsRefused(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("reached upstream") }))
	defer up.Close()
	u, _ := url.Parse(up.URL)
	h := NewArtifacts([]ArtifactEntry{{ID: "emu", Upstream: u, PathPrefix: "/b/", Name: nameRE(`[a-z]+\.jar`), MaxBytes: 10}}, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/artifacts/emu/b/a.jar", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("%d", rec.Code)
	}
}

func TestTheSizeCapRefusesALargeFileAndCutsAnUnannouncedOne(t *testing.T) {
	r := newArtRig(t, 4, "12345678")
	if code, _ := r.do(t, http.MethodGet, "/artifacts/emu/b/a.jar"); code == http.StatusOK {
		t.Fatal("a file over the cap was served")
	}
	// Chunked upstream with no length: the stream is cut, and the client sees
	// a failed transfer rather than a short file that looks whole.
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.(http.Flusher).Flush()
		_, _ = io.WriteString(w, "12345678")
	}))
	defer up.Close()
	u, _ := url.Parse(up.URL)
	m := httptest.NewServer(NewArtifacts([]ArtifactEntry{{ID: "emu", Upstream: u, PathPrefix: "/b/", Name: nameRE(`[a-z]+\.jar`), MaxBytes: 4}}, func(*http.Request) bool { return true }))
	defer m.Close()
	resp, err := http.Get(m.URL + "/artifacts/emu/b/a.jar")
	if err == nil {
		defer resp.Body.Close()
		if _, err = io.ReadAll(resp.Body); err == nil {
			t.Fatal("an over-cap stream ended as if whole")
		}
	}
}

func TestAnUpstreamRedirectIsNotFollowed(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		http.Redirect(w, req, "https://elsewhere.example/x.jar", http.StatusFound)
	}))
	defer up.Close()
	u, _ := url.Parse(up.URL)
	m := httptest.NewServer(NewArtifacts([]ArtifactEntry{{ID: "emu", Upstream: u, PathPrefix: "/b/", Name: nameRE(`[a-z]+\.jar`), MaxBytes: 10}}, func(*http.Request) bool { return true }))
	defer m.Close()
	resp, err := http.Get(m.URL + "/artifacts/emu/b/a.jar")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK || resp.Header.Get("Location") != "" {
		t.Fatalf("%d %v", resp.StatusCode, resp.Header)
	}
}

// The fixed list: each entry is one https host, a path prefix inside it, and
// a name pattern that cannot spell a slash, a dot-segment, a query or an
// escape; the families the product needs are all there.
func TestTheFixedListIsReviewedShape(t *testing.T) {
	list := DefaultArtifacts()
	byID := map[string]ArtifactEntry{}
	for _, e := range list {
		byID[e.ID] = e
		if e.Upstream.Scheme != "https" || e.Upstream.Path != "" || e.Upstream.RawQuery != "" || e.Upstream.User != nil {
			t.Errorf("%s: upstream %s", e.ID, e.Upstream)
		}
		if !strings.HasPrefix(e.PathPrefix, "/") || !strings.HasSuffix(e.PathPrefix, "/") || e.MaxBytes <= 0 || e.MaxBytes > 1<<30 {
			t.Errorf("%s: prefix %q cap %d", e.ID, e.PathPrefix, e.MaxBytes)
		}
		for _, bad := range []string{"a/b.jar", "../a.jar", "a%2fb.jar", "a?b=c", "a b.jar", ""} {
			if e.matches(bad) {
				t.Errorf("%s: name %q is accepted", e.ID, bad)
			}
		}
	}
	for id, c := range map[string]struct{ host, prefix, ok string }{
		"firebase-emulators": {"storage.googleapis.com", "/firebase-preview-drop/emulator/", "cloud-firestore-emulator-v1.19.8.jar"},
		"prisma":             {"binaries.prisma.sh", "/all_commits/", "605197351a3c8bdd595af2d2a9bc3025bca48ea2/debian-openssl-3.0.x/libquery_engine.so.node.gz"},
		"mongodb":            {"fastdl.mongodb.org", "/linux/", "mongodb-linux-x86_64-ubuntu2204-7.0.14.tgz"},
	} {
		e, ok := byID[id]
		if !ok || e.Upstream.Host != c.host || e.PathPrefix != c.prefix || !e.matches(c.ok) {
			t.Errorf("%s: %+v", id, e)
		}
	}
	if len(list) != len(byID) || len(list) != 3 {
		t.Fatalf("%d entries", len(list))
	}
}
