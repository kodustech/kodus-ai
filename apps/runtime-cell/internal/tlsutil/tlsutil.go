// Package tlsutil loads the mTLS material every cell process uses.
package tlsutil

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
)

func Pool(caFile string) (*x509.CertPool, error) {
	b, err := os.ReadFile(caFile) //nolint:gosec // G304: caFile is an operator-configured CA path
	if err != nil {
		return nil, err
	}
	p := x509.NewCertPool()
	if !p.AppendCertsFromPEM(b) {
		return nil, fmt.Errorf("%s: no certificate", caFile)
	}
	return p, nil
}

// Client is our certificate plus the CA we trust for the server.
func Client(certFile, keyFile, caFile string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, err
	}
	pool, err := Pool(caFile)
	if err != nil {
		return nil, err
	}
	return &tls.Config{Certificates: []tls.Certificate{cert}, RootCAs: pool, MinVersion: tls.VersionTLS13}, nil
}

// ReloadingClient is Client for a certificate that is replaced while the
// process runs, such as the cell's identity, which the renewer rewrites
// before it expires: each handshake presents what certFile and keyFile hold
// now. A pair that does not load (caught between the two renames of a
// renewal) keeps the last one that did, and the next handshake tries again.
func ReloadingClient(certFile, keyFile, caFile string) (*tls.Config, error) {
	kp := &reloadingPair{certFile: certFile, keyFile: keyFile}
	if _, err := kp.current(); err != nil {
		return nil, err
	}
	pool, err := Pool(caFile)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) { return kp.current() },
		RootCAs:              pool,
		MinVersion:           tls.VersionTLS13,
	}, nil
}

// reloadingPair reads the key pair again only when either file changed.
type reloadingPair struct {
	certFile, keyFile string

	mu                sync.Mutex
	cert              *tls.Certificate
	certStat, keyStat os.FileInfo
}

func (p *reloadingPair) current() (*tls.Certificate, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	cs, cerr := os.Stat(p.certFile)
	ks, kerr := os.Stat(p.keyFile)
	if p.cert != nil && cerr == nil && kerr == nil && sameFile(p.certStat, cs) && sameFile(p.keyStat, ks) {
		return p.cert, nil
	}
	c, err := tls.LoadX509KeyPair(p.certFile, p.keyFile)
	if err != nil {
		if p.cert != nil {
			return p.cert, nil
		}
		return nil, err
	}
	p.cert, p.certStat, p.keyStat = &c, cs, ks
	return p.cert, nil
}

func sameFile(a, b os.FileInfo) bool {
	return a != nil && b != nil && os.SameFile(a, b) && a.ModTime().Equal(b.ModTime()) && a.Size() == b.Size()
}

// Server requires and verifies a client certificate from caFile. Any
// certificate that chains to caFile is answered; a control port that only
// one client may use pins it with PinnedServer. Like ReloadingClient, each
// handshake presents what certFile and keyFile hold now, so a server
// certificate replaced while the process runs is served from the next
// handshake on, and a pair caught between two renames keeps the last one.
func Server(certFile, keyFile, caFile string) (*tls.Config, error) {
	kp := &reloadingPair{certFile: certFile, keyFile: keyFile}
	if _, err := kp.current(); err != nil {
		return nil, err
	}
	pool, err := Pool(caFile)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return kp.current() },
		ClientCAs:      pool,
		ClientAuth:     tls.RequireAndVerifyClientCert,
		MinVersion:     tls.VersionTLS13,
	}, nil
}

// Peer is the one client a pinned server answers. A CA that signs the
// agent's certificate may sign others (every cell's, an observer's), and
// chaining to it alone would let any of them use the port.
type Peer struct {
	// CN is the client certificate's subject common name: the cell's id,
	// which stays the same across renewals while the key does not.
	CN string
	// SPKI is the hex SHA-256 of the client certificate's public key
	// (SubjectPublicKeyInfo), for a client whose key never changes.
	SPKI string
}

// IsZero reports whether p pins nothing.
func (p Peer) IsZero() bool { return p.CN == "" && p.SPKI == "" }

// Matches reports whether leaf is the pinned client: both fields that are
// set must match. A zero Peer matches nothing.
func (p Peer) Matches(leaf *x509.Certificate) bool {
	if p.IsZero() || leaf == nil {
		return false
	}
	if p.CN != "" && subtle.ConstantTimeCompare([]byte(leaf.Subject.CommonName), []byte(p.CN)) != 1 {
		return false
	}
	if p.SPKI != "" {
		sum := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
		if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(strings.ToLower(p.SPKI))) != 1 {
			return false
		}
	}
	return true
}

// ErrPeerNotPinned is a client certificate that chains to the CA and is not
// the pinned peer.
var ErrPeerNotPinned = errors.New("tlsutil: client certificate is not the pinned peer")

// PinnedServer is Server answering only peer: the handshake fails for any
// other certificate, even one the CA signed.
func PinnedServer(certFile, keyFile, caFile string, peer Peer) (*tls.Config, error) {
	if peer.IsZero() {
		return nil, errors.New("tlsutil: a pinned server needs the peer's CN or SPKI")
	}
	if peer.SPKI != "" {
		if b, err := hex.DecodeString(peer.SPKI); err != nil || len(b) != sha256.Size {
			return nil, fmt.Errorf("tlsutil: SPKI pin %q is not a hex SHA-256", peer.SPKI)
		}
	}
	cfg, err := Server(certFile, keyFile, caFile)
	if err != nil {
		return nil, err
	}
	// VerifyConnection, not VerifyPeerCertificate: it also runs on a resumed
	// session, which must not skip the pin.
	cfg.VerifyConnection = func(cs tls.ConnectionState) error {
		// Runs after the chain was verified against ClientCAs: VerifiedChains
		// holds only verified chains, each starting at the client's leaf.
		for _, chain := range cs.VerifiedChains {
			if len(chain) > 0 && peer.Matches(chain[0]) {
				return nil
			}
		}
		return ErrPeerNotPinned
	}
	return cfg, nil
}

// RequirePeer answers h only for a request whose verified client certificate
// is peer; anything else, a zero peer included, is 403.
func RequirePeer(peer Peer, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || len(r.TLS.VerifiedChains) == 0 || len(r.TLS.VerifiedChains[0]) == 0 || !peer.Matches(r.TLS.VerifiedChains[0][0]) {
			http.Error(w, "this route answers the pinned agent only", http.StatusForbidden)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// ControlServer is the TLS of a control port the cell agent alone uses:
// pinned to peer when one is given, else Server, which the caller should
// report, since any certificate of the CA is then answered.
func ControlServer(certFile, keyFile, caFile string, peer Peer) (*tls.Config, error) {
	if peer.IsZero() {
		return Server(certFile, keyFile, caFile)
	}
	return PinnedServer(certFile, keyFile, caFile, peer)
}

// PrivateKey reads an Ed25519 private key in PEM (PKCS#8); PublicKey reads
// a public one (PKIX).
func PrivateKey(file string) (ed25519.PrivateKey, error) {
	b, err := os.ReadFile(file) //nolint:gosec // G304: file is an operator-configured key path
	if err != nil {
		return nil, err
	}
	blk, _ := pem.Decode(b)
	if blk == nil {
		return nil, errors.New("no PEM block")
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		return nil, err
	}
	ek, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("not ed25519")
	}
	return ek, nil
}

func PublicKey(file string) (ed25519.PublicKey, error) {
	b, err := os.ReadFile(file) //nolint:gosec // G304: file is an operator-configured key path
	if err != nil {
		return nil, err
	}
	blk, _ := pem.Decode(b)
	if blk == nil {
		return nil, errors.New("no PEM block")
	}
	k, err := x509.ParsePKIXPublicKey(blk.Bytes)
	if err != nil {
		return nil, err
	}
	ek, ok := k.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("not ed25519")
	}
	return ek, nil
}
