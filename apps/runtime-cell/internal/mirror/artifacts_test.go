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
		"firebase-emulators":   {"storage.googleapis.com", "/firebase-preview-drop/emulator/", "cloud-firestore-emulator-v1.19.8.jar"},
		"firebase-dataconnect": {"storage.googleapis.com", "/firemat-preview-drop/emulator/", "dataconnect-emulator-linux-amd64-v2.17.3"},
		"prisma":               {"binaries.prisma.sh", "/all_commits/", "605197351a3c8bdd595af2d2a9bc3025bca48ea2/debian-openssl-3.0.x/libquery_engine.so.node.gz"},
		"mongodb":              {"fastdl.mongodb.org", "/linux/", "mongodb-linux-x86_64-ubuntu2204-7.0.14.tgz"},
		"cypress":              {"cdn.cypress.io", "/desktop/", "13.17.0/linux-x64/cypress.zip"},
	} {
		e, ok := byID[id]
		if !ok || e.Upstream.Host != c.host || e.PathPrefix != c.prefix || !e.matches(c.ok) {
			t.Errorf("%s: %+v", id, e)
		}
	}
	if len(list) != len(byID) || len(list) != 5 {
		t.Fatalf("%d entries", len(list))
	}
}

// The real request paths of the tools' own code, read from the published
// packages (docs/runtime/egress-allowlist.md section 17): every one the list
// must serve, and the neighbours it must not.
func TestTheFixedListSpellsWhatTheToolsReallyRequest(t *testing.T) {
	byID := map[string]ArtifactEntry{}
	for _, e := range DefaultArtifacts() {
		byID[e.ID] = e
	}
	const commit = "c2990dca591cba766e3b7ef5d9e8a84796e47ab7"
	serve := map[string][]string{
		// firebase-tools 14.27.0 downloadableEmulatorInfo.json, 13.35.1 downloadableEmulators.js.
		"firebase-emulators": {
			"firebase-database-emulator-v4.11.2.jar", "cloud-firestore-emulator-v1.19.8.jar", "cloud-storage-rules-runtime-v1.1.3.jar",
			"ui-v1.15.0.zip", "ui-v1.14.0.zip", "pubsub-emulator-0.8.17.zip", "pubsub-emulator-0.8.14.zip",
		},
		"firebase-dataconnect": {"dataconnect-emulator-linux-amd64-v2.17.3", "dataconnect-emulator-linux-v1.9.2"},
		// @prisma/fetch-engine 5.22.0 and 6.19.3 getDownloadUrl, @prisma/get-platform binary targets.
		"prisma": {
			commit + "/debian-openssl-3.0.x/libquery_engine.so.node.gz",
			commit + "/debian-openssl-3.0.x/libquery_engine.so.node.gz.sha256",
			commit + "/debian-openssl-1.1.x/query-engine.gz",
			commit + "/debian-openssl-3.0.x/schema-engine.gz",
			commit + "/debian-openssl-3.0.x/schema-engine.gz.sha256",
			// downloadZip fetches the unzipped engine's checksum too (fetchChecksum(url without .gz)).
			commit + "/debian-openssl-3.0.x/libquery_engine.so.node.sha256",
			commit + "/linux-arm64-openssl-3.0.x/schema-engine.sha256",
			commit + "/linux-musl-openssl-3.0.x/schema-engine.gz",
			commit + "/linux-arm64-openssl-3.0.x/libquery_engine.so.node.gz",
			commit + "/linux-musl-arm64-openssl-3.0.x/query-engine.gz",
			commit + "/rhel-openssl-3.0.x/schema-engine.gz",
			commit + "/linux-musl/libquery_engine.so.node.gz",
		},
		// cypress 13.17.0 lib/tasks/download.js with CYPRESS_DOWNLOAD_PATH_TEMPLATE (buildmirror.CypressPathTemplate):
		// download.cypress.io/desktop/13.17.0?platform=linux&arch=x64 redirects to exactly this object.
		"cypress": {"13.17.0/linux-x64/cypress.zip", "14.5.4/linux-arm64/cypress.zip"},
		// mongodb-memory-server-core 9.5.0 and 10.4.3, MongoBinaryDownloadUrl and makeMD5check.
		"mongodb": {
			"mongodb-linux-x86_64-ubuntu2204-7.0.14.tgz", "mongodb-linux-x86_64-ubuntu2204-7.0.14.tgz.md5",
			"mongodb-linux-aarch64-ubuntu2204-7.0.14.tgz", "mongodb-linux-x86_64-debian12-8.0.4.tgz",
			"mongodb-linux-x86_64-rhel80-6.0.9.tgz", "mongodb-linux-aarch64-amazon2023-7.0.14.tgz", "mongodb-linux-x86_64-4.4.29.tgz",
		},
	}
	refuse := map[string][]string{
		"firebase-emulators": {
			"ui-vSNAPSHOT.zip", "firebase-database-emulator-v4.11.2.jar.sha256", "cloud-firestore-emulator-v1.19.8.zip",
			"ui-v1.15.0.jar", "other-emulator-v1.0.0.jar", "ui-v1.15.zip",
		},
		"firebase-dataconnect": {"dataconnect-emulator-macos-amd64-v2.17.3", "dataconnect-emulator-linux-arm64-v2.17.3", "dataconnect-emulator-linux-amd64-v2.17.3.exe", "dataconnect-emulator-linux-v1"},
		"prisma": {
			commit + "/debian-openssl-3.0.x/libquery_engine.so.node.gz.sig", commit + "/debian-openssl-3.0.x/schema-engine.sha256.gz",
			commit + "/debian-openssl-3.0.x/libquery_engine.so.node", commit + "/darwin-arm64/schema-engine.gz",
			commit + "/windows/schema-engine.exe.gz", commit + "/debian-openssl-3.0.x/prisma-fmt.gz", "latest/debian-openssl-3.0.x/schema-engine.gz",
			commit[:39] + "/debian-openssl-3.0.x/schema-engine.gz", commit + "/debian-openssl-3.0.x/schema-engine.gz/x",
		},
		"cypress": {
			"13.17.0", "13.17.0/darwin-arm64/cypress.zip", "13.17.0/win32-x64/cypress.zip", "13.17.0/linux-x64/other.zip",
			"latest/linux-x64/cypress.zip", "13.17/linux-x64/cypress.zip", "13.17.0/linux-x64/cypress.zip/x",
		},
		"mongodb": {
			"mongodb-linux-x86_64-ubuntu2204-7.0.14.tgz.sha256", "mongodb-linux-x86_64-ubuntu2204-7.0.14.tgz.sig",
			"mongodb-osx-ssl-x86_64-4.0.0.tgz", "mongodb-macos-arm64-7.0.14.tgz", "mongodb-windows-x86_64-7.0.14.zip",
			"mongodb-linux-x86_64-ubuntu2204-latest.tgz", "mongodb-linux-i686-3.0.0.tgz", "mongodb-linux-x86_64-ubuntu2204-7.0.14.tgz.md5.md5",
		},
	}
	for id, names := range serve {
		for _, n := range names {
			if !byID[id].matches(n) {
				t.Errorf("%s: %q is not served", id, n)
			}
		}
	}
	for id, names := range refuse {
		for _, n := range names {
			if byID[id].matches(n) {
				t.Errorf("%s: %q is served", id, n)
			}
		}
	}
}

// Cypress checks the zip it downloaded against the CDN's checksum: the publisher's integrity
// headers go through when they are plain tokens, and nothing else of the upstream's does.
func TestThePublishersIntegrityHeadersGoThroughAndNoOtherHeader(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Amz-Meta-Checksum", "74e5d06f8569ff3177d89f0b04cec3ae")
		w.Header().Set("X-Amz-Meta-Size", "4")
		w.Header().Set("Set-Cookie", "session=1")
		w.Header().Set("X-Amz-Meta-Other", "x")
		_, _ = io.WriteString(w, "abcd")
	}))
	defer up.Close()
	u, _ := url.Parse(up.URL)
	m := httptest.NewServer(NewArtifacts([]ArtifactEntry{{ID: "app", Upstream: u, PathPrefix: "/d/", Name: nameRE(`[a-z]+\.zip`), MaxBytes: 10}}, func(*http.Request) bool { return true }))
	defer m.Close()
	resp, err := http.Get(m.URL + "/artifacts/app/d/a.zip")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("X-Amz-Meta-Checksum") != "74e5d06f8569ff3177d89f0b04cec3ae" || resp.Header.Get("X-Amz-Meta-Size") != "4" {
		t.Fatalf("integrity headers %v", resp.Header)
	}
	if resp.Header.Get("Set-Cookie") != "" || resp.Header.Get("X-Amz-Meta-Other") != "" {
		t.Fatalf("an upstream header went through: %v", resp.Header)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Amz-Meta-Checksum", "abc\" onload=\"x")
		_, _ = io.WriteString(w, "abcd")
	}))
	defer bad.Close()
	bu, _ := url.Parse(bad.URL)
	bm := httptest.NewServer(NewArtifacts([]ArtifactEntry{{ID: "app", Upstream: bu, PathPrefix: "/d/", Name: nameRE(`[a-z]+\.zip`), MaxBytes: 10}}, func(*http.Request) bool { return true }))
	defer bm.Close()
	r2, err := http.Get(bm.URL + "/artifacts/app/d/a.zip")
	if err != nil {
		t.Fatal(err)
	}
	defer r2.Body.Close()
	if r2.Header.Get("X-Amz-Meta-Checksum") != "" {
		t.Fatal("a checksum that is no plain token went through")
	}
}
