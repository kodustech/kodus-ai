// Package enrollment is how a cell gets and keeps its short client
// certificate (ADR-054): a key made on the cell (it never leaves), a CSR,
// and the hub's answer checked and written so that a crash never leaves a
// key without its certificate. "cell register" and "cell renew" use it, and
// so does the agent's renewal loop (Renewer), over the same mTLS path as
// "cell renew". Nothing here prints key material.
//
// Two CAs, two files, never mixed:
//   - the hub CA (Paths.CA) verifies the hub's server certificate. The
//     operator supplies it at register; the cell never takes it from the
//     hub's answer.
//   - the issuer (Paths.Issuer) signed the cell's client certificate. It
//     comes from the register answer, and every renewal must chain to it.
package enrollment

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// CertificateResponse is the hub's answer to /cells/register and
// /cells/renew.
type CertificateResponse struct {
	OK            bool   `json:"ok"`
	CellID        string `json:"cellId"`
	Certificate   string `json:"certificate"`
	CACertificate string `json:"caCertificate"`
	ExpiresAt     string `json:"expiresAt"`
	Serial        string `json:"serial"`
}

// clockSkew is how far a certificate's NotBefore may be ahead of this clock.
const clockSkew = 5 * time.Minute

// NewKeyAndCSR makes the cell's ECDSA P-256 key and a CSR for it. The CN
// is "pending": the hub names the cell.
func NewKeyAndCSR() (*ecdsa.PrivateKey, []byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "pending"}}, key)
	if err != nil {
		return nil, nil, err
	}
	return key, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}), nil
}

// HTTPClient is the HTTPS client of an enrollment call (no HTTP/2, 30 s).
func HTTPClient(cfg *tls.Config) *http.Client {
	return &http.Client{Transport: &http.Transport{TLSClientConfig: cfg, ForceAttemptHTTP2: false}, Timeout: 30 * time.Second}
}

// Issued is a checked answer: the certificate for our key and the CA that
// signed it.
type Issued struct {
	Response *CertificateResponse
	Leaf     *x509.Certificate
	Issuer   *x509.Certificate
}

// RequestCertificate posts the CSR and checks the answer: a client
// certificate for our key, valid now, naming the cell, and signed by issuer
// when one is pinned (a renewal), else by the CA it came with (register:
// the TLS session to the hub was verified with the operator's hub CA).
func RequestCertificate(ctx context.Context, hc *http.Client, hub, path string, body any, key *ecdsa.PrivateKey, issuer *x509.Certificate) (*Issued, error) {
	u, err := url.Parse(strings.TrimRight(hub, "/"))
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, fmt.Errorf("-hub must be https://host:port, got %q", hub)
	}
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String()+path, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		msg, _ := redact.Clip(strings.TrimSpace(string(data)), 512)
		return nil, fmt.Errorf("%s: %s: %s", path, resp.Status, msg)
	}
	var res CertificateResponse
	if err := json.Unmarshal(data, &res); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if !res.OK || res.CellID == "" {
		return nil, fmt.Errorf("%s: hub answered without ok and cellId", path)
	}
	cert, err := ParseCertPEM(res.Certificate)
	if err != nil {
		return nil, fmt.Errorf("certificate: %w", err)
	}
	sentCA, err := ParseCertPEM(res.CACertificate)
	if err != nil {
		return nil, fmt.Errorf("caCertificate: %w", err)
	}
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok || !pub.Equal(&key.PublicKey) {
		return nil, errors.New("certificate is not for the key this cell made")
	}
	signer := sentCA
	if issuer != nil {
		signer = issuer
	}
	if err := cert.CheckSignatureFrom(signer); err != nil {
		if issuer != nil {
			return nil, fmt.Errorf("certificate is not signed by the pinned issuer: %w", err)
		}
		return nil, fmt.Errorf("certificate is not signed by caCertificate: %w", err)
	}
	if cert.Subject.CommonName != res.CellID {
		return nil, fmt.Errorf("certificate CN %q is not the cellId %q", cert.Subject.CommonName, res.CellID)
	}
	if !slices.Contains(cert.ExtKeyUsage, x509.ExtKeyUsageClientAuth) {
		return nil, errors.New("certificate is not for client authentication")
	}
	if now := time.Now(); now.After(cert.NotAfter) || cert.NotBefore.After(now.Add(clockSkew)) {
		return nil, fmt.Errorf("certificate is not valid now (%s to %s)", cert.NotBefore.UTC().Format(time.RFC3339), cert.NotAfter.UTC().Format(time.RFC3339))
	}
	return &Issued{Response: &res, Leaf: cert, Issuer: signer}, nil
}

// Renew trades the certificate tlsCfg presents for a new one over mTLS
// (POST /cells/renew), refuses an answer for another cell or not signed by
// the pinned issuer, and writes the new identity. It never touches the hub
// CA file.
func Renew(ctx context.Context, hub string, tlsCfg *tls.Config, cellID string, p Paths) (*CertificateResponse, tls.Certificate, error) {
	issuer, err := p.readIssuer()
	if err != nil {
		return nil, tls.Certificate{}, err
	}
	key, csr, err := NewKeyAndCSR()
	if err != nil {
		return nil, tls.Certificate{}, err
	}
	got, err := RequestCertificate(ctx, HTTPClient(tlsCfg), hub, "/cells/renew", struct {
		CSR string `json:"csr"`
	}{string(csr)}, key, issuer)
	if err != nil {
		return nil, tls.Certificate{}, err
	}
	if got.Response.CellID != cellID {
		return nil, tls.Certificate{}, fmt.Errorf("hub renewed cell %q, this cell is %q", got.Response.CellID, cellID)
	}
	if err := WriteIdentity(p, key, got); err != nil {
		return nil, tls.Certificate{}, err
	}
	return got.Response, tls.Certificate{Certificate: [][]byte{got.Leaf.Raw}, PrivateKey: key, Leaf: got.Leaf}, nil
}

func ParseCertPEM(s string) (*x509.Certificate, error) {
	blk, _ := pem.Decode([]byte(s))
	if blk == nil || blk.Type != "CERTIFICATE" {
		return nil, errors.New("no PEM CERTIFICATE")
	}
	return x509.ParseCertificate(blk.Bytes)
}

// HTTPSBase turns the cell's wss://host:port/cells into https://host:port.
func HTTPSBase(hubURL string) (string, error) {
	u, err := url.Parse(hubURL)
	if err != nil || (u.Scheme != "wss" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("hubUrl %q is not wss://host:port/<path>", hubURL)
	}
	return "https://" + u.Host, nil
}
