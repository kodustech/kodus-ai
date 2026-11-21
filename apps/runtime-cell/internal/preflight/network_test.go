package preflight

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// hubServer is a hub's public listener as the cell meets it: TLS with a
// certificate for hub.test, asking for (not requiring) a client
// certificate, and /health. It records the paths asked and the client
// certificate presented.
type hubServer struct {
	srv   *httptest.Server
	mu    sync.Mutex
	paths []string
	peer  string
}

func newHub(t *testing.T, ca *testpki.CA, health int) *hubServer {
	t.Helper()
	cert, err := ca.Issue("hub", time.Hour, "hub.test")
	if err != nil {
		t.Fatal(err)
	}
	h := &hubServer{}
	h.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		h.paths = append(h.paths, r.Method+" "+r.URL.Path)
		if len(r.TLS.PeerCertificates) > 0 {
			h.peer = r.TLS.PeerCertificates[0].Subject.CommonName
		}
		h.mu.Unlock()
		if r.URL.Path != "/health" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(health)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	h.srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, ClientAuth: tls.RequestClientCert, MinVersion: tls.VersionTLS13}
	h.srv.StartTLS()
	t.Cleanup(h.srv.Close)
	return h
}

func (h *hubServer) port() string {
	_, port, _ := net.SplitHostPort(h.srv.Listener.Addr().String())
	return port
}

// cellTLS is the cell's client TLS: its certificate and the hub CA only.
func cellTLS(t *testing.T, hubCA *testpki.CA) *tls.Config {
	t.Helper()
	leaf, err := hubCA.Issue("cell-1", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Config{Certificates: []tls.Certificate{leaf}, RootCAs: hubCA.Pool(), MinVersion: tls.VersionTLS13}
}

// resolves maps hub.test to loopback; every other name fails as DNS does.
func resolves(_ context.Context, host string) ([]string, error) {
	if host == "hub.test" {
		return []string{"127.0.0.1"}, nil
	}
	return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
}

func newCA(t *testing.T, name string) *testpki.CA {
	t.Helper()
	ca, err := testpki.NewCA(name)
	if err != nil {
		t.Fatal(err)
	}
	return ca
}

// A hub that answers is ok: reached by its name with the cell's own
// certificate, its chain checked against the hub CA, asked only /health
// (no hello, nothing registered), with each step's time reported.
func TestAHubThatAnswersIsReachedWithTheCellsCertificateAndAskedOnlyHealth(t *testing.T) {
	ca := newCA(t, "hub-ca")
	h := newHub(t, ca, http.StatusOK)
	r := CheckHub(context.Background(), Hub{URL: "wss://hub.test:" + h.port() + "/cells", TLS: cellTLS(t, ca), LookupHost: resolves})
	if r.Name != NameHub || r.Status != OK {
		t.Fatalf("%+v", r)
	}
	for _, want := range []string{"hub.test:" + h.port(), "127.0.0.1", "TCP", "TLS", "/health 200"} {
		if !strings.Contains(r.Reason, want) {
			t.Errorf("reason %q has no %q", r.Reason, want)
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.paths) != 1 || h.paths[0] != "GET /health" || h.peer != "cell-1" {
		t.Fatalf("the hub saw %v from %q", h.paths, h.peer)
	}
}

// A hub whose certificate does not chain to -ca fails, saying so: a wrong
// CA file or a TLS-inspecting proxy on the path.
func TestAHubCertificateFromAnotherCAFails(t *testing.T) {
	h := newHub(t, newCA(t, "proxy-ca"), http.StatusOK)
	r := CheckHub(context.Background(), Hub{URL: "wss://hub.test:" + h.port() + "/cells", TLS: cellTLS(t, newCA(t, "hub-ca")), LookupHost: resolves})
	if r.Status != Fail || !strings.Contains(r.Reason, "certificate") || !strings.Contains(r.Fix, "-ca") {
		t.Fatalf("%+v", r)
	}
}

// Each step that fails is named: the name does not resolve, nothing
// listens, no hub URL.
func TestEachHubStepThatFailsIsNamed(t *testing.T) {
	ca := newCA(t, "hub-ca")
	closed := newHub(t, ca, http.StatusOK)
	port := closed.port()
	closed.srv.Close()
	for name, c := range map[string]struct {
		url, says string
	}{
		"dns":    {"wss://hub.unknown:443/cells", "DNS"},
		"tcp":    {"wss://hub.test:" + port + "/cells", "TCP"},
		"no url": {"", "-hub-url"},
	} {
		t.Run(name, func(t *testing.T) {
			r := CheckHub(context.Background(), Hub{URL: c.url, TLS: cellTLS(t, ca), LookupHost: resolves})
			if r.Status != Fail || !strings.Contains(r.Reason, c.says) || r.Fix == "" {
				t.Fatalf("%+v", r)
			}
		})
	}
}

// A hub listener that takes TLS but whose /health is not 200 warns: the
// address is right, the hub behind it may not be serving.
func TestAHubWhoseHealthIsNot200Warns(t *testing.T) {
	ca := newCA(t, "hub-ca")
	h := newHub(t, ca, http.StatusBadGateway)
	r := CheckHub(context.Background(), Hub{URL: "wss://hub.test:" + h.port() + "/cells", TLS: cellTLS(t, ca), LookupHost: resolves})
	if r.Status != Warn || !strings.Contains(r.Reason, "502") {
		t.Fatalf("%+v", r)
	}
}

// Without the cell's certificate or the hub CA the hub is not dialed: the
// check fails pointing at the file checks.
func TestTheHubIsNotDialedWithoutTheCellsTLS(t *testing.T) {
	r := CheckHub(context.Background(), Hub{URL: "wss://hub.test:443/cells", LoadErr: errors.New("open /etc/kodus/cell/cert.pem: no such file"), LookupHost: resolves})
	if r.Status != Fail || !strings.Contains(r.Reason, "cert.pem") {
		t.Fatalf("%+v", r)
	}
}

// fakeImages is the host's Docker as the network checks ask it.
type fakeImages struct {
	local    map[string]bool
	remote   map[string]bool
	inspect  error
	statuses map[string]string
}

func (f fakeImages) ImagePresent(_ context.Context, ref string) (bool, error) {
	return f.local[ref], f.inspect
}

func (f fakeImages) ManifestReadable(_ context.Context, ref string) error {
	if f.remote[ref] {
		return nil
	}
	return errors.New("manifest unknown")
}

func (f fakeImages) ContainerStatus(_ context.Context, name string) (string, bool, error) {
	s, found := f.statuses[name]
	return s, found, nil
}

// An image resolves when it is on the host or its manifest is readable
// from its registry; one that does neither is reported at its own
// severity, with how to make it pull.
func TestAnImageResolvesLocallyOrByItsManifestAndElseIsReportedAtItsSeverity(t *testing.T) {
	d := fakeImages{
		local:  map[string]bool{"ghcr.io/kodustech/holder@sha256:a": true},
		remote: map[string]bool{"ghcr.io/kodustech/observer@sha256:b": true},
	}
	local := CheckImage(context.Background(), d, Image{Name: "image-holder", Flag: "-gvisor-holder-image", Ref: "ghcr.io/kodustech/holder@sha256:a", Below: Fail})
	remote := CheckImage(context.Background(), d, Image{Name: "image-observer", Flag: "-gvisor-observer-image", Ref: "ghcr.io/kodustech/observer@sha256:b", Below: Fail})
	if local.Status != OK || !strings.Contains(local.Reason, "present") || remote.Status != OK || !strings.Contains(remote.Reason, "ghcr.io") {
		t.Fatalf("local %+v, remote %+v", local, remote)
	}
	missing := CheckImage(context.Background(), d, Image{Name: "image-holder", Flag: "-gvisor-holder-image", Ref: "registry.example.com/holder@sha256:c", Below: Fail, Why: "every claim runs a holder"})
	optional := CheckImage(context.Background(), d, Image{Name: "image-sandbox", Flag: "-gvisor-sandbox-image", Ref: "registry.example.com/sandbox@sha256:d", Below: Warn})
	if missing.Status != Fail || !strings.Contains(missing.Reason, "manifest unknown") || !strings.Contains(missing.Reason, "every claim runs a holder") || !strings.Contains(missing.Fix, "docker pull registry.example.com/holder@sha256:c") {
		t.Fatalf("missing %+v", missing)
	}
	if optional.Status != Warn {
		t.Fatalf("optional %+v", optional)
	}
}

// The egress container must exist and run: every claim network joins it.
func TestTheEgressContainerMustExistAndRun(t *testing.T) {
	d := fakeImages{statuses: map[string]string{"kodus-egress": "running", "stopped-egress": "exited"}}
	if r := CheckEgressContainer(context.Background(), d, "kodus-egress"); r.Name != NameEgressContainer || r.Status != OK {
		t.Fatalf("running %+v", r)
	}
	for _, name := range []string{"stopped-egress", "absent-egress"} {
		if r := CheckEgressContainer(context.Background(), d, name); r.Status != Fail || !strings.Contains(r.Reason, name) || r.Fix == "" {
			t.Fatalf("%s %+v", name, r)
		}
	}
}

// A registry the cell writes to is ok when it answers with the credential
// taken, a warn when it does not (the cell runs without it), and a fail
// when its credential file does not load (the cell refuses to start).
func TestARegistryTheCellWritesToWarnsWhenItRefusesAndFailsWithoutItsCredentialFile(t *testing.T) {
	answered := CheckRegistry(context.Background(), Registry{Name: NameBakeShare, Flag: "-gvisor-bake-share", Where: "https://registry.example.com/kodus-bake", Check: func(context.Context) error { return nil }})
	refused := CheckRegistry(context.Background(), Registry{
		Name: NameBakeShare, Flag: "-gvisor-bake-share", AuthFlag: "-gvisor-bake-share-auth-file", HasAuth: true, Where: "https://registry.example.com/kodus-bake",
		Check: func(context.Context) error { return errors.New("the registry refused the credential") }, Why: "bakes stay on this cell",
	})
	noFile := CheckRegistry(context.Background(), Registry{
		Name: NameBakeShare, Flag: "-gvisor-bake-share", AuthFlag: "-gvisor-bake-share-auth-file", HasAuth: true, StartErr: errors.New("open /etc/kodus/bake-share: permission denied"),
		Check: func(context.Context) error { t.Error("checked without its credential"); return nil },
	})
	if answered.Status != OK || !strings.Contains(answered.Reason, "registry.example.com") {
		t.Fatalf("answered %+v", answered)
	}
	if refused.Status != Warn || !strings.Contains(refused.Reason, "refused") || !strings.Contains(refused.Reason, "bakes stay") || !strings.Contains(refused.Fix, "-gvisor-bake-share-auth-file") {
		t.Fatalf("refused %+v", refused)
	}
	if noFile.Status != Fail || !strings.Contains(noFile.Reason, "permission denied") {
		t.Fatalf("no file %+v", noFile)
	}
}

// The Git API every claim downloads its code from must answer over TLS
// the host trusts; any HTTP answer counts, and a host that does not answer
// fails, named.
func TestTheGitHostsMustAnswerAndTheOneThatDoesNotIsNamed(t *testing.T) {
	api := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("the check sent a credential")
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(api.Close)
	gone := httptest.NewTLSServer(http.NotFoundHandler())
	goneURL := gone.URL
	gone.Close()
	client := api.Client()
	if r := CheckGit(context.Background(), client, []string{api.URL}); r.Name != NameGitAPI || r.Status != OK || !strings.Contains(r.Reason, "401") {
		t.Fatalf("answering %+v", r)
	}
	r := CheckGit(context.Background(), client, []string{api.URL, goneURL})
	if r.Status != Fail || !strings.Contains(r.Reason, strings.TrimPrefix(goneURL, "https://")) || r.Fix == "" {
		t.Fatalf("one gone %+v", r)
	}
	// A server the host's roots do not trust fails as the download would.
	if r := CheckGit(context.Background(), &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: x509.NewCertPool(), MinVersion: tls.VersionTLS12}}}, []string{api.URL}); r.Status != Fail || !strings.Contains(r.Reason, "certificate") {
		t.Fatalf("untrusted %+v", r)
	}
}

// Network checks run under one bound: a check that hangs past it is
// reported at its own severity, and the others still are, in order.
func TestANetworkCheckThatHangsIsReportedAtTheBoundAndTheOthersStillAre(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	release := make(chan struct{})
	defer close(release)
	start := time.Now()
	rs := RunNetwork(ctx, time.Minute, []NetCheck{
		{Name: "first", Below: Warn, Run: func(context.Context) Result { return ok("first", "answered") }},
		{Name: "hangs", Below: Fail, Run: func(context.Context) Result { <-release; return ok("hangs", "too late") }},
		{Name: "last", Below: Warn, Run: func(context.Context) Result { return ok("last", "answered") }},
	})
	if time.Since(start) > 5*time.Second {
		t.Fatalf("the run took %s", time.Since(start))
	}
	if len(rs) != 3 || rs[0].Name != "first" || rs[0].Status != OK || rs[1].Name != "hangs" || rs[1].Status != Fail || rs[2].Name != "last" || rs[2].Status != OK {
		t.Fatalf("%+v", rs)
	}
	if !strings.Contains(rs[1].Reason, "no answer") {
		t.Fatalf("hangs %+v", rs[1])
	}
}

// Each check gets its own timeout under the bound: one that waits on its
// context ends there, saying so.
func TestEachNetworkCheckHasItsOwnTimeout(t *testing.T) {
	rs := RunNetwork(context.Background(), 50*time.Millisecond, []NetCheck{
		{Name: "slow", Below: Warn, Run: func(ctx context.Context) Result {
			<-ctx.Done()
			return warn("slow", "gave up: "+ctx.Err().Error(), "fix")
		}},
	})
	if len(rs) != 1 || rs[0].Status != Warn || !strings.Contains(rs[0].Reason, "50ms") {
		t.Fatalf("%+v", rs)
	}
}
