package main

import (
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

type rootsPKI struct {
	dir                   string
	hub, local, injector  *testpki.CA
	hubFile, localFile    string
	injectorFile, sameKey string
}

func newRootsPKI(t *testing.T) rootsPKI {
	t.Helper()
	p := rootsPKI{dir: t.TempDir()}
	var err error
	for _, ca := range []struct {
		dst  **testpki.CA
		file *string
		name string
	}{{&p.hub, &p.hubFile, "hub"}, {&p.local, &p.localFile, "local"}, {&p.injector, &p.injectorFile, "injector"}} {
		if *ca.dst, err = testpki.NewCA(ca.name); err != nil {
			t.Fatal(err)
		}
		*ca.file = p.write(t, ca.name+".pem", (*ca.dst).PEM)
	}
	// The hub CA re-issued on its own key: another certificate, the same root.
	tpl := &x509.Certificate{SerialNumber: big.NewInt(7), Subject: pkix.Name{CommonName: "hub, again"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &p.hub.Key.PublicKey, p.hub.Key)
	if err != nil {
		t.Fatal(err)
	}
	p.sameKey = p.write(t, "hub-again.pem", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	return p
}

func (p rootsPKI) write(t *testing.T, name string, b []byte) string {
	t.Helper()
	f := filepath.Join(p.dir, name)
	if err := os.WriteFile(f, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return f
}

// verifies says whether a server certificate issued by ca for 127.0.0.1
// passes with pool, as the agent's TLS client checks it.
func verifies(t *testing.T, ca *testpki.CA, pool *x509.CertPool) bool {
	t.Helper()
	c, err := ca.Issue("server", time.Hour, "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(c.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	_, err = leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: "127.0.0.1", KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
	return err == nil
}

// The agent takes an enforcer's certificate for its hub, or the hub's for an
// enforcer, never: each is verified with its own CA.
func TestTheHubAndTheEnforcersAreVerifiedWithTheirOwnCAOnly(t *testing.T) {
	p := newRootsPKI(t)
	r, err := loadRoots(rootFiles{Hub: p.hubFile, Local: p.localFile, CellCA: p.injectorFile}, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if !verifies(t, p.hub, r.Hub) || !verifies(t, p.local, r.Local) {
		t.Fatal("a peer of the right CA was refused")
	}
	if verifies(t, p.local, r.Hub) {
		t.Error("a cell-local certificate passes as the hub")
	}
	if verifies(t, p.hub, r.Local) {
		t.Error("the hub's certificate passes as an enforcer")
	}
	if verifies(t, p.injector, r.Hub) || verifies(t, p.injector, r.Local) {
		t.Error("an injector leaf passes as the hub or an enforcer")
	}
}

// The installer's old single trust.pem (hub CA and cell-local CA in one
// file) as -ca, a CA re-issued on the hub's key as -local-ca, and an
// injector CA that is one of the others: each refused at start, by name.
func TestTheCellRefusesTrustRootsThatShareAKey(t *testing.T) {
	p := newRootsPKI(t)
	bundle := p.write(t, "trust.pem", append(append([]byte{}, p.hub.PEM...), p.local.PEM...))
	cases := []struct {
		name  string
		files rootFiles
		want  string
	}{
		{"one pool for the hub and the enforcers", rootFiles{Hub: bundle, Local: p.localFile}, "share a CA key"},
		{"the hub CA re-issued on its key as the local CA", rootFiles{Hub: p.hubFile, Local: p.sameKey}, "share a CA key"},
		{"the injector CA is the hub CA", rootFiles{Hub: p.hubFile, Local: p.localFile, CellCA: p.hubFile}, "-cell-ca-cert is also -ca"},
		{"the injector CA is the local CA", rootFiles{Hub: p.hubFile, Local: p.localFile, CellCA: p.localFile}, "-cell-ca-cert is also -local-ca"},
		// -ca a separate chain for the hub's server certificate, the issuer the CA that signs cells.
		{"the injector CA is the issuer", rootFiles{Hub: p.localFile, Local: p.injectorFile, CellCA: p.sameKey, Issuer: p.hubFile}, "-cell-ca-cert is also -issuer"},
		{"the injector CA is the observer CA", rootFiles{Hub: p.hubFile, Local: p.localFile, CellCA: p.injectorFile, Observer: p.injectorFile}, "-cell-ca-cert is also -observer-ca"},
	}
	for _, c := range cases {
		if _, err := loadRoots(c.files, true, false); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want an error naming %q", c.name, err, c.want)
		}
	}
}

// A cell with enforcers needs the cell-local CA outside -dev; a dev cell
// keeps the single pool (one dev CA for everything), flagged as shared.
func TestEnforcersWithoutALocalCAOnlyInDev(t *testing.T) {
	p := newRootsPKI(t)
	if _, err := loadRoots(rootFiles{Hub: p.hubFile}, true, false); err == nil || !strings.Contains(err.Error(), "-local-ca is required") {
		t.Fatalf("enforcers without -local-ca: %v", err)
	}
	r, err := loadRoots(rootFiles{Hub: p.hubFile}, true, true)
	if err != nil || !r.Shared || !verifies(t, p.hub, r.Local) {
		t.Fatalf("dev cell: %+v %v", r, err)
	}
	if r, err := loadRoots(rootFiles{Hub: p.hubFile}, false, false); err != nil || r.Hub == nil {
		t.Fatalf("a cell without enforcers: %v", err)
	}
}
