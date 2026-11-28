package enrollment

import (
	"crypto/ecdsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Paths are the cell's identity files: the files the cell dials the hub with
// (-key, -cert, -ca) and the issuer its renewals must chain to.
type Paths struct {
	Key, Cert string
	// CA verifies the hub's server certificate: the operator's file, never
	// written from a hub answer after register copied it in place.
	CA string
	// Issuer is the CA that signed the cell's certificate (from register).
	Issuer string
}

// WriteIdentity writes a new key and certificate so that no crash leaves a
// key without its certificate. The key file holds the key and its
// certificate together and is renamed in first; the certificate file
// follows. Whatever the crash point, LoadIdentity finds a matching pair: the
// two files, or the key file alone. Each file is written to a temp file,
// synced and renamed, and the directory synced. With Key and Cert the same
// path it is one file and one rename.
func WriteIdentity(p Paths, key *ecdsa.PrivateKey, got *Issued) error {
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: got.Leaf.Raw})
	bundle := append(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), certPEM...)
	if err := replaceFile(p.Key, bundle, 0o600); err != nil {
		return fmt.Errorf("key: %w", err)
	}
	if p.Cert != "" && p.Cert != p.Key {
		if err := replaceFile(p.Cert, certPEM, 0o644); err != nil {
			return fmt.Errorf("certificate: %w", err)
		}
	}
	if p.Issuer != "" && got.Issuer != nil {
		if err := replaceFile(p.Issuer, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: got.Issuer.Raw}), 0o644); err != nil {
			return fmt.Errorf("issuer: %w", err)
		}
	}
	return nil
}

// WriteHubCA pins the hub CA the operator gave register.
func WriteHubCA(path string, pemBytes []byte) error {
	if path == "" {
		return nil
	}
	return replaceFile(path, pemBytes, 0o644)
}

// LoadIdentity loads the cell's key pair: the certificate and key files, or,
// when they do not match (a crash between the two renames of
// WriteIdentity), the key file alone, which carries its certificate.
func LoadIdentity(certFile, keyFile string) (tls.Certificate, error) {
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err == nil {
		return pair, nil
	}
	b, rerr := os.ReadFile(keyFile) //nolint:gosec // G304: keyFile is the cell's identity path from its own config
	if rerr != nil {
		return tls.Certificate{}, err
	}
	bundled, berr := tls.X509KeyPair(b, b)
	if berr != nil {
		return tls.Certificate{}, err
	}
	return bundled, nil
}

// ErrNoIssuer means a renewal has no pinned issuer to check the hub's answer
// against. Trusting the CA the answer carries would let whoever answers the
// renewal pick the cell's issuer, so the renewal fails; the cell registers
// again instead.
var ErrNoIssuer = errors.New("enrollment: no pinned issuer (issuer.pem): register the cell again")

// readIssuer is the issuer pinned at register. A renewal never goes on
// without one.
func (p Paths) readIssuer() (*x509.Certificate, error) {
	if p.Issuer == "" {
		return nil, ErrNoIssuer
	}
	b, err := os.ReadFile(p.Issuer)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("%w: %s is missing", ErrNoIssuer, p.Issuer)
	}
	if err != nil {
		return nil, err
	}
	c, err := ParseCertPEM(string(b))
	if err != nil {
		return nil, fmt.Errorf("issuer %s: %w", p.Issuer, err)
	}
	return c, nil
}

func replaceFile(name string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(name)+".*")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(data)
	serr := tmp.Sync()
	cerr := tmp.Close()
	if err := errors.Join(werr, serr, cerr, os.Chmod(tmp.Name(), mode)); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), name); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if d, err := os.Open(dir); err == nil { //nolint:gosec // G304: dir is the parent of the cell's own identity file, opened to fsync it
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
