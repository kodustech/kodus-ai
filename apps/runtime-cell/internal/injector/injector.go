// Package injector is the only piece of the cell that holds a test
// credential (Inc. 5, docs §4 "Injetor de credencial"). The proxy sends it
// only the hosts a claim declared with a credential, with the address the
// proxy validated for that host in the PROXY line. The injector terminates
// the VM's TLS with the cell CA, adds the header, and goes to exactly that
// address over its own verified TLS: it never resolves the name again and
// never takes a proxy from its environment, so the credential goes where
// the proxy's checks said and nowhere else.
//
// The credential is short-lived, per claim, comes from the cell vault, and
// never goes back to the VM or through the proxy: responses are masked as
// they stream, and a request that carries the credential or a bait out is
// refused and raises an alert (S-28, S-29, S-50) that the control port
// serves to the agent.
package injector

import (
	"bufio"
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// Credential is what the vault hands out for one claim and one host.
type Credential struct {
	Header    string // e.g. Authorization
	Value     string // e.g. "Bearer <short-lived token>"
	ExpiresAt time.Time
	// Baits are canaries planted for this run; seeing one leave is an alert.
	Baits []string
}

// Vault is the cell's secret store (the owner's vault, Inc. 5).
type Vault interface {
	Credential(ctx context.Context, orgID, claimID, host string) (Credential, error)
}

// Alert kinds.
const (
	AlertCredentialExfiltration = "credential_exfiltration"
	AlertBaitExfiltration       = "bait_exfiltration"
)

type Alert struct {
	Seq     int64     `json:"seq"`
	ClaimID string    `json:"claimId"`
	Host    string    `json:"host"`
	Kind    string    `json:"kind"`
	At      time.Time `json:"at"`
}

// Masked is what a credential spelling becomes in a response.
const Masked = "***"

const (
	defaultMaxBody      = 16 << 20
	defaultMaxResponse  = 256 << 20
	defaultPerClaim     = 8
	maxProxyLine        = 107 // the PROXY v1 maximum, CRLF included
	defaultUpstreamPort = "443"
)

type Injector struct {
	Policies *policy.Store
	Vault    Vault
	// CA signs the leaf the VM sees for each credentialed host; the VM's
	// image trusts it (installed at bake).
	CA    *x509.Certificate
	CAKey crypto.Signer
	// TrustedProxies are the only addresses allowed to speak PROXY v1.
	TrustedProxies []string
	// UpstreamRoots verify the destination; nil: the system roots.
	UpstreamRoots *x509.CertPool
	// Dial reaches the address the proxy validated (tests point it
	// elsewhere); it is never given a name to resolve.
	Dial func(ctx context.Context, network, addr string) (net.Conn, error)
	// InternalCIDRs are the cell's own networks, as on the proxy: the
	// destination is checked again here before the credential goes out.
	InternalCIDRs []*net.IPNet
	// MaxBody caps a request body held for the outbound scan; MaxResponse
	// caps a response (it streams, masked, and is cut past the cap).
	MaxBody     int64
	MaxResponse int64
	// MaxConcurrentPerClaim bounds the requests one claim has in flight.
	MaxConcurrentPerClaim int
	// Alerts is where alerts go for the control port; OnAlert is called
	// too.
	Alerts  *eventlog.Log[Alert]
	OnAlert func(Alert)
	Log     *slog.Logger
	Now     func() time.Time

	once     sync.Once
	mu       sync.Mutex
	certs    map[string]*tls.Certificate
	inFlight map[string]*claimRequestSlots
}

func (in *Injector) defaults() {
	in.once.Do(func() {
		if in.Dial == nil {
			in.Dial = (&net.Dialer{Timeout: 10 * time.Second}).DialContext
		}
		if in.MaxBody == 0 {
			in.MaxBody = defaultMaxBody
		}
		if in.MaxResponse == 0 {
			in.MaxResponse = defaultMaxResponse
		}
		if in.MaxConcurrentPerClaim == 0 {
			in.MaxConcurrentPerClaim = defaultPerClaim
		}
		if in.Log == nil {
			in.Log = slog.Default()
		}
		if in.Now == nil {
			in.Now = time.Now
		}
		in.certs = map[string]*tls.Certificate{}
		in.inFlight = map[string]*claimRequestSlots{}
	})
}

func (in *Injector) Serve(ctx context.Context, l net.Listener) error {
	in.defaults()
	go func() { <-ctx.Done(); l.Close() }()
	var backoff time.Duration
	for {
		c, err := l.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() || isTemporary(err) {
				backoff = min(max(2*backoff, 5*time.Millisecond), time.Second)
				time.Sleep(backoff)
				continue
			}
			return err
		}
		backoff = 0
		go in.handle(c)
	}
}

func isTemporary(err error) bool {
	return errors.Is(err, syscall.EMFILE) || errors.Is(err, syscall.ENFILE) || errors.Is(err, syscall.ENOBUFS) || errors.Is(err, syscall.ECONNABORTED)
}

func (in *Injector) trusted(c net.Conn) bool {
	a, ok := c.RemoteAddr().(*net.TCPAddr)
	if !ok {
		return false
	}
	for _, t := range in.TrustedProxies {
		if t = strings.TrimSpace(t); t != "" && a.IP.String() == t {
			return true
		}
	}
	return false
}

// bufConn replays what the PROXY line reader buffered.
type bufConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufConn) Read(p []byte) (int, error) { return b.r.Read(p) }

var errProxyLine = errors.New("injector: bad PROXY line")

// readProxyLine reads "PROXY TCP4 <vm> <destination> <sport> <dport>" and
// never more than the PROXY v1 maximum before the newline.
func readProxyLine(r *bufio.Reader) (src, dst net.IP, err error) {
	line, err := r.ReadSlice('\n')
	if err != nil || len(line) > maxProxyLine {
		return nil, nil, errProxyLine
	}
	f := strings.Fields(strings.TrimSpace(string(line)))
	if len(f) != 6 || f[0] != "PROXY" || f[1] != "TCP4" {
		return nil, nil, errProxyLine
	}
	src, dst = net.ParseIP(f[2]).To4(), net.ParseIP(f[3]).To4()
	if src == nil || dst == nil {
		return nil, nil, errProxyLine
	}
	return src, dst, nil
}

type ctxKey struct{}

type connInfo struct {
	pol  policy.ClaimPolicy
	host string
	// upstream reaches the address the proxy validated, by SNI host.
	upstream *http.Client
}

func (in *Injector) handle(raw net.Conn) {
	defer raw.Close()
	peer := raw.RemoteAddr().String()
	if !in.trusted(raw) {
		in.Log.Warn("injector.untrusted_peer", "peer", peer)
		return
	}
	_ = raw.SetReadDeadline(in.Now().Add(10 * time.Second))
	br := bufio.NewReaderSize(raw, 128) // > maxProxyLine: ReadSlice stops there
	src, dst, err := readProxyLine(br)
	if err != nil {
		in.Log.Warn("injector.bad_proxy_line", "peer", peer)
		return
	}
	pol, ok := in.Policies.ForSource(src)
	if !ok {
		in.Log.Warn("injector.unknown_source", "source", src.String())
		return
	}
	if why := netguard.RefusedDestination(dst, in.InternalCIDRs); why != "" {
		in.Log.Warn("injector.refused_destination", "claim", pol.ClaimID, "destination", dst.String(), "reason", why)
		return
	}
	var host string
	tc := tls.Server(&bufConn{Conn: raw, r: br}, &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
			n, err := policy.NormalizeHost(h.ServerName)
			if err != nil || !pol.Injects(n) {
				return nil, fmt.Errorf("injector: %q has no declared credential", h.ServerName)
			}
			host = n
			return in.leaf(n)
		},
	})
	if err := tc.Handshake(); err != nil {
		in.Log.Warn("injector.handshake", "claim", pol.ClaimID, "err", err)
		return
	}
	_ = raw.SetReadDeadline(time.Time{})
	transport := in.transportTo(dst, host)
	defer transport.CloseIdleConnections()
	info := connInfo{pol: pol, host: host, upstream: &http.Client{
		Transport: transport,
		// A redirect is the VM's to follow, through the proxy again: the
		// credential never goes to the next location.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
	srv := &http.Server{
		Handler:           http.HandlerFunc(in.proxyWithCredential),
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ConnContext:       func(ctx context.Context, _ net.Conn) context.Context { return context.WithValue(ctx, ctxKey{}, info) },
		ErrorLog:          slog.NewLogLogger(in.Log.Handler(), slog.LevelWarn),
	}
	_ = srv.Serve(&singleConnListener{c: tc})
}

// transportTo goes to dst:443 only, verifying host. Proxy is nil: an
// HTTPS_PROXY in the injector's environment must not receive the
// credential.
func (in *Injector) transportTo(dst net.IP, host string) *http.Transport {
	addr := net.JoinHostPort(dst.String(), defaultUpstreamPort)
	return &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return in.Dial(ctx, "tcp4", addr)
		},
		TLSClientConfig:       &tls.Config{ServerName: host, RootCAs: in.UpstreamRoots, MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: time.Minute,
		MaxIdleConns:          2,
		IdleConnTimeout:       time.Minute,
	}
}

func (in *Injector) leaf(host string) (*tls.Certificate, error) {
	in.mu.Lock()
	defer in.mu.Unlock()
	if c, ok := in.certs[host]; ok && in.Now().Before(c.Leaf.NotAfter.Add(-time.Hour)) {
		return c, nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		return nil, err
	}
	tpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: host},
		DNSNames:     []string{host},
		NotBefore:    in.Now().Add(-time.Minute),
		NotAfter:     in.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, in.CA, &key.PublicKey, in.CAKey)
	if err != nil {
		return nil, err
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	c := &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}
	in.certs[host] = c
	return c, nil
}

// credentialForms are the credential's value and, for "Bearer <token>",
// the bare token.
func credentialForms(cred Credential) []string {
	out := []string{cred.Value}
	if _, tok, ok := strings.Cut(cred.Value, " "); ok && len(tok) >= 8 {
		out = append(out, tok)
	}
	return out
}

func (in *Injector) alert(info connInfo, kind string) {
	a := Alert{ClaimID: info.pol.ClaimID, Host: info.host, Kind: kind, At: in.Now().UTC()}
	if in.Alerts != nil {
		in.Alerts.Add(func(seq int64) Alert { a.Seq = seq; return a })
	}
	in.Log.Error("injector.alert", "claim", a.ClaimID, "host", a.Host, "kind", kind)
	if in.OnAlert != nil {
		in.OnAlert(a)
	}
}

func (in *Injector) proxyWithCredential(w http.ResponseWriter, r *http.Request) {
	info, _ := r.Context().Value(ctxKey{}).(connInfo)
	if r.Host != "" && !strings.EqualFold(stripPort(r.Host), info.host) {
		http.Error(w, "host does not match the TLS name", http.StatusMisdirectedRequest)
		return
	}
	release, err := in.acquire(r.Context(), info.pol.ClaimID)
	if err != nil {
		return
	}
	defer release()
	cred, err := in.Vault.Credential(r.Context(), info.pol.OrgID, info.pol.ClaimID, info.host)
	if err != nil || !in.Now().Before(cred.ExpiresAt) {
		in.Log.Warn("injector.no_credential", "claim", info.pol.ClaimID, "host", info.host, "code", credentialFailureCode(err))
		http.Error(w, "no credential for this claim", http.StatusForbidden)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, in.MaxBody+1))
	if err != nil || int64(len(body)) > in.MaxBody {
		http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
		return
	}
	// Outbound scan: the request is plaintext only here. A bait or the
	// credential itself leaving the VM is an alert, and the request stops.
	var head bytes.Buffer
	_ = r.Header.Write(&head)
	head.WriteString(r.URL.RequestURI())
	outbound := append(head.Bytes(), body...)
	if redact.Contains(outbound, cred.Baits) {
		in.alert(info, AlertBaitExfiltration)
		http.Error(w, "refused", http.StatusForbidden)
		return
	}
	if redact.Contains(outbound, credentialForms(cred)) {
		in.alert(info, AlertCredentialExfiltration)
		http.Error(w, "refused", http.StatusForbidden)
		return
	}
	out, err := http.NewRequestWithContext(r.Context(), r.Method, "https://"+info.host+r.URL.RequestURI(), bytes.NewReader(body))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	for k, vs := range r.Header {
		if strings.EqualFold(k, cred.Header) || hopByHop[http.CanonicalHeaderKey(k)] {
			continue // the VM never chooses the credential header
		}
		// The VM never picks the encoding either: the mask reads plain
		// bytes. Without the header, the transport asks for gzip itself and
		// hands back the body decompressed.
		if strings.EqualFold(k, "Accept-Encoding") {
			continue
		}
		out.Header[k] = vs
	}
	out.Header.Set(cred.Header, cred.Value)
	resp, err := info.upstream.Do(out)
	if err != nil {
		// The HTTP parser may include raw upstream bytes in err, including a
		// reflected credential. Log only a fixed code across this boundary.
		in.Log.Warn("injector.upstream", "claim", info.pol.ClaimID, "host", info.host, "code", "upstream_unavailable")
		http.Error(w, "upstream unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	// An encoding the transport did not undo (an upstream that compresses
	// unasked, or br) cannot be masked: refuse it rather than pass it on.
	if ce := strings.TrimSpace(resp.Header.Get("Content-Encoding")); ce != "" && !strings.EqualFold(ce, "identity") {
		http.Error(w, "upstream encoding not supported", http.StatusBadGateway)
		return
	}
	// Inbound mask: an upstream that echoes the request (S-50) cannot hand
	// the credential to the VM, in a header or in the body as it streams.
	secrets := credentialForms(cred)
	if sensitiveResponseHeaderName(resp.Header, secrets) {
		in.Log.Warn("injector.response_refused", "claim", info.pol.ClaimID, "host", info.host, "code", "sensitive_header_name")
		http.Error(w, "upstream response refused", http.StatusBadGateway)
		return
	}
	for k, vs := range resp.Header {
		if hopByHop[http.CanonicalHeaderKey(k)] || strings.EqualFold(k, "Content-Length") {
			continue
		}
		for _, v := range vs {
			w.Header().Add(k, redact.Mask(v, secrets, Masked))
		}
	}
	w.WriteHeader(resp.StatusCode)
	mw := redact.NewMaskingWriter(w, secrets, Masked)
	n, err := io.Copy(mw, io.LimitReader(resp.Body, in.MaxResponse+1))
	if err == nil {
		err = mw.Close()
	}
	if err != nil || n > in.MaxResponse {
		// Past the cap, or the upstream broke off: the VM must see a broken
		// response, not a short one that looks whole.
		in.Log.Warn("injector.response_cut", "claim", info.pol.ClaimID, "host", info.host, "bytes", n, "code", "response_incomplete")
		panic(http.ErrAbortHandler)
	}
}

func credentialFailureCode(err error) string {
	switch {
	case err == nil:
		return "expired"
	case errors.Is(err, ErrVaultDenied):
		return "denied"
	case errors.Is(err, ErrVaultNotConfigured):
		return "not_configured"
	case errors.Is(err, context.Canceled):
		return "cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	default:
		return "unavailable"
	}
}

var hopByHop = map[string]bool{
	"Connection": true, "Proxy-Connection": true, "Keep-Alive": true, "Proxy-Authenticate": true,
	"Proxy-Authorization": true, "Te": true, "Trailer": true, "Transfer-Encoding": true, "Upgrade": true,
}

func stripPort(h string) string {
	if host, _, err := net.SplitHostPort(h); err == nil {
		return host
	}
	return h
}

// singleConnListener yields one connection, then blocks until it closes.
type singleConnListener struct {
	c    net.Conn
	once sync.Once
	done chan struct{}
	mu   sync.Mutex
}

func (o *singleConnListener) Accept() (net.Conn, error) {
	o.mu.Lock()
	if o.done == nil {
		o.done = make(chan struct{})
	}
	done := o.done
	o.mu.Unlock()
	var c net.Conn
	o.once.Do(func() { c = &closeNotify{Conn: o.c, done: done} })
	if c != nil {
		return c, nil
	}
	<-done
	return nil, net.ErrClosed
}

func (o *singleConnListener) Close() error   { return nil }
func (o *singleConnListener) Addr() net.Addr { return o.c.LocalAddr() }

type closeNotify struct {
	net.Conn
	done chan struct{}
	once sync.Once
}

func (c *closeNotify) Close() error {
	c.once.Do(func() { close(c.done) })
	return c.Conn.Close()
}
