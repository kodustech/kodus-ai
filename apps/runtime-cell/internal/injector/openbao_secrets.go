package injector

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// StoredSecret is an org secret as the store holds it: the value and the
// exact hosts the admin allowed it to go to. The hosts are checked again
// here, so a policy that names another host never receives the value.
type StoredSecret struct {
	Value string
	Hosts []string
}

func (StoredSecret) String() string               { return "injector.StoredSecret{redacted}" }
func (s StoredSecret) GoString() string           { return s.String() }
func (s StoredSecret) LogValue() slog.Value       { return slog.StringValue(s.String()) }
func (s StoredSecret) Format(f fmt.State, _ rune) { _, _ = io.WriteString(f, s.String()) }

// SecretStore reads an org secret's current value. Kodus writes it (the API's
// write-only identity); the injector only reads (docs/runtime/sandbox.md).
type SecretStore interface {
	Secret(ctx context.Context, orgID, secretID string) (StoredSecret, error)
}

// OpenBaoSecretsConfig is the operator's configuration of the store, never
// repository input.
type OpenBaoSecretsConfig struct {
	Address string
	Mount   string
	Roots   *x509.CertPool
	// Token is the injector's read-only identity (AppRoleToken in production).
	Token   func(context.Context) (string, error)
	Timeout time.Duration
}

// OpenBaoSecrets reads orgs/<org>/secrets/<id> from a KV v2 mount, latest
// version, with no cache: a value the admin replaced or deleted is the next
// request's answer. It has no write, list or token-management call.
type OpenBaoSecrets struct {
	transport *http.Transport
	client    *http.Client
	address   string
	mount     string
	token     func(context.Context) (string, error)
	timeout   time.Duration
	slots     chan struct{}
}

var _ SecretStore = (*OpenBaoSecrets)(nil)

// maxSecretValue bounds a value: it becomes an HTTP header.
const maxSecretValue = 8 << 10

func NewOpenBaoSecrets(cfg OpenBaoSecretsConfig) (*OpenBaoSecrets, error) {
	address, err := openBaoAddress(cfg.Address)
	if err != nil || !openBaoMount.MatchString(cfg.Mount) || cfg.Token == nil {
		return nil, ErrVaultConfig
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 3 * time.Second
	}
	if cfg.Timeout < 100*time.Millisecond || cfg.Timeout > 10*time.Second {
		return nil, ErrVaultConfig
	}
	transport, client := openBaoClient(cfg.Roots, cfg.Timeout)
	return &OpenBaoSecrets{transport: transport, client: client, address: address, mount: cfg.Mount, token: cfg.Token, timeout: cfg.Timeout, slots: make(chan struct{}, 16)}, nil
}

// openBaoAddress accepts an https origin only, with no path, user or query.
func openBaoAddress(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 2048 || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Opaque != "" || (u.Path != "" && u.Path != "/") || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(u.Host, "%") {
		return "", ErrVaultConfig
	}
	return "https://" + u.Host, nil
}

// openBaoClient never takes a proxy from the environment (an HTTPS_PROXY is
// not authority to reroute vault requests) and never follows a redirect.
func openBaoClient(roots *x509.CertPool, timeout time.Duration) (*http.Transport, *http.Client) {
	if roots != nil {
		roots = roots.Clone()
	}
	transport := &http.Transport{
		Proxy:                  nil,
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots},
		DialContext:            (&net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:    timeout,
		ResponseHeaderTimeout:  timeout,
		MaxResponseHeaderBytes: 16 << 10,
		DisableCompression:     true,
		MaxConnsPerHost:        16,
		MaxIdleConnsPerHost:    16,
		MaxIdleConns:           16,
		IdleConnTimeout:        30 * time.Second,
	}
	return transport, &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (s *OpenBaoSecrets) Secret(ctx context.Context, orgID, secretID string) (StoredSecret, error) {
	if s == nil || s.client == nil {
		return StoredSecret{}, ErrVaultNotConfigured
	}
	if err := ctx.Err(); err != nil {
		return StoredSecret{}, err
	}
	if !vaultID.MatchString(orgID) || !policy.ValidSecretID(secretID) {
		return StoredSecret{}, ErrVaultDenied
	}
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	case <-ctx.Done():
		return StoredSecret{}, ctx.Err()
	}
	token, err := s.token(ctx)
	if err != nil {
		if errors.Is(err, ErrVaultDenied) {
			return StoredSecret{}, ErrVaultDenied
		}
		return StoredSecret{}, baoReadError(ctx)
	}
	if !validOpenBaoToken(token) {
		return StoredSecret{}, ErrVaultDenied
	}
	path := "/v1/" + s.mount + "/data/orgs/" + url.PathEscape(orgID) + "/secrets/" + url.PathEscape(secretID)
	raw, status, err := openBaoGet(ctx, s.client, s.address+path, token)
	defer clear(raw)
	if err != nil {
		return StoredSecret{}, err
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden || status == http.StatusNotFound {
		return StoredSecret{}, ErrVaultDenied
	}
	if status != http.StatusOK {
		return StoredSecret{}, ErrVaultUnavailable
	}
	return decodeStoredSecret(raw, orgID, secretID)
}

func (s *OpenBaoSecrets) CloseIdleConnections() {
	if s != nil && s.transport != nil {
		s.transport.CloseIdleConnections()
	}
}

// openBaoGet returns the bounded JSON body of a GET, or a fixed error: the
// backend's text never crosses this boundary.
func openBaoGet(ctx context.Context, client *http.Client, target, token string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, 0, ErrVaultUnavailable
	}
	req.Header.Set("X-Vault-Token", token)
	req.Header.Set("X-Vault-Request", "true")
	req.Header.Set("Accept", "application/json")
	response, err := client.Do(req)
	if err != nil {
		return nil, 0, baoReadError(ctx)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxOpenBaoResponse))
		return nil, response.StatusCode, nil
	}
	media, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || media != "application/json" || response.Header.Get("Content-Encoding") != "" {
		return nil, 0, ErrVaultUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxOpenBaoResponse+1))
	if err != nil {
		clear(raw)
		return nil, 0, baoReadError(ctx)
	}
	if len(raw) > maxOpenBaoResponse {
		clear(raw)
		return nil, 0, ErrVaultUnavailable
	}
	return raw, http.StatusOK, nil
}

// decodeStoredSecret takes the record the API writes: exactly value, hosts,
// organizationId and secretId, the last two equal to the path's.
func decodeStoredSecret(raw []byte, orgID, secretID string) (StoredSecret, error) {
	if !utf8.Valid(raw) {
		return StoredSecret{}, ErrVaultUnavailable
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	root, err := openBaoJSONValue(decoder, 0)
	if err != nil {
		return StoredSecret{}, ErrVaultUnavailable
	}
	if _, err = decoder.Token(); !errors.Is(err, io.EOF) {
		return StoredSecret{}, ErrVaultUnavailable
	}
	object, _ := root.(map[string]any)
	data, _ := object["data"].(map[string]any)
	metadata, _ := data["metadata"].(map[string]any)
	payload, _ := data["data"].(map[string]any)
	destroyed, hasDestroyed := metadata["destroyed"].(bool)
	deletionTime, hasDeletionTime := metadata["deletion_time"].(string)
	if !hasDestroyed || destroyed || !hasDeletionTime || deletionTime != "" {
		return StoredSecret{}, ErrVaultDenied
	}
	if len(payload) != 4 || payload["organizationId"] != orgID || payload["secretId"] != secretID {
		return StoredSecret{}, ErrVaultDenied
	}
	value, _ := payload["value"].(string)
	list, _ := payload["hosts"].([]any)
	out := StoredSecret{Value: value}
	for _, h := range list {
		host, _ := h.(string)
		n, err := policy.NormalizeHost(host)
		if err != nil || n != host {
			return StoredSecret{}, ErrVaultDenied
		}
		out.Hosts = append(out.Hosts, n)
	}
	if !validSecretValue(value) || len(out.Hosts) == 0 || len(out.Hosts) > 32 {
		return StoredSecret{}, ErrVaultDenied
	}
	slices.Sort(out.Hosts)
	return out, nil
}

// validSecretValue is a value that can stand in an HTTP header: printable,
// no line break, bounded.
func validSecretValue(v string) bool {
	if v == "" || len(v) > maxSecretValue || !utf8.ValidString(v) {
		return false
	}
	for _, r := range v {
		if r < 0x20 && r != '\t' || r == 0x7f {
			return false
		}
	}
	return true
}

// AppRoleToken logs in with an AppRole and keeps the token until two thirds
// of its lease: the injector's identity in production. The role id and the
// secret id are read from files the installer writes (0600), on each login.
type AppRoleToken struct {
	Address      string
	Roots        *x509.CertPool
	RoleIDFile   string
	SecretIDFile string
	Mount        string // the AppRole auth mount; "" is approle
	Timeout      time.Duration
	Now          func() time.Time

	once    sync.Once
	client  *http.Client
	address string
	initErr error
	mu      sync.Mutex
	token   string
	renewAt time.Time
}

// Token is a func(ctx) for OpenBaoSecretsConfig.Token.
func (a *AppRoleToken) Token(ctx context.Context) (string, error) {
	a.once.Do(func() {
		if a.Timeout == 0 {
			a.Timeout = 3 * time.Second
		}
		if a.Now == nil {
			a.Now = time.Now
		}
		if a.Mount == "" {
			a.Mount = "approle"
		}
		a.address, a.initErr = openBaoAddress(a.Address)
		if a.initErr == nil && (!openBaoMount.MatchString(a.Mount) || a.RoleIDFile == "" || a.SecretIDFile == "") {
			a.initErr = ErrVaultConfig
		}
		_, a.client = openBaoClient(a.Roots, a.Timeout)
	})
	if a.initErr != nil {
		return "", a.initErr
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.token != "" && a.Now().Before(a.renewAt) {
		return a.token, nil
	}
	token, lease, err := a.login(ctx)
	if err != nil {
		return "", err
	}
	a.token, a.renewAt = token, a.Now().Add(lease*2/3)
	return token, nil
}

// Forget drops the cached token (it was revoked or the role rotated).
func (a *AppRoleToken) Forget() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.token = ""
}

func (a *AppRoleToken) login(ctx context.Context) (string, time.Duration, error) {
	roleID, err := readCredentialFile(a.RoleIDFile)
	if err != nil {
		return "", 0, ErrVaultConfig
	}
	secretID, err := readCredentialFile(a.SecretIDFile)
	if err != nil {
		return "", 0, ErrVaultConfig
	}
	body, _ := json.Marshal(map[string]string{"role_id": roleID, "secret_id": secretID})
	ctx, cancel := context.WithTimeout(ctx, a.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.address+"/v1/auth/"+a.Mount+"/login", bytes.NewReader(body))
	if err != nil {
		return "", 0, ErrVaultUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Vault-Request", "true")
	response, err := a.client.Do(req)
	if err != nil {
		return "", 0, baoReadError(ctx)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusBadRequest || response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return "", 0, ErrVaultDenied
	}
	if response.StatusCode != http.StatusOK {
		return "", 0, ErrVaultUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxOpenBaoResponse+1))
	defer clear(raw)
	if err != nil || len(raw) > maxOpenBaoResponse {
		return "", 0, ErrVaultUnavailable
	}
	var login struct {
		Auth struct {
			ClientToken   string `json:"client_token"`
			LeaseDuration int64  `json:"lease_duration"`
		} `json:"auth"`
	}
	if json.Unmarshal(raw, &login) != nil || !validOpenBaoToken(login.Auth.ClientToken) {
		return "", 0, ErrVaultUnavailable
	}
	lease := time.Duration(login.Auth.LeaseDuration) * time.Second
	if lease <= 0 || lease > 24*time.Hour {
		lease = time.Hour
	}
	return login.Auth.ClientToken, lease, nil
}

// readCredentialFile reads a small file the installer wrote for this process
// only: a regular file, not readable by group or others.
func readCredentialFile(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0o077 != 0 || st.Size() > 4096 {
		return "", ErrVaultConfig
	}
	raw, err := os.ReadFile(path) //nolint:gosec // G304: an operator-configured path, checked above
	if err != nil {
		return "", ErrVaultConfig
	}
	v := strings.TrimSpace(string(raw))
	if !validOpenBaoToken(v) {
		return "", ErrVaultConfig
	}
	return v, nil
}
