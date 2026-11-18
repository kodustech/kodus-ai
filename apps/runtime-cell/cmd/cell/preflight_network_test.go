package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/preflight"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// netDockerFake is the host's Docker as the -network checks ask it: the
// images it has, the manifests its registries serve, its containers.
type netDockerFake struct {
	local, remote map[string]bool
	containers    map[string]string
	asked         *asked
}

// asked are the images the checks looked up (they run at once).
type asked struct {
	mu   sync.Mutex
	refs []string
}

func (a *asked) add(ref string) { a.mu.Lock(); a.refs = append(a.refs, ref); a.mu.Unlock() }

func (a *asked) count() int { a.mu.Lock(); defer a.mu.Unlock(); return len(a.refs) }

func (f netDockerFake) ImagePresent(_ context.Context, ref string) (bool, error) {
	f.asked.add(ref)
	return f.local[ref], nil
}

func (f netDockerFake) ManifestReadable(_ context.Context, ref string) error {
	if f.remote[ref] {
		return nil
	}
	return os.ErrNotExist
}

func (f netDockerFake) ContainerStatus(_ context.Context, name string) (string, bool, error) {
	s, found := f.containers[name]
	return s, found, nil
}

// networkCell is a cell's network as a fresh install meets it: a hub with
// a certificate from the hub CA cell register wrote, a Git API, an org
// registry that takes the cell's credential and a cache registry that
// refuses it.
type networkCell struct {
	dir                  string
	hub, git, share, bad *httptest.Server
	asked                asked
}

func newNetworkCell(t *testing.T) *networkCell {
	t.Helper()
	dir, ca := cellFilesCA(t)
	n := &networkCell{dir: dir}
	hubCert, err := ca.Issue("hub", time.Hour, "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	n.hub = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Errorf("the hub was asked %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	n.hub.TLS = &tls.Config{Certificates: []tls.Certificate{hubCert}, ClientAuth: tls.RequestClientCert, MinVersion: tls.VersionTLS13}
	n.hub.StartTLS()
	t.Cleanup(n.hub.Close)
	n.git = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	t.Cleanup(n.git.Close)
	registry := func(user, password string) *httptest.Server {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet || r.URL.Path != "/v2/" {
				t.Errorf("a registry was asked %s %s", r.Method, r.URL.Path)
			}
			if u, p, ok := r.BasicAuth(); !ok || u != user || p != password {
				w.Header().Set("WWW-Authenticate", `Basic realm="registry"`)
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
		}))
		t.Cleanup(srv.Close)
		return srv
	}
	n.share = registry("cell", "secret")
	n.bad = registry("someone", "else")
	if err := os.WriteFile(filepath.Join(dir, "registry-auth"), []byte("cell:secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return n
}

func (n *networkCell) probes(t *testing.T) preflightProbes {
	p := testProbes(t)
	p.netDocker = netDockerFake{
		local: map[string]bool{"holder@sha256:1111111111111111111111111111111111111111111111111111111111111111": true},
		remote: map[string]bool{"observer@sha256:2222222222222222222222222222222222222222222222222222222222222222": true, defaultBuilderImage: true, defaultRegistryImage: true,
			"busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662": true},
		containers: map[string]string{"kodus-egress": "running"},
		asked:      &n.asked,
	}
	p.httpClient = n.git.Client()
	return p
}

func (n *networkCell) args() []string {
	return append(gvisorArgs(n.dir), "-network",
		"-hub-url", "wss://"+n.hub.Listener.Addr().String()+"/cells",
		"-git-api", n.git.URL,
		"-gvisor-egress-container", "kodus-egress",
		"-gvisor-bake-share", n.share.URL+"/kodus-bake", "-gvisor-bake-share-auth-file", filepath.Join(n.dir, "registry-auth"),
		"-gvisor-build-cache-remote", n.bad.URL+"/kodus-cache", "-gvisor-build-cache-remote-auth-file", filepath.Join(n.dir, "registry-auth"),
	)
}

// With -network a docker-gvisor cell's hub, Git API, every image it runs
// (the defaults included), its egress container and the registries it
// writes to are each reported; a registry that refuses the credential
// only warns, so the run passes.
func TestPreflightNetworkReportsWhatADockerGVisorCellReaches(t *testing.T) {
	n := newNetworkCell(t)
	code, got := runPreflightJSON(t, n.probes(t), n.args()...)
	if code != 0 || !got.OK {
		t.Fatalf("exit %d, %+v", code, got)
	}
	for name, want := range map[string]preflight.Status{
		preflight.NameHub: preflight.OK, preflight.NameGitAPI: preflight.OK, preflight.NameEgressContainer: preflight.OK,
		"image-holder": preflight.OK, "image-observer": preflight.OK, "image-builder": preflight.OK, "image-registry": preflight.OK, "image-helper": preflight.OK,
		preflight.NameBakeShare: preflight.OK, preflight.NameBuildCacheRemote: preflight.Warn,
	} {
		if r, found := check(got, name); !found || r.Status != want {
			t.Errorf("%s: %+v (found %v), want %s", name, r, found, want)
		}
	}
	if strings.Contains(strings.Join(got.Notes, " "), "neither is checked here") {
		t.Errorf("the notes still say the images are not checked: %v", got.Notes)
	}
}

// Without -network nothing reaches the network: no network check, no
// image looked up, and the note still says so.
func TestPreflightWithoutNetworkReachesNothing(t *testing.T) {
	n := newNetworkCell(t)
	args := slices.DeleteFunc(n.args(), func(a string) bool { return a == "-network" })
	_, got := runPreflightJSON(t, n.probes(t), args...)
	for _, name := range []string{preflight.NameHub, preflight.NameGitAPI, preflight.NameEgressContainer, "image-holder", preflight.NameBakeShare} {
		if r, found := check(got, name); found {
			t.Errorf("%s ran: %+v", name, r)
		}
	}
	if n.asked.count() != 0 || !strings.Contains(strings.Join(got.Notes, " "), "neither is checked here") {
		t.Fatalf("images asked %d, notes %v", n.asked.count(), got.Notes)
	}
}

// A hub nobody listens on breaks every claim: the run fails and exits 1.
func TestPreflightNetworkFailsWhenTheHubDoesNotAnswer(t *testing.T) {
	n := newNetworkCell(t)
	gone := n.hub.Listener.Addr().String()
	n.hub.Close()
	var out, errOut bytes.Buffer
	code := runPreflight(n.args(), &out, &errOut, n.probes(t))
	if code != 1 || !strings.Contains(out.String(), "fail hub") || !strings.Contains(out.String(), gone) {
		t.Fatalf("exit %d:\n%s", code, out.String())
	}
}

// A driver that pulls no image through this host's Docker: -network checks
// the hub and the Git API and says so.
func TestPreflightNetworkOfACellWithoutImagesChecksTheHubAndTheGitAPIOnly(t *testing.T) {
	n := newNetworkCell(t)
	p := n.probes(t)
	p.docker = nil
	args := []string{"-driver", "fake", "-dev", "-network", "-cert", filepath.Join(n.dir, "cert.pem"), "-key", filepath.Join(n.dir, "key.pem"), "-ca", filepath.Join(n.dir, "ca.pem"),
		"-hub-url", "wss://" + n.hub.Listener.Addr().String() + "/cells", "-git-api", n.git.URL}
	_, got := runPreflightJSON(t, p, args...)
	hub, _ := check(got, preflight.NameHub)
	git, _ := check(got, preflight.NameGitAPI)
	if hub.Status != preflight.OK || git.Status != preflight.OK || n.asked.count() != 0 || !strings.Contains(strings.Join(got.Notes, " "), "pulls no image") {
		t.Fatalf("%+v (images asked %d)", got, n.asked.count())
	}
}

// A cell on github.com also reaches codeload.github.com, where the API's
// tarball redirects; a GitHub Enterprise cell reaches its own host only.
func TestTheGitHostsAreTheAPIAndWhereItsTarballsRedirect(t *testing.T) {
	if got := gitHosts("https://api.github.com"); !slices.Equal(got, []string{"https://api.github.com/", "https://codeload.github.com/"}) {
		t.Fatalf("github.com: %v", got)
	}
	if got := gitHosts("https://ghe.example.com/api/v3/"); !slices.Equal(got, []string{"https://ghe.example.com/api/v3/"}) {
		t.Fatalf("GHE: %v", got)
	}
}

// cellFilesCA is cellFiles with the CA that signed them, the hub CA.
func cellFilesCA(t *testing.T) (string, *testpki.CA) {
	t.Helper()
	dir := t.TempDir()
	ca, err := testpki.NewCA("hub")
	if err != nil {
		t.Fatal(err)
	}
	for prefix, cn := range map[string]string{"": "cell-1", "obs-": "cell-1-observer-client"} {
		leaf, err := ca.Issue(cn, 24*time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		if err := ca.WriteFiles(dir, prefix, leaf); err != nil {
			t.Fatal(err)
		}
	}
	return dir, ca
}
