package enrollment

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"log"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

// renewHub signs /cells/renew CSRs for the certificate presented, the way
// the TS hub does, and records the serial of every client handshake.
type renewHub struct {
	ca      *testpki.CA
	serial  atomic.Int64
	fail    atomic.Bool
	ttl     time.Duration
	mu      sync.Mutex
	clients []string
}

func (h *renewHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/cells/renew" || len(r.TLS.PeerCertificates) == 0 {
		http.Error(w, "mTLS required", http.StatusUnauthorized)
		return
	}
	if h.fail.Load() {
		http.Error(w, `{"code":"renewal_refused"}`, http.StatusServiceUnavailable)
		return
	}
	var body struct{ CSR string }
	_ = json.NewDecoder(r.Body).Decode(&body)
	blk, _ := pem.Decode([]byte(body.CSR))
	csr, err := x509.ParseCertificateRequest(blk.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		http.Error(w, "bad csr", http.StatusBadRequest)
		return
	}
	cn := r.TLS.PeerCertificates[0].Subject.CommonName
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(1000 + h.serial.Add(1)), Subject: pkix.Name{CommonName: cn},
		NotBefore: time.Now().Add(-time.Second), NotAfter: time.Now().Add(h.ttl),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, _ := x509.CreateCertificate(rand.Reader, tpl, h.ca.Cert, csr.PublicKey, h.ca.Key)
	_ = json.NewEncoder(w).Encode(CertificateResponse{OK: true, CellID: cn, Serial: tpl.SerialNumber.Text(16), ExpiresAt: tpl.NotAfter.UTC().Format(time.RFC3339),
		Certificate: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), CACertificate: string(h.ca.PEM)})
}

func startHub(t *testing.T, h *renewHub) (*httptest.Server, string) {
	serverCert, _ := h.ca.Issue("runtime-hub", time.Hour, "127.0.0.1")
	srv := httptest.NewUnstartedServer(h)
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientCAs: h.ca.Pool(), ClientAuth: tls.RequireAndVerifyClientCert, MinVersion: tls.VersionTLS13,
		VerifyConnection: func(cs tls.ConnectionState) error {
			h.mu.Lock()
			h.clients = append(h.clients, cs.PeerCertificates[0].SerialNumber.String())
			h.mu.Unlock()
			return nil
		}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv, srv.URL
}

func TestRenewAtIsAThirdOfTheValidityBeforeTheEnd(t *testing.T) {
	nb := time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)
	leaf := &x509.Certificate{NotBefore: nb, NotAfter: nb.Add(24 * time.Hour)}
	if got := RenewAt(leaf); !got.Equal(nb.Add(16 * time.Hour)) {
		t.Fatalf("renew at %s", got)
	}
}

// due is a renewer clock 45 minutes ahead: an hour-long certificate issued
// now is past its renewal point (two thirds of its life) on it.
func due() time.Time { return time.Now().Add(45 * time.Minute) }

// The renewal swaps the certificate the next handshake presents and writes
// the files; a connection opened with the old certificate stays up.
func TestRenewerSwapsTheCertificateAndKeepsLiveConnections(t *testing.T) {
	ca, _ := testpki.NewCA("hub-ca")
	h := &renewHub{ca: ca, ttl: 24 * time.Hour}
	_, url := startHub(t, h)

	// An echo server on the same CA stands for the live hub WebSocket.
	echoCert, _ := ca.Issue("echo", time.Hour, "127.0.0.1")
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{echoCert}, ClientCAs: ca.Pool(), ClientAuth: tls.RequireAndVerifyClientCert, MinVersion: tls.VersionTLS13})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(c, c) }()
		}
	}()

	// A cell certificate with less than a third left on the renewer's clock:
	// renewed at once. It stays valid for an hour on the real clock, so a
	// loaded machine handshakes with it however long the test takes (a 1 s
	// certificate used to expire first, and the test measured that instead).
	old, _ := ca.Issue("cell-7", time.Hour)
	holder, _ := NewCertHolder(old)
	live, err := tls.Dial("tcp", ln.Addr().String(), holder.ClientTLS(ca.Pool()))
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	if _, err := live.Write([]byte("before\n")); err != nil {
		t.Fatal(err)
	}
	rd := bufio.NewReader(live)
	if l, _ := rd.ReadString('\n'); l != "before\n" {
		t.Fatalf("echo %q", l)
	}

	dir := t.TempDir()
	p := Paths{Key: filepath.Join(dir, "key.pem"), Cert: filepath.Join(dir, "cert.pem"), CA: filepath.Join(dir, "ca.pem")}
	logs := &syncBuf{}
	r := &Renewer{Holder: holder, Hub: url, Roots: ca.Pool(), Paths: p, Log: slog.New(slog.NewJSONHandler(logs, nil)), Now: due}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); r.Run(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for r.Renewals.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("not renewed: %s", logs.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The new one has 24 h: the loop now waits 16 h.
	for !strings.Contains(logs.String(), "cert.renew.scheduled") {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done

	leaf := holder.Leaf()
	if leaf.SerialNumber.Int64() != 1001 || leaf.Subject.CommonName != "cell-7" {
		t.Fatalf("holder serial %s cn %s", leaf.SerialNumber, leaf.Subject.CommonName)
	}
	pair, err := tls.LoadX509KeyPair(p.Cert, p.Key)
	if err != nil || !bytes.Equal(pair.Certificate[0], leaf.Raw) {
		t.Fatalf("files: %v", err)
	}
	if fi, _ := os.Stat(p.Key); fi.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v", fi.Mode())
	}
	if strings.Contains(logs.String(), "PRIVATE KEY") {
		t.Fatal("key material logged")
	}
	// The live connection still works on the old certificate...
	if _, err := live.Write([]byte("after\n")); err != nil {
		t.Fatal(err)
	}
	if l, _ := rd.ReadString('\n'); l != "after\n" {
		t.Fatalf("live connection after renewal: %q", l)
	}
	// ...and a new handshake presents the new one.
	c2, err := tls.Dial("tcp", ln.Addr().String(), holder.ClientTLS(ca.Pool()))
	if err != nil {
		t.Fatal(err)
	}
	_ = c2.Handshake()
	c2.Close()
	h.mu.Lock()
	first := h.clients[0]
	h.mu.Unlock()
	if first != old.Leaf.SerialNumber.String() {
		t.Fatalf("renewal call presented %s, want the current %s", first, old.Leaf.SerialNumber)
	}
}

func TestRenewerAlarmsAndBacksOffUntilTheHubAnswers(t *testing.T) {
	ca, _ := testpki.NewCA("hub-ca")
	h := &renewHub{ca: ca, ttl: 24 * time.Hour}
	h.fail.Store(true)
	_, url := startHub(t, h)
	// Due on the renewer's clock, valid for an hour on the real one: the
	// backoff runs as long as it needs without the certificate expiring.
	old, _ := ca.Issue("cell-8", time.Hour)
	holder, _ := NewCertHolder(old)
	dir := t.TempDir()
	logs := &syncBuf{}
	r := &Renewer{Holder: holder, Hub: url, Roots: ca.Pool(), Log: slog.New(slog.NewJSONHandler(logs, nil)), Now: due,
		Paths:      Paths{Key: filepath.Join(dir, "key.pem"), Cert: filepath.Join(dir, "cert.pem"), CA: filepath.Join(dir, "ca.pem")},
		MinBackoff: 20 * time.Millisecond, MaxBackoff: 80 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.Run(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for r.Failures.Load() < 3 {
		if time.Now().After(deadline) {
			t.Fatalf("failures %d: %s", r.Failures.Load(), logs.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !strings.Contains(logs.String(), `"msg":"cert.renew.failed","alarm":true`) || !strings.Contains(logs.String(), `"level":"ERROR"`) {
		t.Fatalf("no alarm: %s", logs.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "cert.pem")); err == nil {
		t.Fatal("files written after a refused renewal")
	}
	if holder.Leaf().SerialNumber.Cmp(old.Leaf.SerialNumber) != 0 {
		t.Fatal("holder changed after a refused renewal")
	}
	h.fail.Store(false)
	for r.Renewals.Load() == 0 {
		if time.Now().After(deadline.Add(5 * time.Second)) {
			t.Fatal("never renewed after the hub came back")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// An expired certificate is a louder alarm: the hub will refuse it.
func TestRenewerExpiredAlarm(t *testing.T) {
	ca, _ := testpki.NewCA("hub-ca")
	old, _ := ca.Issue("cell-9", time.Second)
	holder, _ := NewCertHolder(old)
	logs := &syncBuf{}
	r := &Renewer{Holder: holder, Hub: "https://127.0.0.1:1", Roots: ca.Pool(), Log: slog.New(slog.NewJSONHandler(logs, nil)),
		Now: func() time.Time { return old.Leaf.NotAfter.Add(time.Minute) }, MinBackoff: time.Hour}
	ctx, cancel := context.WithCancel(context.Background())
	go r.Run(ctx)
	for r.Failures.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if !strings.Contains(logs.String(), `"msg":"cert.expired","alarm":true`) {
		t.Fatalf("log %s", logs.String())
	}
}

// M2: a certificate due for renewal the moment it arrives used to make the
// loop renew back to back, hammering the hub.
func TestRenewerBacksOffWhenTheNewCertificateIsAlreadyDue(t *testing.T) {
	ca, _ := testpki.NewCA("hub-ca")
	h := &renewHub{ca: ca, ttl: time.Second}
	_, url := startHub(t, h)
	old, _ := ca.Issue("cell-3", time.Second)
	holder, _ := NewCertHolder(old)
	dir := t.TempDir()
	r := &Renewer{Holder: holder, Hub: url, Roots: ca.Pool(), Log: slog.New(slog.NewJSONHandler(io.Discard, nil)),
		Paths:      Paths{Key: filepath.Join(dir, "key.pem"), Cert: filepath.Join(dir, "cert.pem")},
		MinBackoff: 200 * time.Millisecond, MaxBackoff: 200 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()
	r.Run(ctx)
	if n := h.serial.Load(); n > 6 {
		t.Fatalf("%d renewals in 700 ms: no backoff", n)
	}
	if r.Failures.Load() == 0 {
		t.Fatal("an already-due certificate was taken as a success")
	}
}
