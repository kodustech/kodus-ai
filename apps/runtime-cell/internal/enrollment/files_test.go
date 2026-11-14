package enrollment

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/tls"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

func issued(t *testing.T, ca *testpki.CA, cn string) (*ecdsa.PrivateKey, *Issued) {
	t.Helper()
	c, err := ca.Issue(cn, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return c.PrivateKey.(*ecdsa.PrivateKey), &Issued{Leaf: c.Leaf, Issuer: ca.Cert}
}

// H7: the key and the certificate were renamed one after the other; a crash
// between them left a new key next to the old certificate, and the cell
// could not load its identity at the next boot.
func TestIdentitySurvivesACrashBetweenTheRenames(t *testing.T) {
	ca, _ := testpki.NewCA("issuer")
	dir := t.TempDir()
	p := Paths{Key: filepath.Join(dir, "key.pem"), Cert: filepath.Join(dir, "cert.pem"), Issuer: filepath.Join(dir, "issuer.pem")}
	keyA, a := issued(t, ca, "cell-1")
	if err := WriteIdentity(p, keyA, a); err != nil {
		t.Fatal(err)
	}
	// The crash: the new key file is in, the certificate file is still A's.
	keyB, b := issued(t, ca, "cell-1")
	if err := WriteIdentity(Paths{Key: p.Key}, keyB, b); err != nil {
		t.Fatal(err)
	}
	if _, err := tls.LoadX509KeyPair(p.Cert, p.Key); err == nil {
		t.Fatal("test setup: the files should not match")
	}
	got, err := LoadIdentity(p.Cert, p.Key)
	if err != nil {
		t.Fatalf("identity lost after the crash: %v", err)
	}
	if !bytes.Equal(got.Certificate[0], b.Leaf.Raw) {
		t.Fatal("loaded a pair that is not the newest consistent one")
	}
	if fi, _ := os.Stat(p.Key); fi.Mode().Perm() != 0o600 {
		t.Fatalf("key file mode %v", fi.Mode())
	}
	if cert, _ := os.ReadFile(p.Cert); strings.Contains(string(cert), "PRIVATE KEY") {
		t.Fatal("the certificate file carries the key")
	}
}

// M1: a renewal must chain to the issuer pinned at register, and never
// rewrite the hub CA the operator gave.
func TestRenewKeepsTheHubCAAndRefusesAnotherIssuer(t *testing.T) {
	pinned, _ := testpki.NewCA("issuer")
	h := &renewHub{ca: pinned, ttl: 24 * time.Hour}
	_, url := startHub(t, h)
	dir := t.TempDir()
	p := Paths{Key: filepath.Join(dir, "key.pem"), Cert: filepath.Join(dir, "cert.pem"), CA: filepath.Join(dir, "ca.pem"), Issuer: filepath.Join(dir, "issuer.pem")}
	hubCA := []byte("operator hub CA\n")
	if err := os.WriteFile(p.CA, hubCA, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.Issuer, pinned.PEM, 0o644); err != nil {
		t.Fatal(err)
	}
	cur, _ := pinned.Issue("cell-1", time.Hour)
	tlsCfg := &tls.Config{Certificates: []tls.Certificate{cur}, RootCAs: pinned.Pool()}
	if _, _, err := Renew(context.Background(), url, tlsCfg, "cell-1", p); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p.CA); !bytes.Equal(b, hubCA) {
		t.Fatalf("renewal rewrote the hub CA: %q", b)
	}
	// The hub now signs with another CA (and sends it along): refused.
	rogue, _ := testpki.NewCA("rogue")
	h.ca = rogue
	if _, _, err := Renew(context.Background(), url, tlsCfg, "cell-1", p); err == nil || !strings.Contains(err.Error(), "pinned issuer") {
		t.Fatalf("renewal from another issuer: %v", err)
	}
	if b, _ := os.ReadFile(p.Issuer); !bytes.Equal(b, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: pinned.Cert.Raw})) {
		t.Fatal("the pinned issuer changed")
	}
}
