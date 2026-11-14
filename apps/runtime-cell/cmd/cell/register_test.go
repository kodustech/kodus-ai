package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/egress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/enrollment"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// fakeEnrollHub signs CSRs with a test CA the way the hub is expected to.
type fakeEnrollHub struct {
	t      *testing.T
	ca     *testpki.CA
	serial int64
	got    []map[string]string
}

func (h *fakeEnrollHub) sign(w http.ResponseWriter, csrPEM, cellID string) {
	blk, _ := pem.Decode([]byte(csrPEM))
	if blk == nil || blk.Type != "CERTIFICATE REQUEST" {
		http.Error(w, "bad csr", http.StatusBadRequest)
		return
	}
	csr, err := x509.ParseCertificateRequest(blk.Bytes)
	if err != nil || csr.CheckSignature() != nil || csr.Subject.CommonName != "pending" {
		http.Error(w, "bad csr", http.StatusBadRequest)
		return
	}
	h.serial++
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(h.serial), Subject: pkix.Name{CommonName: cellID},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, h.ca.Cert, csr.PublicKey, h.ca.Key)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok": true, "cellId": cellID, "serial": tpl.SerialNumber.String(), "expiresAt": tpl.NotAfter.UTC().Format(time.RFC3339),
		"certificate":   string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		"caCertificate": string(h.ca.PEM),
	})
}

func (h *fakeEnrollHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body map[string]string
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h.got = append(h.got, body)
	switch r.URL.Path {
	case "/cells/register":
		if len(r.TLS.PeerCertificates) != 0 {
			http.Error(w, "register takes no client certificate", http.StatusBadRequest)
			return
		}
		if body["token"] != "tok-1" || body["topology"] != "single-vm" {
			http.Error(w, `{"ok":false,"error":"invalid_token"}`, http.StatusUnauthorized)
			return
		}
		h.sign(w, body["csr"], "cell-new")
	case "/cells/renew":
		if len(r.TLS.PeerCertificates) == 0 {
			http.Error(w, "mTLS required", http.StatusUnauthorized)
			return
		}
		h.sign(w, body["csr"], r.TLS.PeerCertificates[0].Subject.CommonName)
	default:
		http.NotFound(w, r)
	}
}

func TestRegisterAndRenew(t *testing.T) {
	ca, err := testpki.NewCA("hub-test-ca")
	if err != nil {
		t.Fatal(err)
	}
	fh := &fakeEnrollHub{t: t, ca: ca}
	srv := httptest.NewUnstartedServer(fh)
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	serverCert, _ := ca.Issue("runtime-hub", time.Hour, "127.0.0.1")
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientCAs: ca.Pool(), ClientAuth: tls.VerifyClientCertIfGiven, MinVersion: tls.VersionTLS13}
	srv.StartTLS()
	defer srv.Close()

	dir := t.TempDir()
	caFile := filepath.Join(dir, "bootstrap-ca.pem")
	if err := os.WriteFile(caFile, ca.PEM, 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "cell")

	// A wrong token writes nothing.
	var stdout, stderr bytes.Buffer
	if code := runEnroll("register", []string{"-hub", srv.URL, "-token", "nope", "-ca", caFile, "-out", out}, &stdout, &stderr); code == 0 {
		t.Fatal("registered with a bad token")
	}
	if _, err := os.Stat(filepath.Join(out, "key.pem")); err == nil {
		t.Fatal("key written after a refused registration")
	}

	stdout.Reset()
	stderr.Reset()
	if code := runEnroll("register", []string{"-hub", srv.URL, "-token", "tok-1", "-ca", caFile, "-out", out}, &stdout, &stderr); code != 0 {
		t.Fatalf("register: %s", stderr.String())
	}
	if strings.Contains(stdout.String()+stderr.String(), "PRIVATE KEY") {
		t.Fatal("key material printed")
	}
	if got := fh.got[len(fh.got)-1]; len(got) != 3 || !strings.HasPrefix(got["csr"], "-----BEGIN CERTIFICATE REQUEST-----") {
		t.Fatalf("register body %v", got)
	}
	if fi, err := os.Stat(filepath.Join(out, "key.pem")); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("key.pem mode: %v %v", fi, err)
	}
	pair, err := tls.LoadX509KeyPair(filepath.Join(out, "cert.pem"), filepath.Join(out, "key.pem"))
	if err != nil {
		t.Fatalf("cert and key do not match: %v", err)
	}
	// The cell id is the certificate's CN; ca.pem is the hub CA the
	// operator gave (-ca), issuer.pem the CA that signed the cell.
	if leaf, _ := x509.ParseCertificate(pair.Certificate[0]); leaf.Subject.CommonName != "cell-new" {
		t.Fatalf("cell CN %q", leaf.Subject.CommonName)
	}
	if b, _ := os.ReadFile(filepath.Join(out, "ca.pem")); !bytes.Equal(b, ca.PEM) {
		t.Fatal("ca.pem")
	}
	if b, _ := os.ReadFile(filepath.Join(out, "issuer.pem")); !bytes.Contains(b, []byte("BEGIN CERTIFICATE")) {
		t.Fatal("issuer.pem not written")
	}

	// renew over mTLS with the cert just written; the hub keeps the cell id.
	stdout.Reset()
	stderr.Reset()
	if code := runEnroll("renew", []string{"-hub", srv.URL, "-ca", caFile, "-out", out}, &stdout, &stderr); code != 0 {
		t.Fatalf("renew: %s", stderr.String())
	}
	if got := fh.got[len(fh.got)-1]; len(got) != 1 || got["csr"] == "" {
		t.Fatalf("renew body %v", got)
	}
	renewed, err := tls.LoadX509KeyPair(filepath.Join(out, "cert.pem"), filepath.Join(out, "key.pem"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(renewed.Certificate[0], pair.Certificate[0]) {
		t.Fatal("renew kept the old certificate")
	}
	leaf, _ := x509.ParseCertificate(renewed.Certificate[0])
	if leaf.Subject.CommonName != "cell-new" || leaf.SerialNumber.Int64() != 2 {
		t.Fatalf("renewed %s serial %s", leaf.Subject.CommonName, leaf.SerialNumber)
	}
}

func TestEnrollRefusesACertificateForAnotherKey(t *testing.T) {
	ca, _ := testpki.NewCA("hub-test-ca")
	other, _ := ca.Issue("cell-x", time.Hour)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "cellId": "cell-x",
			"certificate":   string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: other.Certificate[0]})),
			"caCertificate": string(ca.PEM), "expiresAt": "2030-01-01T00:00:00Z", "serial": "1"})
	}))
	defer srv.Close()
	key, _, _ := enrollment.NewKeyAndCSR()
	if _, err := enrollment.RequestCertificate(context.Background(), srv.Client(), srv.URL, "/cells/register", registerRequest{}, key, nil); err == nil || !strings.Contains(err.Error(), "not for the key") {
		t.Fatalf("enroll: %v", err)
	}
	if _, err := enrollment.RequestCertificate(context.Background(), srv.Client(), "http://"+strings.TrimPrefix(srv.URL, "https://"), "/cells/register", registerRequest{}, key, nil); err == nil {
		t.Fatal("enrolled over plain http")
	}
}

// The pushed policy is base ∪ the hub's extra allowlist, and a later
// egress.policy replaces it on the proxy and the resolver.
func TestPolicyPusherUnionAndRepush(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	stores := []*policy.Store{policy.NewStore(nil), policy.NewStore(nil)}
	var endpoints []control.Endpoint
	for i, s := range stores {
		srv := httptest.NewServer((&egress.Control{Policies: s, Events: egress.NewEvents(1), AgentKey: pub}).Handler())
		defer srv.Close()
		endpoints = append(endpoints, control.Endpoint{Name: []string{"egress", "resolver"}[i], URL: srv.URL})
	}
	p := policyPusher{client: control.Pusher{Endpoints: endpoints, HTTP: &http.Client{}, Key: priv}, base: []string{"registry.npmjs.org"}}
	info := agent.ClaimInfo{
		ClaimID:  "claim-1",
		Acquire:  protocol.ClaimAcquireBody{OrgID: "org-a", Side: protocol.SidePr, HardExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339)},
		Workload: driver.MachineRef{PrivateAddress: "10.0.0.5"}, Observer: driver.MachineRef{PrivateAddress: "10.0.0.6"},
		Sources:    []string{"172.30.0.2"}, // a compose container (docker-gvisor)
		ExtraAllow: []string{"api.stripe.com", "registry.npmjs.org"},
	}
	check := func(want ...string) {
		t.Helper()
		for _, s := range stores {
			got, ok := s.ForSource(net.ParseIP("10.0.0.5"))
			if !ok || strings.Join(got.Allow, ",") != strings.Join(want, ",") {
				t.Fatalf("allow %v, want %v", got.Allow, want)
			}
		}
	}
	if err := p.Apply(context.Background(), info); err != nil {
		t.Fatal(err)
	}
	check("api.stripe.com", "registry.npmjs.org")
	// The compose container's traffic is the claim's too.
	for _, s := range stores {
		if got, ok := s.ForSource(net.ParseIP("172.30.0.2")); !ok || got.ClaimID != "claim-1" {
			t.Fatalf("compose source not in the policy: %+v %v", got, ok)
		}
	}
	info.ExtraAllow = []string{"files.example.com"}
	if err := p.Apply(context.Background(), info); err != nil {
		t.Fatal(err)
	}
	check("files.example.com", "registry.npmjs.org")
}

// register -config writes where the cell then reads: the config file's tls
// paths feed both "cell register" and the -cert/-key/-ca the cell dials with.
func TestRegisterWritesTheConfigTLSPaths(t *testing.T) {
	ca, err := testpki.NewCA("hub-test-ca")
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(&fakeEnrollHub{t: t, ca: ca})
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	serverCert, _ := ca.Issue("runtime-hub", time.Hour, "127.0.0.1")
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientCAs: ca.Pool(), ClientAuth: tls.VerifyClientCertIfGiven, MinVersion: tls.VersionTLS13}
	srv.StartTLS()
	defer srv.Close()

	dir := t.TempDir()
	bootstrap := filepath.Join(dir, "bootstrap-ca.pem")
	if err := os.WriteFile(bootstrap, ca.PEM, 0o644); err != nil {
		t.Fatal(err)
	}
	pki := filepath.Join(dir, "pki")
	conf := filepath.Join(dir, "cell.json")
	body := `{"hubUrl":"wss://` + strings.TrimPrefix(srv.URL, "https://") + `/cells","driver":"fake",` +
		`"tls":{"ca":"` + pki + `/ca.pem","cert":"` + pki + `/cert.pem","key":"` + pki + `/key.pem"}}`
	if err := os.WriteFile(conf, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if code := runEnroll("register", []string{"-config", conf, "-token", "tok-1", "-ca", bootstrap}, &stdout, &stderr); code != 0 {
		t.Fatalf("register: %s", stderr.String())
	}
	s, err := parse(t, "-config", conf)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tls.LoadX509KeyPair(s.Cert, s.Key); err != nil {
		t.Fatalf("the cell cannot load what register wrote: %v", err)
	}
	if b, _ := os.ReadFile(s.CA); !bytes.Equal(b, ca.PEM) {
		t.Fatal("ca not at the config's tls.ca")
	}
	// renew finds everything from the same file.
	if code := runEnroll("renew", []string{"-config", conf}, &stdout, &stderr); code != 0 {
		t.Fatalf("renew: %s", stderr.String())
	}
}

func TestHTTPSBase(t *testing.T) {
	if got, err := enrollment.HTTPSBase("wss://localhost:3410/cells"); err != nil || got != "https://localhost:3410" {
		t.Fatalf("%q %v", got, err)
	}
	if _, err := enrollment.HTTPSBase("ws://x/cells"); err == nil {
		t.Fatal("plaintext hub accepted")
	}
}
