package mirror

import (
	"bytes"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
)

// cacheHub is a Docker Hub whose answers a test changes and whose requests
// it counts: blobs redirect to object storage, tags name manifests.
type cacheHub struct {
	mu      sync.Mutex
	calls   []string          // "GET /v2/...", "HEAD /v2/...", "token"
	storage map[string][]byte // what object storage serves for a digest
	tags    map[string][]byte // tag -> manifest
	status  int               // non-zero: every registry request answers it
	gate    chan struct{}     // non-nil: storage waits on it
	auth    string            // the Authorization the token service saw last
}

func (h *cacheHub) record(c string) {
	h.mu.Lock()
	h.calls = append(h.calls, c)
	h.mu.Unlock()
}

func (h *cacheHub) count(prefix string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, c := range h.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func (h *cacheHub) set(f func(h *cacheHub)) {
	h.mu.Lock()
	f(h)
	h.mu.Unlock()
}

type cacheFixture struct {
	p     *OCIProxy
	hub   *cacheHub
	clk   *clock.Fake
	store *DiskStore
	logs  *bytes.Buffer
	dir   string
}

const golangRepo = "/v2/library/golang"

func newCacheFixture(t *testing.T) *cacheFixture {
	t.Helper()
	hub := &cacheHub{storage: map[string][]byte{}, tags: map[string][]byte{}}
	storage := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hub.mu.Lock()
		gate, body := hub.gate, hub.storage[strings.TrimPrefix(r.URL.Path, "/")]
		hub.mu.Unlock()
		if gate != nil {
			<-gate
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(storage.Close)
	reg := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hub.record(r.Method + " " + r.URL.Path)
		hub.mu.Lock()
		status := hub.status
		hub.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		if i := strings.Index(r.URL.Path, "/blobs/"); i > 0 {
			http.Redirect(w, r, storage.URL+"/"+r.URL.Path[i+len("/blobs/"):], http.StatusTemporaryRedirect)
			return
		}
		ref := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		hub.mu.Lock()
		m, ok := hub.tags[ref]
		hub.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.oci.image.index.v1+json")
		w.Header().Set("Docker-Content-Digest", digestOf(m))
		if r.Method == http.MethodGet {
			_, _ = w.Write(m)
		}
	}))
	t.Cleanup(reg.Close)
	auth := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hub.record("token")
		hub.set(func(h *cacheHub) { h.auth = r.Header.Get("Authorization") })
		_, _ = w.Write([]byte(`{"token":"tok","expires_in":300}`))
	}))
	t.Cleanup(auth.Close)

	clk := clock.NewFake(time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC))
	cm := NewCacheMetrics(metrics.NewRegistry())
	dir := t.TempDir()
	store, err := OpenDiskStore(dir, 1<<20, clk, cm)
	if err != nil {
		t.Fatal(err)
	}
	logs := &bytes.Buffer{}
	ru, _ := url.Parse(reg.URL)
	au, _ := url.Parse(auth.URL + "/token")
	client := &http.Client{CheckRedirect: ociRedirect, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	p := &OCIProxy{Registry: ru, Auth: au, Client: client, Store: store, Clock: clk, Metrics: cm,
		Log: slog.New(slog.NewJSONHandler(logs, nil)), TagTTL: 10 * time.Minute, StaleFor: time.Hour,
		// Two claims: 10.0.0.1 names golang, 10.0.0.2 names node.
		Pins: func(r *http.Request, repo, ref string) bool {
			want := map[string]string{"10.0.0.1": "library/golang", "10.0.0.2": "library/node"}[strings.Split(r.RemoteAddr, ":")[0]]
			return repo == want && (IsDigest(ref) || ref == "1.24")
		}}
	return &cacheFixture{p: p, hub: hub, clk: clk, store: store, logs: logs, dir: dir}
}

// fetch serves one request as the claim at addr; aborted is a cut response.
func (f *cacheFixture) fetch(t *testing.T, addr, method, path string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, nil)
	req.RemoteAddr = addr + ":40000"
	func() {
		defer func() {
			if r := recover(); r != nil && r != http.ErrAbortHandler {
				panic(r)
			}
		}()
		f.p.ServeHTTP(rec, req)
	}()
	return rec.Code, rec.Body.String()
}

func TestCachedBlobIsFetchedOnce(t *testing.T) {
	f := newCacheFixture(t)
	blob := []byte("layer bytes")
	f.hub.storage[digestOf(blob)] = blob
	path := golangRepo + "/blobs/" + digestOf(blob)
	for i := range 2 {
		if code, body := f.fetch(t, "10.0.0.1", http.MethodGet, path); code != http.StatusOK || body != string(blob) {
			t.Fatalf("fetch %d: %d %q", i, code, body)
		}
	}
	if n := f.hub.count("GET " + path); n != 1 {
		t.Fatalf("the registry was asked %d times for a cached blob", n)
	}
	if f.p.Metrics.Count("blob", "miss") != 1 || f.p.Metrics.Count("blob", "hit") != 1 {
		t.Fatalf("metrics: miss %v hit %v", f.p.Metrics.Count("blob", "miss"), f.p.Metrics.Count("blob", "hit"))
	}
	// The cache outlives the process: a new store on the same directory has it.
	again, err := OpenDiskStore(f.dir, 1<<20, f.clk, nil)
	if err != nil {
		t.Fatal(err)
	}
	if b, err := again.Open(digestOf(blob)); err != nil {
		t.Fatalf("after a restart: %v", err)
	} else {
		b.Close()
	}
}

func TestCorruptBlobIsNeitherCachedNorServed(t *testing.T) {
	f := newCacheFixture(t)
	blob := []byte("the real layer")
	f.hub.storage[digestOf(blob)] = []byte("something else entirely")
	path := golangRepo + "/blobs/" + digestOf(blob)
	for range 2 {
		if code, body := f.fetch(t, "10.0.0.1", http.MethodGet, path); code == http.StatusOK || strings.Contains(body, "something else") {
			t.Fatalf("a blob that is not its digest was served: %d %q", code, body)
		}
	}
	if _, err := f.store.Open(digestOf(blob)); !errors.Is(err, ErrNotCached) {
		t.Fatalf("the wrong bytes were cached: %v", err)
	}
	if n := f.hub.count("GET " + path); n != 2 {
		t.Fatalf("a refused blob must be fetched again, got %d fetches", n)
	}
	if ents, _ := os.ReadDir(filepath.Join(f.dir, "tmp")); len(ents) != 0 {
		t.Fatalf("a refused blob left a temp file: %v", ents)
	}
}

func TestTagManifestTTLAndRevalidation(t *testing.T) {
	f := newCacheFixture(t)
	v1, v2 := []byte(`{"manifests":[1]}`), []byte(`{"manifests":[2]}`)
	f.hub.tags["1.24"] = v1
	path := golangRepo + "/manifests/1.24"
	get := func(want []byte) {
		t.Helper()
		if code, body := f.fetch(t, "10.0.0.1", http.MethodGet, path); code != http.StatusOK || body != string(want) {
			t.Fatalf("tag: %d %q, want %q", code, body, want)
		}
	}
	get(v1)
	f.clk.Advance(9 * time.Minute)
	get(v1)
	if f.hub.count("GET "+path) != 1 || f.hub.count("HEAD "+path) != 0 {
		t.Fatalf("within the TTL the registry was asked: %v", f.hub.calls)
	}
	f.clk.Advance(2 * time.Minute)
	get(v1)
	if f.hub.count("GET "+path) != 1 || f.hub.count("HEAD "+path) != 1 {
		t.Fatalf("an unchanged tag past its TTL must be one HEAD: %v", f.hub.calls)
	}
	f.hub.set(func(h *cacheHub) { h.tags["1.24"] = v2 })
	f.clk.Advance(11 * time.Minute)
	get(v2)
	if f.hub.count("GET "+path) != 2 {
		t.Fatalf("a moved tag was not fetched: %v", f.hub.calls)
	}
	// The manifest by digest comes from the cache.
	if code, body := f.fetch(t, "10.0.0.1", http.MethodGet, golangRepo+"/manifests/"+digestOf(v2)); code != http.StatusOK || body != string(v2) {
		t.Fatalf("by digest: %d %q", code, body)
	}
	if f.hub.count("GET "+golangRepo+"/manifests/sha256:") != 0 {
		t.Fatal("a cached manifest was fetched by digest")
	}
}

func TestTagManifestIsServedStaleWhileTheRegistryLimits(t *testing.T) {
	f := newCacheFixture(t)
	m := []byte(`{"manifests":[]}`)
	f.hub.tags["1.24"] = m
	path := golangRepo + "/manifests/1.24"
	f.fetch(t, "10.0.0.1", http.MethodGet, path)
	f.hub.set(func(h *cacheHub) { h.status = http.StatusTooManyRequests })
	f.clk.Advance(30 * time.Minute)
	if code, body := f.fetch(t, "10.0.0.1", http.MethodGet, path); code != http.StatusOK || body != string(m) {
		t.Fatalf("stale: %d %q", code, body)
	}
	if !strings.Contains(f.logs.String(), "mirror.manifest.stale") || f.p.Metrics.Count("manifest", "stale") != 1 {
		t.Fatalf("a stale answer was not logged and counted: %s", f.logs)
	}
	f.clk.Advance(time.Hour)
	if code, _ := f.fetch(t, "10.0.0.1", http.MethodGet, path); code != http.StatusTooManyRequests {
		t.Fatalf("past the stale window: %d, want the registry's 429", code)
	}
	// A 404 is an answer, not a failure: the tag is gone, nothing stale is served.
	f.hub.set(func(h *cacheHub) { h.status = http.StatusNotFound })
	if code, _ := f.fetch(t, "10.0.0.1", http.MethodGet, path); code != http.StatusNotFound {
		t.Fatalf("404: %d", code)
	}
}

func TestDiskStoreEvictsTheLeastRecentlyUsed(t *testing.T) {
	clk := clock.NewFake(time.Unix(1e9, 0))
	cm := NewCacheMetrics(metrics.NewRegistry())
	s, err := OpenDiskStore(t.TempDir(), 10, clk, cm)
	if err != nil {
		t.Fatal(err)
	}
	put := func(b string) {
		t.Helper()
		w, err := s.Create(digestOf([]byte(b)))
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(b))
		if err := w.Commit(); err != nil {
			t.Fatal(err)
		}
		clk.Advance(time.Second)
	}
	has := func(b string) bool {
		bl, err := s.Open(digestOf([]byte(b)))
		if err == nil {
			bl.Close()
		}
		return err == nil
	}
	put("aaaa")
	put("bbbb")
	has("aaaa") // a is now the most recently used
	put("cccc")
	if !has("aaaa") || has("bbbb") || !has("cccc") || s.Bytes() != 8 || cm.Evictions() != 1 {
		t.Fatalf("a=%v b=%v c=%v bytes=%d evictions=%v", has("aaaa"), has("bbbb"), has("cccc"), s.Bytes(), cm.Evictions())
	}
	// One blob larger than the bound is still kept until the next commit.
	put("0123456789abcdef")
	if !has("0123456789abcdef") {
		t.Fatal("the blob just committed was evicted before its waiters read it")
	}
}

func TestConcurrentRequestsForOneBlobFetchItOnce(t *testing.T) {
	f := newCacheFixture(t)
	blob := bytes.Repeat([]byte("x"), 64<<10)
	gate := make(chan struct{})
	f.hub.set(func(h *cacheHub) { h.storage[digestOf(blob)] = blob; h.gate = gate })
	const n = 8
	type result struct {
		code int
		body string
	}
	results := make(chan result, n)
	for range n {
		go func() {
			code, body := f.fetch(t, "10.0.0.1", http.MethodGet, golangRepo+"/blobs/"+digestOf(blob))
			results <- result{code, body}
		}()
	}
	// Every request joins the one download before it is let through.
	for f.p.flights.waiting(digestOf(blob)) < n {
		runtime.Gosched()
	}
	close(gate)
	for range n {
		if r := <-results; r.code != http.StatusOK || r.body != string(blob) {
			t.Fatalf("a waiter got %d (%d bytes)", r.code, len(r.body))
		}
	}
	if got := f.hub.count("GET " + golangRepo + "/blobs/"); got != 1 {
		t.Fatalf("%d concurrent requests made %d upstream fetches", n, got)
	}
}

func TestDiskStoreCleansWhatACrashLeft(t *testing.T) {
	dir := t.TempDir()
	good := []byte("committed before the crash")
	for name, body := range map[string][]byte{
		"tmp/" + strings.TrimPrefix(digestOf(good), "sha256:") + ".123": good[:5], // a write cut by the crash
		"sha256/" + strings.TrimPrefix(digestOf(good), "sha256:"):       good,
		"sha256/not-a-digest": []byte("junk"),
	} {
		_ = os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o700)
		if err := os.WriteFile(filepath.Join(dir, name), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	s, err := OpenDiskStore(dir, 1<<20, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if ents, _ := os.ReadDir(filepath.Join(dir, "tmp")); len(ents) != 0 {
		t.Fatalf("temp files survived: %v", ents)
	}
	if _, err := os.Stat(filepath.Join(dir, "sha256", "not-a-digest")); !os.IsNotExist(err) {
		t.Fatal("a file not named by a digest was kept")
	}
	b, err := s.Open(digestOf(good))
	if err != nil || b.Size() != int64(len(good)) || s.Bytes() != int64(len(good)) {
		t.Fatalf("the committed blob was lost: %v", err)
	}
	b.Close()
}

func TestACachedBlobStillNeedsThePin(t *testing.T) {
	f := newCacheFixture(t)
	blob := []byte("golang's layer")
	f.hub.storage[digestOf(blob)] = blob
	if code, _ := f.fetch(t, "10.0.0.1", http.MethodGet, golangRepo+"/blobs/"+digestOf(blob)); code != http.StatusOK {
		t.Fatalf("the pinning claim: %d", code)
	}
	// The other claim names node, not golang: knowing the digest is not enough.
	for _, m := range []string{http.MethodGet, http.MethodHead} {
		if code, body := f.fetch(t, "10.0.0.2", m, golangRepo+"/blobs/"+digestOf(blob)); code != http.StatusForbidden || strings.Contains(body, string(blob)) {
			t.Fatalf("%s by a claim that does not pin golang: %d %q", m, code, body)
		}
	}
}

func TestCredentialsReachOnlyTheTokenService(t *testing.T) {
	f := newCacheFixture(t)
	path := filepath.Join(t.TempDir(), "auth.json")
	_ = os.WriteFile(path, []byte(`{"username":"kodus-bot","token":"dckr_pat_s3cr3t"}`), 0o600)
	creds, err := LoadCredentials(path)
	if err != nil {
		t.Fatal(err)
	}
	f.p.Credentials = creds
	m := []byte(`{"manifests":[]}`)
	f.hub.tags["1.24"] = m
	f.fetch(t, "10.0.0.1", http.MethodGet, golangRepo+"/manifests/1.24")
	if want := "Basic " + "a29kdXMtYm90OmRja3JfcGF0X3MzY3IzdA=="; f.hub.auth != want {
		t.Fatalf("the token request carried %q", f.hub.auth)
	}
	// Exercise the logged paths, then format the credentials every way.
	f.hub.set(func(h *cacheHub) { h.status = http.StatusServiceUnavailable })
	f.clk.Advance(20 * time.Minute)
	f.fetch(t, "10.0.0.1", http.MethodGet, golangRepo+"/manifests/1.24")
	f.p.Log.Info("probe", "creds", creds, "value", *creds)
	out := f.logs.String() + fmt.Sprint(creds, *creds) + fmt.Sprintf("%v %+v %#v %s", *creds, *creds, *creds, *creds)
	for _, secret := range []string{"kodus-bot", "dckr_pat_s3cr3t", "a29kdXMtYm90"} {
		if strings.Contains(out, secret) {
			t.Fatalf("%q leaked: %s", secret, out)
		}
	}
	_ = os.WriteFile(path, []byte(`{"username":"kodus-bot","token":`), 0o600)
	if _, err := LoadCredentials(path); err == nil || strings.Contains(err.Error(), "kodus-bot") {
		t.Fatalf("a bad file: %v", err)
	}
}
