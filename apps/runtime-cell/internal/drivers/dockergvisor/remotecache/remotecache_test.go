package remotecache

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeRegistry is the part of the distribution API the store uses, in memory:
// blobs by repository and digest (checked on upload, as a registry does),
// manifests by repository and tag.
type fakeRegistry struct {
	mu        sync.Mutex
	blobs     map[string][]byte // repo@digest
	manifests map[string][]byte // repo:tag
	uploads   int
	// tamper changes the bytes a blob GET returns.
	tamper func(digest string, b []byte) []byte
	auth   []string
}

func newFakeRegistry() *fakeRegistry {
	return &fakeRegistry{blobs: map[string][]byte{}, manifests: map[string][]byte{}}
}

func sum(b []byte) string {
	s := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(s[:])
}

func (f *fakeRegistry) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if u, _, ok := r.BasicAuth(); ok {
		f.auth = append(f.auth, u)
	}
	p := strings.TrimPrefix(r.URL.Path, "/v2/")
	switch {
	case strings.Contains(p, "/blobs/uploads/") && r.Method == http.MethodPost:
		repo, _, _ := strings.Cut(p, "/blobs/uploads/")
		f.uploads++
		w.Header().Set("Location", fmt.Sprintf("/v2/%s/blobs/uploads/u%d", repo, f.uploads))
		w.WriteHeader(http.StatusAccepted)
	case strings.Contains(p, "/blobs/uploads/") && r.Method == http.MethodPut:
		repo, _, _ := strings.Cut(p, "/blobs/uploads/")
		body, _ := io.ReadAll(r.Body)
		d := r.URL.Query().Get("digest")
		if sum(body) != d {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		f.blobs[repo+"@"+d] = body
		w.WriteHeader(http.StatusCreated)
	case strings.Contains(p, "/blobs/"):
		i := strings.Index(p, "/blobs/")
		repo, d := p[:i], p[i+len("/blobs/"):]
		b, ok := f.blobs[repo+"@"+d]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		if f.tamper != nil {
			b = f.tamper(d, b)
		}
		_, _ = w.Write(b)
	case strings.Contains(p, "/manifests/"):
		i := strings.Index(p, "/manifests/")
		key := p[:i] + ":" + p[i+len("/manifests/"):]
		if r.Method == http.MethodPut {
			body, _ := io.ReadAll(r.Body)
			f.manifests[key] = body
			w.WriteHeader(http.StatusCreated)
			return
		}
		b, ok := f.manifests[key]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write(b)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// writeCache makes a BuildKit local cache: two layers and a cache manifest
// the index names.
func writeCache(t *testing.T, dir string, layers ...string) {
	t.Helper()
	blobs := filepath.Join(dir, "blobs", "sha256")
	if err := os.MkdirAll(blobs, 0o700); err != nil {
		t.Fatal(err)
	}
	var descs []string
	for _, l := range layers {
		d := sum([]byte(l))
		if err := os.WriteFile(filepath.Join(blobs, strings.TrimPrefix(d, "sha256:")), []byte(l), 0o600); err != nil {
			t.Fatal(err)
		}
		descs = append(descs, fmt.Sprintf(`{"mediaType":"application/vnd.oci.image.layer.v1.tar+zstd","digest":%q,"size":%d}`, d, len(l)))
	}
	cacheManifest := []byte(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[` + strings.Join(descs, ",") + `]}`)
	cm := sum(cacheManifest)
	if err := os.WriteFile(filepath.Join(blobs, strings.TrimPrefix(cm, "sha256:")), cacheManifest, 0o600); err != nil {
		t.Fatal(err)
	}
	idx := fmt.Sprintf(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"mediaType":"application/vnd.oci.image.index.v1+json","digest":%q,"size":%d,"annotations":{"org.opencontainers.image.ref.name":"latest"}}]}`, cm, len(cacheManifest))
	if err := os.WriteFile(filepath.Join(dir, "index.json"), []byte(idx), 0o600); err != nil {
		t.Fatal(err)
	}
}

func newStore(t *testing.T, reg http.Handler) *Registry {
	t.Helper()
	srv := httptest.NewServer(reg)
	t.Cleanup(srv.Close)
	r, err := New(Config{URL: srv.URL + "/kodus-build-cache"})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

var keyA = Key{Org: "org-a", Env: "env-1", Service: "web"}

// The setup's cache goes off the cell and comes back byte for byte, as a
// layout BuildKit imports (index.json, oci-layout, blobs); a second push sends
// only what the registry lacks.
func TestACachePushedBySetupIsPulledBackWhole(t *testing.T) {
	reg := newFakeRegistry()
	st := newStore(t, reg)
	src := filepath.Join(t.TempDir(), "gen")
	writeCache(t, src, "layer one", "layer two")
	pushed, err := st.Push(context.Background(), keyA, src)
	if err != nil {
		t.Fatal(err)
	}
	if pushed.Blobs != 3 || pushed.Moved != 3 {
		t.Fatalf("push = %+v, want 3 blobs moved", pushed)
	}
	again, err := st.Push(context.Background(), keyA, src)
	if err != nil || again.Moved != 0 {
		t.Fatalf("second push moved %+v (%v), want nothing", again, err)
	}

	dst := filepath.Join(t.TempDir(), "pulled")
	if _, err := st.Pull(context.Background(), keyA, dst); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"index.json", "oci-layout"} {
		if _, err := os.Stat(filepath.Join(dst, rel)); err != nil {
			t.Fatalf("%s missing: %v", rel, err)
		}
	}
	want, _ := os.ReadFile(filepath.Join(src, "index.json"))
	got, _ := os.ReadFile(filepath.Join(dst, "index.json"))
	if !bytes.Equal(got, want) {
		t.Fatal("index.json differs from the one pushed")
	}
	entries, _ := os.ReadDir(filepath.Join(dst, "blobs", "sha256"))
	if len(entries) != 3 {
		t.Fatalf("%d blobs pulled, want 3", len(entries))
	}
}

// Never share a cache across orgs: the same environment and service of
// another org is another repository, under its own org segment, and a pull
// for it finds nothing.
func TestAnotherOrgsCacheIsAnotherRepository(t *testing.T) {
	keyB := Key{Org: "org-b", Env: keyA.Env, Service: keyA.Service}
	ra, rb := keyA.Repository("p"), keyB.Repository("p")
	if ra == rb || strings.Split(ra, "/")[1] == strings.Split(rb, "/")[1] {
		t.Fatalf("org-a %s and org-b %s share a repository or an org segment", ra, rb)
	}
	reg := newFakeRegistry()
	st := newStore(t, reg)
	src := filepath.Join(t.TempDir(), "gen")
	writeCache(t, src, "org-a layer")
	if _, err := st.Push(context.Background(), keyA, src); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pull(context.Background(), keyB, filepath.Join(t.TempDir(), "b")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("org-b pulled %v, want ErrNotFound", err)
	}
}

// A registry that serves other bytes for a blob fails the pull, and nothing
// a build would read is left (no index.json, no directory).
func TestABlobThatDoesNotMatchItsDigestFailsThePull(t *testing.T) {
	reg := newFakeRegistry()
	st := newStore(t, reg)
	src := filepath.Join(t.TempDir(), "gen")
	writeCache(t, src, "honest layer")
	if _, err := st.Push(context.Background(), keyA, src); err != nil {
		t.Fatal(err)
	}
	poisoned := sum([]byte("honest layer"))
	reg.tamper = func(d string, b []byte) []byte {
		if d == poisoned {
			return []byte("poison layer")
		}
		return b
	}
	dst := filepath.Join(t.TempDir(), "pulled")
	if _, err := st.Pull(context.Background(), keyA, dst); err == nil || !strings.Contains(err.Error(), "does not match its digest") {
		t.Fatalf("pull = %v, want a digest mismatch", err)
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatal("a failed pull left its directory")
	}
}

// A manifest the cell did not push (another artifact, an image) is refused.
func TestAManifestThatIsNotACacheIsRefused(t *testing.T) {
	reg := newFakeRegistry()
	st := newStore(t, reg)
	reg.manifests[keyA.Repository("kodus-build-cache")+":"+Tag] = []byte(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:` + strings.Repeat("a", 64) + `","size":2},"layers":[]}`)
	if _, err := st.Pull(context.Background(), keyA, filepath.Join(t.TempDir(), "x")); err == nil || !strings.Contains(err.Error(), "not a build cache") {
		t.Fatalf("pull = %v", err)
	}
}

// A cache whose index names a blob it does not carry is never pushed.
func TestACacheWithHolesIsNotPushed(t *testing.T) {
	st := newStore(t, newFakeRegistry())
	src := filepath.Join(t.TempDir(), "gen")
	writeCache(t, src, "layer")
	entries, _ := os.ReadDir(filepath.Join(src, "blobs", "sha256"))
	for _, e := range entries {
		b, _ := os.ReadFile(filepath.Join(src, "blobs", "sha256", e.Name()))
		if strings.HasPrefix(string(b), "{") {
			_ = os.Remove(filepath.Join(src, "blobs", "sha256", e.Name()))
		}
	}
	if _, err := st.Push(context.Background(), keyA, src); err == nil || !strings.Contains(err.Error(), "does not carry") {
		t.Fatalf("push = %v", err)
	}
}

func TestNewRefusesPlainHTTPOffLoopbackAndCredentialsInTheURL(t *testing.T) {
	for _, u := range []string{"http://registry.example/kodus", "https://user:pw@registry.example/kodus", "https://registry.example", "https://registry.example/Upper"} {
		if _, err := New(Config{URL: u}); err == nil {
			t.Errorf("New(%q) accepted", u)
		}
	}
	for _, u := range []string{"http://localhost:5000/kodus-build-cache", "http://127.0.0.1:5000/kodus/cache", "https://registry.example/kodus"} {
		if _, err := New(Config{URL: u}); err != nil {
			t.Errorf("New(%q) = %v", u, err)
		}
	}
}

// The credential goes to the registry only, never to a host a blob read redirects to.
func TestTheCredentialStaysWithTheRegistry(t *testing.T) {
	elsewhere := newFakeRegistry()
	other := httptest.NewServer(elsewhere)
	t.Cleanup(other.Close)
	reg := newFakeRegistry()
	redirecting := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/blobs/sha256:") {
			reg.mu.Lock()
			pathRepo, digest, _ := strings.Cut(r.URL.Path, "/blobs/")
			b := reg.blobs[strings.TrimPrefix(pathRepo, "/v2/")+"@"+digest]
			reg.mu.Unlock()
			elsewhere.mu.Lock()
			elsewhere.blobs[strings.TrimPrefix(r.URL.Path, "/v2/")] = b
			elsewhere.mu.Unlock()
			http.Redirect(w, r, other.URL+"/v2/x/blobs/"+digest, http.StatusTemporaryRedirect) //nolint:gosec // G710: the test's own second registry
			return
		}
		reg.ServeHTTP(w, r)
	})
	srv := httptest.NewServer(redirecting)
	t.Cleanup(srv.Close)
	st, err := New(Config{URL: srv.URL + "/kodus-build-cache", Auth: "cell:secret"})
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(t.TempDir(), "gen")
	writeCache(t, src, "layer")
	if _, err := st.Push(context.Background(), keyA, src); err != nil {
		t.Fatal(err)
	}
	// Go's client keeps the Authorization header only on a same-host redirect;
	// the store also sets it only for the registry's host.
	_, _ = st.Pull(context.Background(), keyA, filepath.Join(t.TempDir(), "p"))
	if len(elsewhere.auth) != 0 {
		t.Fatalf("the redirect target got credentials for %v", elsewhere.auth)
	}
	if len(reg.auth) == 0 {
		t.Fatal("the registry never got the credential")
	}
}

// pushNothing asserts a push of dir fails and nothing reached the registry:
// no upload opened, no blob stored, no manifest written.
func pushNothing(t *testing.T, dir string) {
	t.Helper()
	reg := newFakeRegistry()
	st := newStore(t, reg)
	if _, err := st.Push(context.Background(), keyA, dir); err == nil {
		t.Fatal("push of a tampered cache succeeded")
	}
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if reg.uploads != 0 || len(reg.blobs) != 0 || len(reg.manifests) != 0 {
		t.Fatalf("a tampered cache reached the registry: %d uploads, %d blobs, %d manifests", reg.uploads, len(reg.blobs), len(reg.manifests))
	}
}

// hostBlob writes, outside the cache, a file named by its own digest, as the
// host's content stores hold them, and returns its directory and digest.
func hostBlob(t *testing.T) (string, string) {
	t.Helper()
	host := filepath.Join(t.TempDir(), "host", "sha256")
	if err := os.MkdirAll(host, 0o700); err != nil {
		t.Fatal(err)
	}
	secret := []byte("another org's image config: ENV TOKEN=xyz")
	d := sum(secret)
	if err := os.WriteFile(filepath.Join(host, strings.TrimPrefix(d, "sha256:")), secret, 0o600); err != nil {
		t.Fatal(err)
	}
	return host, d
}

func indexNaming(t *testing.T, dir, digest string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "index.json"), []byte(`{"schemaVersion":2,"manifests":[{"digest":"`+digest+`"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

// The builder writes /cache-out: a `blobs` it swapped for a link to a host
// content store is refused, and no host file leaves the cell (review #2).
func TestAPushRefusesASymlinkedBlobsDirectory(t *testing.T) {
	host, d := hostBlob(t)
	cache := filepath.Join(t.TempDir(), "cache-out")
	if err := os.MkdirAll(cache, 0o700); err != nil {
		t.Fatal(err)
	}
	indexNaming(t, cache, d)
	if err := os.Symlink(filepath.Dir(host), filepath.Join(cache, "blobs")); err != nil {
		t.Fatal(err)
	}
	pushNothing(t, cache)
}

func TestAPushRefusesASymlinkedSha256Directory(t *testing.T) {
	host, d := hostBlob(t)
	cache := filepath.Join(t.TempDir(), "cache-out")
	if err := os.MkdirAll(filepath.Join(cache, "blobs"), 0o700); err != nil {
		t.Fatal(err)
	}
	indexNaming(t, cache, d)
	if err := os.Symlink(host, filepath.Join(cache, "blobs", "sha256")); err != nil {
		t.Fatal(err)
	}
	pushNothing(t, cache)
}

// A blob that is a link is refused with the whole cache, even when the index
// names only honest blobs: the cell never reads through a link the builder made.
func TestAPushRefusesASymlinkedBlob(t *testing.T) {
	host, d := hostBlob(t)
	cache := filepath.Join(t.TempDir(), "cache-out")
	writeCache(t, cache, "honest layer")
	if err := os.Symlink(filepath.Join(host, strings.TrimPrefix(d, "sha256:")), filepath.Join(cache, "blobs", "sha256", strings.TrimPrefix(d, "sha256:"))); err != nil {
		t.Fatal(err)
	}
	pushNothing(t, cache)
}

// A blob whose bytes are not its name is refused before anything is sent.
func TestAPushRefusesABlobThatDoesNotMatchItsName(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "cache-out")
	writeCache(t, cache, "honest layer")
	d := sum([]byte("honest layer"))
	if err := os.WriteFile(filepath.Join(cache, "blobs", "sha256", strings.TrimPrefix(d, "sha256:")), []byte("other bytes!"), 0o600); err != nil {
		t.Fatal(err)
	}
	pushNothing(t, cache)
}

// A blob rewritten after the listing is caught as it is read for the upload:
// its last bytes are held back, so the registry never gets the whole blob.
func TestABlobChangedAfterTheListingIsCutShort(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "cache-out")
	writeCache(t, cache, "honest layer")
	d := sum([]byte("honest layer"))
	root, err := os.OpenRoot(cache)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = root.Close() }()
	if err := os.WriteFile(filepath.Join(cache, blobPath(d)), []byte("other bytes!"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := openBlob(root, descriptor{Digest: d, Size: int64(len("honest layer"))})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	got, err := io.ReadAll(f)
	if !errors.Is(err, errBlobDigest) || len(got) >= len("honest layer") {
		t.Fatalf("read %d bytes, err %v; want the last bytes held back and a digest error", len(got), err)
	}
}
