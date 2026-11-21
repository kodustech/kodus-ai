package main

import (
	"crypto/tls"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// The cell's observer client read its certificate once, at boot. The
// renewer replaced the cell's identity files hours later, the hub moved to
// the new certificate, and every observer refused the old one once it
// expired: each probe waited three minutes for its observer (dev cell,
// 2026-11-19). The next handshake after a renewal presents the new one.
func TestObserverClientPresentsTheRenewedCertificate(t *testing.T) {
	ca, err := testpki.NewCA("cell dev CA")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	first := issueAndWrite(t, ca, dir)

	server, err := ca.Issue("kodus-observer", time.Hour, "kodus-observer", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var presented []string
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		presented = append(presented, r.TLS.PeerCertificates[0].SerialNumber.String())
		mu.Unlock()
		_, _ = io.WriteString(w, "ok")
	}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{server}, ClientCAs: ca.Pool(), ClientAuth: tls.RequireAndVerifyClientCert, MinVersion: tls.VersionTLS13}
	srv.StartTLS()
	defer srv.Close()

	st := settings{
		ObsCert:       filepath.Join(dir, "cell.pem"),
		ObsKey:        filepath.Join(dir, "cell.key.pem"),
		ObsCA:         filepath.Join(dir, "ca.pem"),
		ObsServerName: "kodus-observer",
	}
	_, hc, err := observerClient(st)
	if err != nil {
		t.Fatal(err)
	}
	call := func() {
		t.Helper()
		resp, err := hc.Get(srv.URL)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		hc.CloseIdleConnections()
	}

	call()
	renewed := issueAndWrite(t, ca, dir) // the renewer rewrites the same files
	call()

	mu.Lock()
	defer mu.Unlock()
	if len(presented) != 2 || presented[0] != first || presented[1] != renewed {
		t.Fatalf("presented %v, want [%s (boot) %s (renewed)]", presented, first, renewed)
	}
}

// issueAndWrite writes a new cell certificate over dir's identity files by
// rename, as the renewer does, and returns its serial.
func issueAndWrite(t *testing.T, ca *testpki.CA, dir string) string {
	t.Helper()
	leaf, err := ca.Issue("cell-dev-1", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	tmp := t.TempDir()
	if err := ca.WriteFiles(tmp, "", leaf); err != nil {
		t.Fatal(err)
	}
	for from, to := range map[string]string{"cert.pem": "cell.pem", "key.pem": "cell.key.pem", "ca.pem": "ca.pem"} {
		if err := os.Rename(filepath.Join(tmp, from), filepath.Join(dir, to)); err != nil {
			t.Fatal(err)
		}
	}
	return leaf.Leaf.SerialNumber.String()
}
