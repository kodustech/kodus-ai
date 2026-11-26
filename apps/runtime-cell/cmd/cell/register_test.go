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
	// boundKey is what a fleet registration answers (the hub does for a fleet token).
	boundKey string
	fleet    bool
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
	answer := map[string]any{
		"ok": true, "cellId": cellID, "serial": tpl.SerialNumber.String(), "expiresAt": tpl.NotAfter.UTC().Format(time.RFC3339),
		"certificate":   string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		"caCertificate": string(h.ca.PEM),
	}
	if h.boundKey != "" && h.fleet {
		answer["boundKey"] = h.boundKey
	}
	_ = json.NewEncoder(w).Encode(answer)
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
		// As the hub: the token is bound to its topology; a cell that names
		// none gets the token's, one that names another is refused.
		if body["token"] != "tok-1" && body["token"] != "kcf_fleet-good" {
			http.Error(w, `{"ok":false,"error":"invalid_token"}`, http.StatusUnauthorized)
			return
		}
		if topo, named := body["topology"]; named && topo != "self_hosted" {
			http.Error(w, `{"code":"registration_refused","reason":"topology_mismatch"}`, http.StatusForbidden)
			return
		}
		h.fleet = strings.HasPrefix(body["token"], "kcf_")
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

	// A topology the token was not made for is refused.
	if code := runEnroll("register", []string{"-hub", srv.URL, "-token", "tok-1", "-topology", "hybrid", "-ca", caFile, "-out", out}, &stdout, &stderr); code == 0 {
		t.Fatal("registered with another topology than the token's")
	}

	// Without -topology the cell registers with the token's.
	stdout.Reset()
	stderr.Reset()
	if code := runEnroll("register", []string{"-hub", srv.URL, "-token", "tok-1", "-ca", caFile, "-out", out}, &stdout, &stderr); code != 0 {
		t.Fatalf("register: %s", stderr.String())
	}
	if strings.Contains(stdout.String()+stderr.String(), "PRIVATE KEY") {
		t.Fatal("key material printed")
	}
	// No topology is sent unless named: the token's applies.
	if got := fh.got[len(fh.got)-1]; len(got) != 2 || !strings.HasPrefix(got["csr"], "-----BEGIN CERTIFICATE REQUEST-----") {
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

// A restarted Kubernetes cell pod runs register again: with
// -if-unregistered it keeps the cell it has and spends no token (the hub
// would refuse the used token and the pod would never start again).
func TestRegisterIfUnregisteredKeepsTheCell(t *testing.T) {
	ca, err := testpki.NewCA("hub-test-ca")
	if err != nil {
		t.Fatal(err)
	}
	fh := &fakeEnrollHub{t: t, ca: ca}
	srv := httptest.NewUnstartedServer(fh)
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	serverCert, _ := ca.Issue("runtime-hub", time.Hour, "127.0.0.1")
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, MinVersion: tls.VersionTLS13}
	srv.StartTLS()
	defer srv.Close()
	dir := t.TempDir()
	caFile := filepath.Join(dir, "hub-ca.pem")
	if err := os.WriteFile(caFile, ca.PEM, 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "identity")
	args := []string{"-hub", srv.URL, "-token", "tok-1", "-ca", caFile, "-out", out, "-if-unregistered"}
	var stdout, stderr bytes.Buffer
	if code := runEnroll("register", args, &stdout, &stderr); code != 0 {
		t.Fatalf("first register: %s", stderr.String())
	}
	first, _ := os.ReadFile(filepath.Join(out, "cert.pem"))
	calls := len(fh.got)
	stdout.Reset()
	if code := runEnroll("register", args, &stdout, &stderr); code != 0 {
		t.Fatalf("second register: %s", stderr.String())
	}
	if len(fh.got) != calls || !strings.Contains(stdout.String(), "already registered") {
		t.Fatalf("the second run asked the hub again (%d calls): %s", len(fh.got), stdout.String())
	}
	if again, _ := os.ReadFile(filepath.Join(out, "cert.pem")); !bytes.Equal(first, again) {
		t.Fatal("the identity changed")
	}
}

func TestEnrollRefusesACertificateForAnotherKey(t *testing.T) {
	ca, _ := testpki.NewCA("hub-test-ca")
	other, _ := ca.Issue("cell-x", time.Hour)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "cellId": "cell-x",
			"certificate":   string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: other.Certificate[0]})),
			"caCertificate": string(ca.PEM), "expiresAt": "2030-01-01T00:00:00Z", "serial": "1",
		})
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
		t.Cleanup(srv.Close)
		endpoints = append(endpoints, control.Endpoint{Name: []string{"egress", "resolver"}[i], URL: srv.URL})
	}
	p := policyPusher{client: control.Pusher{Endpoints: endpoints, HTTP: &http.Client{}, Key: priv}, rules: agent.EgressRules{Base: []string{"registry.npmjs.org"}}}
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
	// The hub registered it as a customer cell: its hello must say customer
	// with no flag (the hub refuses an owner other than the registration's).
	if s.Owner != "customer" {
		t.Fatalf("a registered cell starts as owner %q, not customer", s.Owner)
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

// A fleet host (docs/runtime/host-providers.md §8.1) gets its single-use
// token, the hub URL and the hub CA in one bootstrap file the provider
// wrote; register reads it, registers as a Kodus cell and deletes it once
// the hub answered, so the token never stays on the host. A hub it could
// not reach keeps the file for the next attempt.
func TestRegisterFromABootstrapFileDeletesIt(t *testing.T) {
	ca, err := testpki.NewCA("hub-test-ca")
	if err != nil {
		t.Fatal(err)
	}
	fh := &fakeEnrollHub{t: t, ca: ca}
	srv := httptest.NewUnstartedServer(fh)
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	serverCert, _ := ca.Issue("runtime-hub", time.Hour, "127.0.0.1")
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, MinVersion: tls.VersionTLS13}
	srv.StartTLS()
	defer srv.Close()
	dir := t.TempDir()
	write := func(name, hub, token string) string {
		b, _ := json.Marshal(map[string]string{"hubUrl": hub, "hubCa": string(ca.PEM), "token": token})
		f := filepath.Join(dir, name)
		if err := os.WriteFile(f, b, 0o600); err != nil {
			t.Fatal(err)
		}
		return f
	}
	var stdout, stderr bytes.Buffer

	// -bootstrap names everything: with -token as well it is refused before anything is read.
	both := write("both.json", srv.URL, "kcf_fleet-good")
	if code := runEnroll("register", []string{"-bootstrap", both, "-token", "x", "-out", filepath.Join(dir, "both")}, &stdout, &stderr); code != 2 {
		t.Fatalf("-bootstrap with -token: code %d", code)
	}

	// A hub that is not reachable: nothing burned, the file stays for the next try.
	unreachable := write("down.json", "https://127.0.0.1:1", "kcf_fleet-good")
	if code := runEnroll("register", []string{"-bootstrap", unreachable, "-out", filepath.Join(dir, "down")}, &stdout, &stderr); code == 0 {
		t.Fatal("registered with no hub")
	}
	if _, err := os.Stat(unreachable); err != nil {
		t.Fatalf("bootstrap file removed although the hub was never reached: %v", err)
	}

	// A token the hub refuses is burned: the file goes.
	refused := write("refused.json", srv.URL, "kcf_fleet-bad")
	if code := runEnroll("register", []string{"-bootstrap", refused, "-out", filepath.Join(dir, "refused")}, &stdout, &stderr); code == 0 {
		t.Fatal("registered with a refused token")
	}
	if _, err := os.Stat(refused); !os.IsNotExist(err) {
		t.Fatalf("bootstrap file kept after the hub refused its token: %v", err)
	}

	good := write("kodus-enroll.json", srv.URL, "kcf_fleet-good")
	out := filepath.Join(dir, "cell")
	stdout.Reset()
	stderr.Reset()
	if code := runEnroll("register", []string{"-bootstrap", good, "-out", out}, &stdout, &stderr); code != 0 {
		t.Fatalf("register -bootstrap: %s", stderr.String())
	}
	if _, err := os.Stat(good); !os.IsNotExist(err) {
		t.Fatalf("bootstrap file kept after registration: %v", err)
	}
	if got := fh.got[len(fh.got)-1]; got["token"] != "kcf_fleet-good" {
		t.Fatalf("register body %v", got)
	}
	if b, _ := os.ReadFile(filepath.Join(out, "ca.pem")); !bytes.Equal(b, ca.PEM) {
		t.Fatal("ca.pem is not the bootstrap's hub CA")
	}
	if b, _ := os.ReadFile(filepath.Join(out, "owner")); string(b) != "kodus\n" {
		t.Fatalf("a fleet cell's owner file says %q", b)
	}
	if strings.Contains(stdout.String()+stderr.String(), "kcf_fleet-good") {
		t.Fatal("token printed")
	}
}

// A fleet host learns which key the hub bound it to, from the hub's answer,
// and a registration that carries none removes what a template left behind.
func TestFleetRegistrationWritesTheBoundKeyTheHubAnswered(t *testing.T) {
	ca, err := testpki.NewCA("hub-test-ca")
	if err != nil {
		t.Fatal(err)
	}
	fh := &fakeEnrollHub{t: t, ca: ca, boundKey: "run:org-1/run-9"}
	srv := httptest.NewUnstartedServer(fh)
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	serverCert, _ := ca.Issue("runtime-hub", time.Hour, "127.0.0.1")
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}, MinVersion: tls.VersionTLS13}
	srv.StartTLS()
	defer srv.Close()
	dir := t.TempDir()
	out := filepath.Join(dir, "cell")
	bootstrap := func() string {
		b, _ := json.Marshal(map[string]string{"hubUrl": srv.URL, "hubCa": string(ca.PEM), "token": "kcf_fleet-good"})
		f := filepath.Join(dir, "kodus-enroll.json")
		if err := os.WriteFile(f, b, 0o600); err != nil {
			t.Fatal(err)
		}
		return f
	}
	var stdout, stderr bytes.Buffer
	if code := runEnroll("register", []string{"-bootstrap", bootstrap(), "-out", out}, &stdout, &stderr); code != 0 {
		t.Fatalf("register: %s", stderr.String())
	}
	if b, _ := os.ReadFile(filepath.Join(out, "bound-key")); string(b) != "run:org-1/run-9\n" {
		t.Fatalf("bound-key says %q", b)
	}
	// A second registration on the same disk (a host made from a template)
	// whose token has no key: the old file does not survive.
	fh.boundKey = ""
	if code := runEnroll("register", []string{"-bootstrap", bootstrap(), "-out", out}, &stdout, &stderr); code != 0 {
		t.Fatalf("register again: %s", stderr.String())
	}
	if _, err := os.Stat(filepath.Join(out, "bound-key")); !os.IsNotExist(err) {
		t.Fatalf("a stale bound-key survived a registration without one: %v", err)
	}
}

// Bakes are adopted only on a Kodus fleet host, for the org its hub-given key names.
func TestBakeAdoptOrgNeedsAFleetHostAndAHubGivenKey(t *testing.T) {
	dir := t.TempDir()
	cert := filepath.Join(dir, "cert.pem")
	unit := filepath.Join(dir, "kodus-cell-seal.service")
	key := func(v string) {
		if err := os.WriteFile(boundKeyFile(cert), []byte(v), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	key("run:org-1/run-9\n")
	if got := bakeAdoptOrg(unit, cert, "kodus"); got != "" {
		t.Fatalf("a host without the seal unit adopted for %q", got)
	}
	if err := os.WriteFile(unit, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := bakeAdoptOrg(unit, cert, "kodus"); got != "org-1" {
		t.Fatalf("a fleet host serving a Run: org %q", got)
	}
	if got := bakeAdoptOrg(unit, cert, "customer"); got != "" {
		t.Fatalf("a customer cell adopted for %q", got)
	}
	key("template:org-2/env-1\n")
	if got := bakeAdoptOrg(unit, cert, "kodus"); got != "org-2" {
		t.Fatalf("a template host: org %q", got)
	}
	// A suite shard's host (the spec listing, a shard, the fresh and main re-run hosts) starts from the template too: without
	// the catalog every shard built the environment cold.
	key("suite:org-3/suite-run-1/2\n")
	if got := bakeAdoptOrg(unit, cert, "kodus"); got != "org-3" {
		t.Fatalf("a suite shard host: org %q", got)
	}
	for _, bad := range []string{"", "org-1/run", "run:/run", "run:org-1/a/b", "x:org-1/run", "run:org 1/run", "suite:org-1/run", "suite:org-1/run/x", "suite:/run/1", "suite:org-1/run/1/2", "template:org-1/env/1"} {
		key(bad)
		if got := bakeAdoptOrg(unit, cert, "kodus"); got != "" {
			t.Fatalf("key %q adopted for %q", bad, got)
		}
	}
	if err := os.Remove(boundKeyFile(cert)); err != nil {
		t.Fatal(err)
	}
	if got := bakeAdoptOrg(unit, cert, "kodus"); got != "" {
		t.Fatalf("no key file adopted for %q", got)
	}
}
