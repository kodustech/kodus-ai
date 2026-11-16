package localpki

import (
	"bytes"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

// identity is what `cell register` leaves: the cell's certificate (CN the
// cell id) and the hub CA that issued it.
func identity(t *testing.T) (dir string, hub *testpki.CA) {
	t.Helper()
	hub, err := testpki.NewCA("Kody Runtime CA")
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := hub.Issue("cell-7", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	dir = t.TempDir()
	if err := hub.WriteFiles(dir, "", leaf); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "issuer.pem"), hub.PEM, 0o600); err != nil {
		t.Fatal(err)
	}
	return dir, hub
}

func cert(t *testing.T, path string) *x509.Certificate {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	blk, _ := pem.Decode(b)
	c, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// Every file cell-host.sh write_local_pki writes is there, and each
// enforcer gets the agent's issuer and the policy public key.
func TestWriteMakesTheCellHostsLocalPKI(t *testing.T) {
	id, hub := identity(t)
	dir := filepath.Join(t.TempDir(), "etc")
	res, err := Write(Options{Dir: dir, IdentityDir: id})
	if err != nil {
		t.Fatal(err)
	}
	if res.CellID != "cell-7" {
		t.Fatalf("cell id %q", res.CellID)
	}
	for _, f := range []string{
		"local-ca.pem", "local-ca.key", "policy.key.pem", "policy.pub.pem", "observer-client-cert.pem", "observer-client-key.pem",
		"egress/cert.pem", "egress/key.pem", "egress/ca.pem", "egress/agent.pub.pem",
		"injector/cert.pem", "injector/key.pem", "injector/ca.pem", "injector/agent.pub.pem", "injector/cell-ca.pem", "injector/cell-ca.key.pem",
		"observer-server/cert.pem", "observer-server/key.pem", "observer-server/ca.pem",
	} {
		if !exists(filepath.Join(dir, f)) {
			t.Errorf("%s missing", f)
		}
	}
	for _, f := range []string{"egress/ca.pem", "injector/ca.pem"} {
		if b, _ := os.ReadFile(filepath.Join(dir, f)); !bytes.Equal(b, hub.PEM) {
			t.Errorf("%s is not the identity's issuer", f)
		}
	}
	for _, f := range []string{"local-ca.key", "policy.key.pem", "egress/key.pem", "injector/key.pem", "injector/cell-ca.key.pem"} {
		if st, _ := os.Stat(filepath.Join(dir, f)); st.Mode().Perm() != 0o600 {
			t.Errorf("%s is %v, want 0600", f, st.Mode().Perm())
		}
	}
	if c := cert(t, filepath.Join(dir, "observer-client-cert.pem")); c.Subject.CommonName != "cell-7" {
		t.Errorf("observer client CN %q", c.Subject.CommonName)
	}
}

// The three roots share no key, the control certificates chain to the
// cell-local CA for 127.0.0.1 (where the agent dials them in its pod), and
// the policy public key is the signing key's.
func TestRootsStayApartAndLeavesVerify(t *testing.T) {
	id, hub := identity(t)
	dir := t.TempDir()
	if _, err := Write(Options{Dir: dir, IdentityDir: id}); err != nil {
		t.Fatal(err)
	}
	local := cert(t, filepath.Join(dir, "local-ca.pem"))
	injector := cert(t, filepath.Join(dir, "injector", "cell-ca.pem"))
	keys := map[string]string{}
	for name, c := range map[string]*x509.Certificate{"hub": hub.Cert, "local": local, "injector": injector} {
		k := string(c.RawSubjectPublicKeyInfo)
		if other, dup := keys[k]; dup {
			t.Fatalf("%s and %s share a key", name, other)
		}
		keys[k] = name
	}
	if !local.IsCA || !local.MaxPathLenZero {
		t.Fatal("the cell-local CA is not a CA with pathlen 0")
	}
	pool := x509.NewCertPool()
	pool.AddCert(local)
	for _, f := range []string{"egress/cert.pem", "injector/cert.pem"} {
		if _, err := cert(t, filepath.Join(dir, f)).Verify(x509.VerifyOptions{Roots: pool, DNSName: "127.0.0.1", KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
			t.Errorf("%s: %v", f, err)
		}
	}
	priv, err := tlsutil.PrivateKey(filepath.Join(dir, "policy.key.pem"))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"policy.pub.pem", "egress/agent.pub.pem", "injector/agent.pub.pem"} {
		pub, err := tlsutil.PublicKey(filepath.Join(dir, f))
		if err != nil {
			t.Fatal(err)
		}
		if !ed25519.Verify(pub, []byte("policy"), ed25519.Sign(priv, []byte("policy"))) {
			t.Errorf("%s is not the policy key's public half", f)
		}
	}
}

// A second run (a restarted pod) keeps every key; Rotate re-issues the
// leaves and keeps the CAs and the policy key.
func TestRerunKeepsKeysAndRotateReissuesLeaves(t *testing.T) {
	id, _ := identity(t)
	dir := t.TempDir()
	if _, err := Write(Options{Dir: dir, IdentityDir: id}); err != nil {
		t.Fatal(err)
	}
	read := func(f string) string { b, _ := os.ReadFile(filepath.Join(dir, f)); return string(b) }
	before := map[string]string{}
	for _, f := range []string{"local-ca.key", "policy.key.pem", "injector/cell-ca.key.pem", "egress/key.pem"} {
		before[f] = read(f)
	}
	res, err := Write(Options{Dir: dir, IdentityDir: id})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Written) != 0 {
		t.Fatalf("a second run rewrote %v", res.Written)
	}
	if _, err := Write(Options{Dir: dir, IdentityDir: id, Rotate: true}); err != nil {
		t.Fatal(err)
	}
	for f, b := range before {
		changed := read(f) != b
		if leaf := f == "egress/key.pem"; changed != leaf {
			t.Errorf("%s changed=%v after Rotate", f, changed)
		}
	}
}

// A credential mounted group-readable (a Kubernetes Secret with fsGroup)
// is copied as 0600, the only mode the injector reads its OpenBao
// credentials from; a destination outside the directory is refused.
func TestCopiesAreWrittenPrivate(t *testing.T) {
	id, _ := identity(t)
	src := filepath.Join(t.TempDir(), "injector-role-id")
	if err := os.WriteFile(src, []byte("role-1"), 0o440); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if _, err := Write(Options{Dir: dir, IdentityDir: id, Copies: map[string]string{"injector/openbao-injector-role-id": src}}); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dir, "injector", "openbao-injector-role-id")
	st, err := os.Stat(dst)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("%v %v", st, err)
	}
	if _, err := Write(Options{Dir: dir, IdentityDir: id, Copies: map[string]string{"../escape": src}}); err == nil {
		t.Fatal("a destination outside the directory")
	}
}

// Without the identity `cell register` writes there is nothing to make
// the PKI for.
func TestWriteNeedsTheIdentity(t *testing.T) {
	if _, err := Write(Options{Dir: t.TempDir(), IdentityDir: t.TempDir()}); err == nil {
		t.Fatal("no identity, no PKI")
	}
}

// The runtime-worker's certificate carries OU=worker and CN runtime-worker,
// client auth only, signed by the worker CA Helm made (its key is SEC1, as
// genPrivateKey "ecdsa" writes it): the hub's internal routes refused the
// chart's first worker certificate with 401, for want of the OU.
func TestIssueLeafForTheWorker(t *testing.T) {
	ca, err := testpki.NewCA("Kody Runtime worker CA")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	der, _ := x509.MarshalECPrivateKey(ca.Key)
	caKey := filepath.Join(dir, "worker-ca.key")
	caCert := filepath.Join(dir, "worker-ca.pem")
	_ = os.WriteFile(caKey, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o600)
	_ = os.WriteFile(caCert, ca.PEM, 0o600)
	out := filepath.Join(dir, "out")
	_ = os.MkdirAll(out, 0o700)
	err = IssueLeaf(Leaf{
		CACert: caCert, CAKey: caKey, Subject: pkix.Name{Organization: []string{"kodus-runtime"}, OrganizationalUnit: []string{"worker"}, CommonName: "runtime-worker"},
		ClientAuth: true, Cert: filepath.Join(out, "worker.pem"), Key: filepath.Join(out, "worker.key"),
	})
	if err != nil {
		t.Fatal(err)
	}
	c := cert(t, filepath.Join(out, "worker.pem"))
	if c.Subject.CommonName != "runtime-worker" || len(c.Subject.OrganizationalUnit) != 1 || c.Subject.OrganizationalUnit[0] != "worker" {
		t.Fatalf("subject %v", c.Subject)
	}
	if _, err := c.Verify(x509.VerifyOptions{Roots: ca.Pool(), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		t.Fatal(err)
	}
	if _, err := tls.LoadX509KeyPair(filepath.Join(out, "worker.pem"), filepath.Join(out, "worker.key")); err != nil {
		t.Fatal(err)
	}
}
