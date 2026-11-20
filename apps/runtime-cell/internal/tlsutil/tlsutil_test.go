package tlsutil

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// serverFiles writes a server certificate for 127.0.0.1 signed by ca and
// returns the paths of its cert, key and the CA.
func serverFiles(t *testing.T, ca *testpki.CA) (cert, key, caFile string) {
	t.Helper()
	dir := t.TempDir()
	leaf, err := ca.Issue("kodus-egress", time.Hour, "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if err := ca.WriteFiles(dir, "", leaf); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem"), filepath.Join(dir, "ca.pem")
}

// serve starts a TLS server with cfg answering "ok" and returns its URL.
func serve(t *testing.T, cfg *tls.Config, h http.Handler) string {
	t.Helper()
	if h == nil {
		h = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	}
	// Served the way the cell's processes serve it (a TLS listener over cfg,
	// as http.Server.ServeTLS and observersrv do): StartTLS would add its own
	// certificate to a config that has none and only GetCertificate.
	srv := httptest.NewUnstartedServer(h)
	srv.Listener = tls.NewListener(srv.Listener, cfg)
	srv.Start()
	t.Cleanup(srv.Close)
	return "https://" + srv.Listener.Addr().String()
}

func get(t *testing.T, url string, ca *testpki.CA, client tls.Certificate) (int, error) {
	t.Helper()
	c := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: ca.Pool(), Certificates: []tls.Certificate{client}, MinVersion: tls.VersionTLS13}}}
	resp, err := c.Get(url)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

// The control ports used to answer any certificate that chained to their
// CA: another cell's, signed by the same issuer, could push or read a
// claim's policy. Pinned, only the agent's own CN gets through.
func TestPinnedServerAnswersOnlyThePinnedCN(t *testing.T) {
	ca, _ := testpki.NewCA("issuer")
	cert, key, caFile := serverFiles(t, ca)
	cfg, err := PinnedServer(cert, key, caFile, Peer{CN: "cell-1"})
	if err != nil {
		t.Fatal(err)
	}
	url := serve(t, cfg, nil)
	agent, _ := ca.Issue("cell-1", time.Hour)
	if code, err := get(t, url, ca, agent); err != nil || code != http.StatusOK {
		t.Fatalf("pinned agent: %d %v", code, err)
	}
	other, _ := ca.Issue("cell-2", time.Hour)
	if _, err := get(t, url, ca, other); err == nil {
		t.Fatal("another cell's certificate from the same CA was answered")
	}
	rogue, _ := testpki.NewCA("rogue")
	forged, _ := rogue.Issue("cell-1", time.Hour)
	if _, err := get(t, url, ca, forged); err == nil {
		t.Fatal("the pinned CN from another CA was answered")
	}
}

func TestPinnedServerAnswersOnlyThePinnedSPKI(t *testing.T) {
	ca, _ := testpki.NewCA("issuer")
	cert, key, caFile := serverFiles(t, ca)
	agent, _ := ca.Issue("agent", time.Hour)
	sum := sha256.Sum256(agent.Leaf.RawSubjectPublicKeyInfo)
	cfg, err := PinnedServer(cert, key, caFile, Peer{SPKI: hex.EncodeToString(sum[:])})
	if err != nil {
		t.Fatal(err)
	}
	url := serve(t, cfg, nil)
	if code, err := get(t, url, ca, agent); err != nil || code != http.StatusOK {
		t.Fatalf("pinned key: %d %v", code, err)
	}
	// Same CN, another key.
	same, _ := ca.Issue("agent", time.Hour)
	if _, err := get(t, url, ca, same); err == nil {
		t.Fatal("a certificate with another key was answered")
	}
}

func TestPinnedServerRefusesNoPinAndABadSPKI(t *testing.T) {
	ca, _ := testpki.NewCA("issuer")
	cert, key, caFile := serverFiles(t, ca)
	if _, err := PinnedServer(cert, key, caFile, Peer{}); err == nil {
		t.Fatal("a pinned server with no pin")
	}
	if _, err := PinnedServer(cert, key, caFile, Peer{SPKI: "abc"}); err == nil {
		t.Fatal("an SPKI pin that is not a SHA-256")
	}
}

// RequirePeer guards a route that must answer the agent alone even on a
// server that did not pin its TLS (no -agent-cn yet): there, it answers no one.
func TestRequirePeerGuardsARoute(t *testing.T) {
	ca, _ := testpki.NewCA("issuer")
	cert, key, caFile := serverFiles(t, ca)
	cfg, err := Server(cert, key, caFile)
	if err != nil {
		t.Fatal(err)
	}
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	pinned := serve(t, cfg.Clone(), RequirePeer(Peer{CN: "cell-1"}, ok))
	unpinned := serve(t, cfg.Clone(), RequirePeer(Peer{}, ok))
	agent, _ := ca.Issue("cell-1", time.Hour)
	other, _ := ca.Issue("cell-2", time.Hour)
	for _, tc := range []struct {
		url    string
		client tls.Certificate
		want   int
	}{{pinned, agent, http.StatusOK}, {pinned, other, http.StatusForbidden}, {unpinned, agent, http.StatusForbidden}} {
		if code, err := get(t, tc.url, ca, tc.client); err != nil || code != tc.want {
			t.Errorf("%s as %s: %d %v, want %d", tc.url, tc.client.Leaf.Subject.CommonName, code, err, tc.want)
		}
	}
}

// Until the operator pins the agent (-agent-cn), the control port answers
// every certificate of its CA, as it did; pinned, another cell's is refused.
func TestControlServerPinsOnlyWhenAPeerIsGiven(t *testing.T) {
	ca, _ := testpki.NewCA("issuer")
	cert, key, caFile := serverFiles(t, ca)
	other, _ := ca.Issue("cell-2", time.Hour)
	open, err := ControlServer(cert, key, caFile, Peer{})
	if err != nil {
		t.Fatal(err)
	}
	if code, err := get(t, serve(t, open, nil), ca, other); err != nil || code != http.StatusOK {
		t.Fatalf("unpinned: %d %v", code, err)
	}
	pinned, err := ControlServer(cert, key, caFile, Peer{CN: "cell-1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := get(t, serve(t, pinned, nil), ca, other); err == nil {
		t.Fatal("pinned: another cell's certificate was answered")
	}
}

// A renewal renames the certificate and the key one after the other: a
// handshake between the two keeps the pair it had, and the one after the
// key lands presents the new certificate.
func TestReloadingClientKeepsTheLastPairBetweenTheTwoRenames(t *testing.T) {
	ca, err := testpki.NewCA("cell dev CA")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	issue := func() (tls.Certificate, string) {
		t.Helper()
		leaf, err := ca.Issue("cell-dev-1", time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		tmp := t.TempDir()
		if err := ca.WriteFiles(tmp, "", leaf); err != nil {
			t.Fatal(err)
		}
		return leaf, tmp
	}
	move := func(from, name string) {
		t.Helper()
		if err := os.Rename(filepath.Join(from, name), filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	boot, bootDir := issue()
	for _, n := range []string{"cert.pem", "key.pem", "ca.pem"} {
		move(bootDir, n)
	}
	cfg, err := ReloadingClient(filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem"), filepath.Join(dir, "ca.pem"))
	if err != nil {
		t.Fatal(err)
	}
	serial := func() string {
		t.Helper()
		c, err := cfg.GetClientCertificate(&tls.CertificateRequestInfo{})
		if err != nil {
			t.Fatal(err)
		}
		leaf, err := x509.ParseCertificate(c.Certificate[0])
		if err != nil {
			t.Fatal(err)
		}
		return leaf.SerialNumber.String()
	}
	if got := serial(); got != boot.Leaf.SerialNumber.String() {
		t.Fatalf("boot: presented %s", got)
	}
	renewed, renewedDir := issue()
	move(renewedDir, "cert.pem") // the key is still the old one
	if got := serial(); got != boot.Leaf.SerialNumber.String() {
		t.Fatalf("between the renames: presented %s, want the boot pair", got)
	}
	move(renewedDir, "key.pem")
	if got := serial(); got != renewed.Leaf.SerialNumber.String() {
		t.Fatalf("after the renewal: presented %s, want %s", got, renewed.Leaf.SerialNumber)
	}
}

// The control servers (egress, resolver, injector) and the observer read
// their certificate once, at start: a certificate replaced on disk was not
// served until the process restarted, and the old one expired under it.
// Through ControlServer, pinned or not, the next handshake after the files
// are replaced presents the new certificate.
func TestControlServerPresentsAReplacedCertificate(t *testing.T) {
	ca, err := testpki.NewCA("cell dev CA")
	if err != nil {
		t.Fatal(err)
	}
	for _, peer := range []Peer{{}, {CN: "cell-1"}} {
		dir := t.TempDir()
		write := func() string {
			t.Helper()
			leaf, err := ca.Issue("kodus-egress", time.Hour, "127.0.0.1")
			if err != nil {
				t.Fatal(err)
			}
			tmp := t.TempDir()
			if err := ca.WriteFiles(tmp, "", leaf); err != nil {
				t.Fatal(err)
			}
			for _, n := range []string{"cert.pem", "key.pem", "ca.pem"} {
				if err := os.Rename(filepath.Join(tmp, n), filepath.Join(dir, n)); err != nil {
					t.Fatal(err)
				}
			}
			return leaf.Leaf.SerialNumber.String()
		}
		first := write()
		cfg, err := ControlServer(filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem"), filepath.Join(dir, "ca.pem"), peer)
		if err != nil {
			t.Fatal(err)
		}
		url := serve(t, cfg, nil)
		client, err := ca.Issue("cell-1", time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		served := func() string {
			t.Helper()
			c := &http.Client{Transport: &http.Transport{DisableKeepAlives: true, TLSClientConfig: &tls.Config{RootCAs: ca.Pool(), Certificates: []tls.Certificate{client}, MinVersion: tls.VersionTLS13}}}
			resp, err := c.Get(url)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			_, _ = io.Copy(io.Discard, resp.Body)
			return resp.TLS.PeerCertificates[0].SerialNumber.String()
		}
		if got := served(); got != first {
			t.Fatalf("peer %+v: served %s at start, want %s", peer, got, first)
		}
		replaced := write()
		if got := served(); got != replaced {
			t.Fatalf("peer %+v: served %s after the files were replaced, want %s", peer, got, replaced)
		}
	}
}
