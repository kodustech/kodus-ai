// Package localpki writes a cell host's local PKI (`cell local-pki`): what
// kodus-installer's cell-host.sh write_local_pki writes with openssl, for a
// cell whose image has no shell (the Kubernetes cell pod's init container).
//
// Three roots, each for one thing (docs/runtime/self-hosted.md): the hub's
// CA (written by `cell register`) pins the hub and signed this cell's
// identity; the cell-local CA signs the egress, injector and observer
// certificates and never a cell identity; the injector's own CA signs only
// the leaves machines see for a secret's host. The ed25519 policy key signs
// every egress policy; the enforcers hold its public half.
//
// Files that exist are kept (Rotate re-issues the leaves), so a restarted
// pod keeps the keys its enforcers already trust.
package localpki

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// Options names the identity the PKI is made for.
type Options struct {
	// Dir is where the files go (the cell's /etc/kodus/cell).
	Dir string
	// IdentityDir holds what `cell register` wrote: cert.pem (its CN is the
	// cell id) and issuer.pem (the CA the enforcers verify the agent with).
	IdentityDir string
	// Rotate re-issues the leaves; the CAs and the policy key stay.
	Rotate bool
	// Copies are files another process gave this one to read (a Kubernetes
	// Secret mounted group-readable), copied under Dir as 0600 and owned by
	// this process: the injector reads its OpenBao credentials only from a
	// file no group or other may read. Keyed by the destination, relative to
	// Dir; the value is the source path.
	Copies map[string]string
	Now    func() time.Time
}

// Result says what was written, by path relative to Dir.
type Result struct {
	CellID  string
	Written []string
}

const (
	caYears       = 10
	injectorYears = 5
	leafDays      = 397
)

// Write makes whatever of the PKI is missing under o.Dir.
func Write(o Options) (Result, error) {
	if o.Dir == "" || o.IdentityDir == "" {
		return Result{}, errors.New("localpki: dir and identity dir required")
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	w := &writer{dir: o.Dir, now: o.Now()}
	cellID, err := commonName(filepath.Join(o.IdentityDir, "cert.pem"))
	if err != nil {
		return Result{}, fmt.Errorf("localpki: the cell identity: %w", err)
	}
	issuer, err := os.ReadFile(filepath.Join(o.IdentityDir, "issuer.pem"))
	if err != nil {
		return Result{}, fmt.Errorf("localpki: the identity's issuer: %w", err)
	}
	for _, d := range []string{"", "egress", "injector", "observer-server"} {
		if err := os.MkdirAll(filepath.Join(o.Dir, d), 0o700); err != nil {
			return Result{}, err
		}
	}
	local, err := w.ca("local-ca.pem", "local-ca.key", "Kody Runtime cell-local CA", caYears)
	if err != nil {
		return Result{}, err
	}
	leaves := []struct {
		cert, key, ou, cn string
		eku               x509.ExtKeyUsage
		dns               []string
		ips               []net.IP
	}{
		{"egress/cert.pem", "egress/key.pem", "kodus-egress", "kodus-egress", x509.ExtKeyUsageServerAuth, []string{"kodus-egress"}, []net.IP{net.IPv4(127, 0, 0, 1)}},
		{"injector/cert.pem", "injector/key.pem", "kodus-injector", "kodus-injector", x509.ExtKeyUsageServerAuth, []string{"kodus-injector"}, []net.IP{net.IPv4(127, 0, 0, 1)}},
		{"observer-server/cert.pem", "observer-server/key.pem", "kodus-observer", "kodus-observer", x509.ExtKeyUsageServerAuth, []string{"kodus-observer"}, nil},
		{"observer-client-cert.pem", "observer-client-key.pem", "cell", cellID, x509.ExtKeyUsageClientAuth, nil, nil},
	}
	for _, l := range leaves {
		if err := w.leaf(local, l.cert, l.key, pkix.Name{Organization: []string{"kodus-runtime"}, OrganizationalUnit: []string{l.ou}, CommonName: l.cn}, l.eku, l.dns, l.ips, o.Rotate); err != nil {
			return Result{}, err
		}
	}
	pub, err := w.policyKey()
	if err != nil {
		return Result{}, err
	}
	if _, err := w.ca("injector/cell-ca.pem", "injector/cell-ca.key.pem", "Kody Runtime injector CA", injectorYears); err != nil {
		return Result{}, err
	}
	// The enforcers verify the agent's client certificate with the hub's
	// issuer and its policies with the public key; observers trust the
	// cell-local CA. Copied every run: they follow the identity.
	localPEM, err := os.ReadFile(filepath.Join(o.Dir, "local-ca.pem"))
	if err != nil {
		return Result{}, err
	}
	for path, b := range map[string][]byte{
		"egress/ca.pem": issuer, "injector/ca.pem": issuer,
		"egress/agent.pub.pem": pub, "injector/agent.pub.pem": pub,
		"observer-server/ca.pem": localPEM,
	} {
		if err := w.put(path, b, 0o644); err != nil {
			return Result{}, err
		}
	}
	for dst, src := range o.Copies {
		if !filepath.IsLocal(dst) {
			return Result{}, fmt.Errorf("localpki: copy destination %q is not under the directory", dst)
		}
		b, err := os.ReadFile(src) //nolint:gosec // G304: the operator's -copy source
		if err != nil {
			return Result{}, fmt.Errorf("localpki: copy %s: %w", src, err)
		}
		if err := os.MkdirAll(filepath.Dir(w.path(dst)), 0o700); err != nil {
			return Result{}, err
		}
		if err := w.put(dst, b, 0o600); err != nil {
			return Result{}, err
		}
		// put keeps an identical file with the mode it has.
		if err := os.Chmod(w.path(dst), 0o600); err != nil {
			return Result{}, err
		}
	}
	return Result{CellID: cellID, Written: w.written}, nil
}

type writer struct {
	dir     string
	now     time.Time
	written []string
}

func (w *writer) path(rel string) string { return filepath.Join(w.dir, rel) }

func exists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Size() > 0
}

// put writes b to rel unless it holds b already.
func (w *writer) put(rel string, b []byte, mode os.FileMode) error {
	p := w.path(rel)
	if cur, err := os.ReadFile(p); err == nil && bytes.Equal(cur, b) { //nolint:gosec // G304: under Dir
		return nil
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, mode); err != nil { //nolint:gosec // G703: rel is a constant of this package or a -copy destination Write checked with filepath.IsLocal
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		return err
	}
	w.written = append(w.written, rel)
	return nil
}

type authority struct {
	cert *x509.Certificate
	key  crypto.Signer
}

func newKey() (*ecdsa.PrivateKey, []byte, error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		return nil, nil, err
	}
	return k, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

func serial() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
}

// ca loads the CA at certRel/keyRel, or makes it.
func (w *writer) ca(certRel, keyRel, cn string, years int) (authority, error) {
	if exists(w.path(certRel)) && exists(w.path(keyRel)) {
		return loadAuthority(w.path(certRel), w.path(keyRel))
	}
	k, keyPEM, err := newKey()
	if err != nil {
		return authority{}, err
	}
	sn, err := serial()
	if err != nil {
		return authority{}, err
	}
	tpl := &x509.Certificate{
		SerialNumber: sn, Subject: pkix.Name{Organization: []string{"kodus-runtime"}, CommonName: cn},
		NotBefore: w.now.Add(-time.Minute), NotAfter: w.now.AddDate(years, 0, 0),
		IsCA: true, BasicConstraintsValid: true, MaxPathLen: 0, MaxPathLenZero: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		return authority{}, err
	}
	if err := w.put(keyRel, keyPEM, 0o600); err != nil {
		return authority{}, err
	}
	if err := w.put(certRel, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return authority{}, err
	}
	cert, err := x509.ParseCertificate(der)
	return authority{cert: cert, key: k}, err
}

func (w *writer) leaf(ca authority, certRel, keyRel string, subject pkix.Name, eku x509.ExtKeyUsage, dns []string, ips []net.IP, rotate bool) error {
	if !rotate && exists(w.path(certRel)) && exists(w.path(keyRel)) {
		return nil
	}
	k, keyPEM, err := newKey()
	if err != nil {
		return err
	}
	sn, err := serial()
	if err != nil {
		return err
	}
	tpl := &x509.Certificate{
		SerialNumber: sn, Subject: subject, NotBefore: w.now.Add(-time.Minute), NotAfter: w.now.AddDate(0, 0, leafDays),
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{eku},
		DNSNames: dns, IPAddresses: ips,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca.cert, &k.PublicKey, ca.key)
	if err != nil {
		return err
	}
	if err := w.put(keyRel, keyPEM, 0o600); err != nil {
		return err
	}
	return w.put(certRel, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644)
}

// policyKey loads or makes the ed25519 policy key and returns its public
// half (PEM).
func (w *writer) policyKey() ([]byte, error) {
	if exists(w.path("policy.key.pem")) {
		b, err := os.ReadFile(w.path("policy.key.pem"))
		if err != nil {
			return nil, err
		}
		blk, _ := pem.Decode(b)
		if blk == nil {
			return nil, errors.New("localpki: policy.key.pem holds no PEM")
		}
		k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
		if err != nil {
			return nil, err
		}
		ek, ok := k.(ed25519.PrivateKey)
		if !ok {
			return nil, errors.New("localpki: policy.key.pem is not ed25519")
		}
		return w.publicPEM(ek.Public())
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, err
	}
	if err := w.put("policy.key.pem", pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	return w.publicPEM(pub)
}

func (w *writer) publicPEM(pub crypto.PublicKey) ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return nil, err
	}
	b := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	return b, w.put("policy.pub.pem", b, 0o644)
}

func loadAuthority(certPath, keyPath string) (authority, error) {
	cb, err := os.ReadFile(certPath) //nolint:gosec // G304: under Dir
	if err != nil {
		return authority{}, err
	}
	kb, err := os.ReadFile(keyPath) //nolint:gosec // G304: under Dir
	if err != nil {
		return authority{}, err
	}
	cblk, _ := pem.Decode(cb)
	kblk, _ := pem.Decode(kb)
	if cblk == nil || kblk == nil {
		return authority{}, fmt.Errorf("localpki: %s or its key holds no PEM", certPath)
	}
	cert, err := x509.ParseCertificate(cblk.Bytes)
	if err != nil {
		return authority{}, err
	}
	var k any
	if kblk.Type == "EC PRIVATE KEY" {
		// SEC1, as Helm's genPrivateKey "ecdsa" and openssl ecparam write it.
		k, err = x509.ParseECPrivateKey(kblk.Bytes)
	} else {
		k, err = x509.ParsePKCS8PrivateKey(kblk.Bytes)
	}
	if err != nil {
		return authority{}, err
	}
	signer, ok := k.(crypto.Signer)
	if !ok {
		return authority{}, fmt.Errorf("localpki: %s is not a signing key", keyPath)
	}
	return authority{cert: cert, key: signer}, nil
}

func commonName(certPath string) (string, error) {
	b, err := os.ReadFile(certPath) //nolint:gosec // G304: the operator's identity directory
	if err != nil {
		return "", err
	}
	blk, _ := pem.Decode(b)
	if blk == nil {
		return "", errors.New("no PEM certificate")
	}
	c, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		return "", err
	}
	if c.Subject.CommonName == "" {
		return "", errors.New("the certificate has no CN")
	}
	return c.Subject.CommonName, nil
}

// Leaf is one certificate IssueLeaf makes.
type Leaf struct {
	CACert, CAKey string // the issuing CA's PEM files (PKCS#8 or SEC1 key)
	Subject       pkix.Name
	ClientAuth    bool // clientAuth instead of serverAuth
	DNS           []string
	Cert, Key     string // where the leaf and its new key go
	Now           func() time.Time
}

// IssueLeaf signs a new P-256 key with the CA, for a subject Helm cannot
// write: the runtime-worker's certificate must carry OU=worker (the hub's
// internal routes check it), and Helm's genSignedCert sets the CN only.
func IssueLeaf(l Leaf) error {
	if l.Now == nil {
		l.Now = time.Now
	}
	ca, err := loadAuthority(l.CACert, l.CAKey)
	if err != nil {
		return fmt.Errorf("localpki: the issuing CA: %w", err)
	}
	eku := x509.ExtKeyUsageServerAuth
	if l.ClientAuth {
		eku = x509.ExtKeyUsageClientAuth
	}
	w := &writer{now: l.Now()}
	return w.leaf(ca, l.Cert, l.Key, l.Subject, eku, l.DNS, nil, true)
}
