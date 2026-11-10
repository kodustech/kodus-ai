package enrollment

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
)

// CertHolder is the cell's current client certificate. Every client of the
// cell identity (the hub connection, the egress control, the renewal call)
// reads it at each TLS handshake (GetClientCertificate), so a renewed
// certificate is used from the next handshake on and a live connection,
// with its claims, keeps going on the one it was opened with.
type CertHolder struct {
	mu   sync.RWMutex
	cert tls.Certificate
}

// LoadCertHolder reads the identity the cell starts with (LoadIdentity).
func LoadCertHolder(certFile, keyFile string) (*CertHolder, error) {
	c, err := LoadIdentity(certFile, keyFile)
	if err != nil {
		return nil, err
	}
	return NewCertHolder(c)
}

func NewCertHolder(c tls.Certificate) (*CertHolder, error) {
	if len(c.Certificate) == 0 {
		return nil, errors.New("enrollment: empty certificate")
	}
	if c.Leaf == nil {
		leaf, err := x509.ParseCertificate(c.Certificate[0])
		if err != nil {
			return nil, err
		}
		c.Leaf = leaf
	}
	return &CertHolder{cert: c}, nil
}

func (h *CertHolder) Leaf() *x509.Certificate {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.cert.Leaf
}

// CellID is the certificate's CN: the hub names the cell there.
func (h *CertHolder) CellID() string { return h.Leaf().Subject.CommonName }

func (h *CertHolder) Set(c tls.Certificate) error {
	n, err := NewCertHolder(c)
	if err != nil {
		return err
	}
	h.mu.Lock()
	h.cert = n.cert
	h.mu.Unlock()
	return nil
}

func (h *CertHolder) GetClientCertificate(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	c := h.cert
	return &c, nil
}

// ClientTLS presents the holder's certificate and trusts roots for the
// server: the hub, or any cell service the same identity talks to.
func (h *CertHolder) ClientTLS(roots *x509.CertPool) *tls.Config {
	return &tls.Config{GetClientCertificate: h.GetClientCertificate, RootCAs: roots, MinVersion: tls.VersionTLS13}
}

// RenewAt is when a certificate is renewed: with a third of its validity
// left (8 h before the end of a 24 h certificate).
func RenewAt(leaf *x509.Certificate) time.Time {
	return leaf.NotAfter.Add(-leaf.NotAfter.Sub(leaf.NotBefore) / 3)
}

// Renewer keeps the cell's certificate fresh: at RenewAt it calls Renew
// (the path "cell renew" takes) with the current certificate, writes the
// files and swaps the holder. A failure is an alarm (ERROR log
// cert.renew.failed with alarm=true and the time left; cert.expired once
// the certificate is past its end) and is retried with backoff.
type Renewer struct {
	Holder *CertHolder
	Hub    string // https://host:port
	Roots  *x509.CertPool
	Paths  Paths
	Log    *slog.Logger
	Now    func() time.Time
	// MinBackoff (default 30 s) doubles up to MaxBackoff (default 15 min)
	// between failed attempts.
	MinBackoff time.Duration
	MaxBackoff time.Duration

	// Metrics, when set, gets cell_cert_renewals_total,
	// cell_cert_renew_failures_total and cell_cert_seconds_left.
	Metrics *metrics.Registry

	Renewals atomic.Int64
	Failures atomic.Int64
}

func (r *Renewer) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Run renews until ctx ends.
func (r *Renewer) Run(ctx context.Context) {
	log := r.Log
	if log == nil {
		log = slog.Default()
	}
	minB, maxB := r.MinBackoff, r.MaxBackoff
	if minB <= 0 {
		minB = 30 * time.Second
	}
	if maxB < minB {
		maxB = 15 * time.Minute
		if maxB < minB {
			maxB = minB
		}
	}
	mRenewals := r.Metrics.Counter("cell_cert_renewals_total", "Client certificate renewals.")
	mFailures := r.Metrics.Counter("cell_cert_renew_failures_total", "Failed client certificate renewals (each one is an alarm).")
	r.Metrics.GaugeFunc("cell_cert_seconds_left", "Seconds until the client certificate expires.", func() float64 {
		return r.Holder.Leaf().NotAfter.Sub(r.now()).Seconds()
	})
	backoff := minB
	for ctx.Err() == nil {
		leaf := r.Holder.Leaf()
		at := RenewAt(leaf)
		if wait := at.Sub(r.now()); wait > 0 {
			log.Info("cert.renew.scheduled", "cell", leaf.Subject.CommonName, "serial", leaf.SerialNumber.Text(16), "at", at.UTC().Format(time.RFC3339), "expiresAt", leaf.NotAfter.UTC().Format(time.RFC3339))
			if !sleep(ctx, wait) {
				return
			}
			continue
		}
		res, cert, err := Renew(ctx, r.Hub, r.Holder.ClientTLS(r.Roots), leaf.Subject.CommonName, r.Paths)
		if err == nil && !RenewAt(cert.Leaf).After(r.now().Add(minB)) {
			// Renewing again at once would loop on the hub: a certificate
			// that is due for renewal the moment it arrives (a short TTL, a
			// skewed clock) waits like a failure.
			err = fmt.Errorf("the hub issued a certificate already due for renewal (renew at %s)", RenewAt(cert.Leaf).UTC().Format(time.RFC3339))
		}
		if err == nil {
			err = r.Holder.Set(cert)
		}
		if err == nil {
			// Logged before it is counted: whoever sees the count finds the line.
			log.Info("cert.renewed", "cell", res.CellID, "serial", res.Serial, "expiresAt", res.ExpiresAt, "previousSerial", leaf.SerialNumber.Text(16))
			r.Renewals.Add(1)
			mRenewals.Inc()
			backoff = minB
			continue
		}
		if ctx.Err() != nil {
			return
		}
		left := leaf.NotAfter.Sub(r.now())
		msg := "cert.renew.failed"
		if left <= 0 {
			// The hub refuses this certificate now: the cell will not reconnect.
			msg = "cert.expired"
		}
		log.Error(msg, "alarm", true, "cell", leaf.Subject.CommonName, "serial", leaf.SerialNumber.Text(16), "expiresAt", leaf.NotAfter.UTC().Format(time.RFC3339),
			"leftS", int64(left.Seconds()), "err", err, "retryIn", backoff)
		r.Failures.Add(1) // after the alarm line, so every counted failure has one
		mFailures.Inc()
		if !sleep(ctx, backoff) {
			return
		}
		if backoff *= 2; backoff > maxB {
			backoff = maxB
		}
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}
