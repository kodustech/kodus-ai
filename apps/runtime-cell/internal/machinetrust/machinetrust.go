// Package machinetrust is what a claim's machines trust when the claim
// carries org secrets (docs/runtime/sandbox.md "Secrets: OpenBao"), and on
// every claim of a cell that inspects the recommended egress list over TLS
// (-egress-recommended with -cell-ca-cert). A request to a secret's or an
// inspected host goes to the injector, which terminates the machine's TLS
// with the cell CA. So the cell mounts, read-only into every machine of such
// a claim, a bundle of the public roots and the cell CA (BundleTarget) and
// the cell CA alone (CellCATarget), and points the usual variables at them
// (Env). Any other claim gets neither.
//
// The public roots come from the cell's own trust store (SystemRootFiles),
// read once when the cell starts, never from the network. The bundle holds
// certificates only: a key in the cell CA's file is refused, so the
// injector's key never reaches a machine.
package machinetrust

import (
	"bytes"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// Where the files are inside a machine, and the directory the cell keeps
// for them: a compose file may not mount anything under Dir.
const (
	Dir          = "/etc/kodus"
	BundleTarget = Dir + "/ca-bundle.pem"
	CellCATarget = Dir + "/cell-ca.pem"
	// SystemStoreTarget is the tool image's own system store (Debian's): a
	// code sandbox gets the bundle there too, for the tools that read only
	// the system store. Never in a compose service, whose image is the
	// repository's.
	SystemStoreTarget = "/etc/ssl/certs/ca-certificates.crt"
)

// EnvNames are the variables Env sets, in a fixed order. A secret may not
// be named after one (agent.secretNameRefused, libs/runtime/api/domain/secrets.ts),
// and in a compose service the cell's value replaces the file's and the
// recipe's.
var EnvNames = []string{"SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS"}

// Env points the variables at the two files, as a machine sees them:
// OpenSSL, Go, Python's ssl and curl read SSL_CERT_FILE; requests reads
// REQUESTS_CA_BUNDLE; curl also CURL_CA_BUNDLE; git GIT_SSL_CAINFO. Node
// keeps its own roots and adds NODE_EXTRA_CA_CERTS to them, so the cell CA
// alone is enough there.
func Env(bundle, cellCA string) map[string]string {
	return map[string]string{
		"SSL_CERT_FILE":       bundle,
		"REQUESTS_CA_BUNDLE":  bundle,
		"CURL_CA_BUNDLE":      bundle,
		"GIT_SSL_CAINFO":      bundle,
		"NODE_EXTRA_CA_CERTS": cellCA,
	}
}

// IsEnvName reports whether name is one of EnvNames.
func IsEnvName(name string) bool { return slices.Contains(EnvNames, name) }

// SystemRootFiles are where the cell looks for its own public roots, in
// order: Go's list for Linux, then /etc/ssl/cert.pem (Alpine, the BSDs).
var SystemRootFiles = []string{
	"/etc/ssl/certs/ca-certificates.crt",                // Debian, Ubuntu, Gentoo, distroless
	"/etc/pki/tls/certs/ca-bundle.crt",                  // Fedora, RHEL 6
	"/etc/ssl/ca-bundle.pem",                            // OpenSUSE
	"/etc/pki/tls/cacert.pem",                           // OpenELEC
	"/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", // CentOS, RHEL 7
	"/etc/ssl/cert.pem",                                 // Alpine
}

// ReadRoots reads the first of files that holds at least one certificate,
// and says which it was.
func ReadRoots(files []string) ([]byte, string, error) {
	for _, f := range files {
		b, err := os.ReadFile(f) //nolint:gosec // G304: a fixed system path or the operator's flag
		if err != nil {
			continue
		}
		if certs, _ := certificates(b); len(certs) > 0 {
			return b, f, nil
		}
	}
	return nil, "", fmt.Errorf("machinetrust: no public roots in %s", strings.Join(files, ", "))
}

// certificates are the CERTIFICATE blocks of b that parse, and what else b
// holds (other block types, unparsable certificates).
func certificates(b []byte) ([]*x509.Certificate, []string) {
	var out []*x509.Certificate
	var other []string
	for {
		var blk *pem.Block
		blk, b = pem.Decode(b)
		if blk == nil {
			return out, other
		}
		if blk.Type != "CERTIFICATE" {
			other = append(other, blk.Type)
			continue
		}
		c, err := x509.ParseCertificate(blk.Bytes)
		if err != nil {
			other = append(other, "unparsable CERTIFICATE")
			continue
		}
		out = append(out, c)
	}
}

func encode(certs ...*x509.Certificate) []byte {
	var buf bytes.Buffer
	for _, c := range certs {
		_ = pem.Encode(&buf, &pem.Block{Type: "CERTIFICATE", Bytes: c.Raw})
	}
	return buf.Bytes()
}

// Build makes the two files' contents: the bundle (every certificate of
// roots, then the cell CA) and the cell CA alone, both re-encoded from the
// certificates they parsed to. cellCA must be exactly one CA certificate and
// nothing else; roots must hold at least one certificate (an unparsable one
// is left out).
func Build(roots, cellCA []byte) (bundle, ca []byte, err error) {
	cas, other := certificates(cellCA)
	switch {
	case len(other) > 0:
		return nil, nil, fmt.Errorf("machinetrust: the cell CA file holds %s; give the certificate only (its key stays with the injector)", strings.Join(other, ", "))
	case len(cas) != 1:
		return nil, nil, fmt.Errorf("machinetrust: the cell CA file holds %d certificates, not one", len(cas))
	case !cas[0].IsCA || !cas[0].BasicConstraintsValid:
		return nil, nil, errors.New("machinetrust: the cell CA file's certificate is not a CA")
	}
	pub, _ := certificates(roots)
	if len(pub) == 0 {
		return nil, nil, errors.New("machinetrust: the public roots hold no certificate")
	}
	return encode(append(pub, cas[0])...), encode(cas[0]), nil
}

// Files are where the two files are on the cell's host, the sources of the
// machines' read-only mounts. The zero value: the cell mounts nothing.
type Files struct {
	Bundle, CellCA string
}

// Set reports whether both files are there to mount.
func (f Files) Set() bool { return f.Bundle != "" && f.CellCA != "" }

// SandboxMounts are a code sandbox's read-only binds, "host:machine": the
// two files, and the bundle over the tool image's system store.
func (f Files) SandboxMounts() []string {
	if !f.Set() {
		return nil
	}
	return []string{f.Bundle + ":" + BundleTarget, f.CellCA + ":" + CellCATarget, f.Bundle + ":" + SystemStoreTarget}
}

// Write builds the files (Build) and writes them into dir, made 0755 when
// missing: ca-bundle.pem and cell-ca.pem, 0644 (public certificates, read by
// the machines' users), each renamed in so a machine never mounts half a
// file.
func Write(dir string, roots, cellCA []byte) (Files, error) {
	bundle, ca, err := Build(roots, cellCA)
	if err != nil {
		return Files{}, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil { //nolint:gosec // G301: public certificates the machines' users read
		return Files{}, err
	}
	f := Files{Bundle: filepath.Join(dir, "ca-bundle.pem"), CellCA: filepath.Join(dir, "cell-ca.pem")}
	if err := writeFile(f.Bundle, bundle); err != nil {
		return Files{}, err
	}
	if err := writeFile(f.CellCA, ca); err != nil {
		return Files{}, err
	}
	return f, nil
}

func writeFile(p string, b []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(p), ".trust-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }() // gone once renamed in
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o644); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}
