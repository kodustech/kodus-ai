package tlsutil

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
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
	srv := httptest.NewUnstartedServer(h)
	srv.TLS = cfg
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv.URL
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
