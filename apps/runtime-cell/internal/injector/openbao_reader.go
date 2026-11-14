package injector

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// OpenBaoReaderConfig is trusted owner configuration, never repository input.
// Token supplies a current, narrowly scoped identity and must honor its context.
// No token issuance, renewal, bootstrap or root-token management occurs here.
type OpenBaoReaderConfig struct {
	Address string
	Mount   string
	Scope   SecretScope
	Roots   *x509.CertPool
	Token   func(context.Context) (string, error)
	Timeout time.Duration
	Now     func() time.Time
}

// OpenBaoReader reads one owner-configured environment's KV v2 values. It has
// no write/list/auth-management API, no ambient proxy and no value cache.
type OpenBaoReader struct {
	transport *http.Transport
	client    *http.Client
	address   string
	mount     string
	scope     SecretScope
	token     func(context.Context) (string, error)
	timeout   time.Duration
	now       func() time.Time
	slots     chan struct{}
}

const maxOpenBaoResponse = 256 << 10

var openBaoMount = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

var _ SecretVersionReader = (*OpenBaoReader)(nil)

func NewOpenBaoReader(cfg OpenBaoReaderConfig) (*OpenBaoReader, error) {
	u, err := url.Parse(cfg.Address)
	if err != nil || len(cfg.Address) > 2048 || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Opaque != "" || (u.Path != "" && u.Path != "/") || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(u.Host, "%") || !openBaoMount.MatchString(cfg.Mount) || !validSecretScope(cfg.Scope) || cfg.Token == nil {
		return nil, ErrVaultConfig
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 3 * time.Second
	}
	if cfg.Timeout < 100*time.Millisecond || cfg.Timeout > 10*time.Second {
		return nil, ErrVaultConfig
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	var roots *x509.CertPool
	if cfg.Roots != nil {
		roots = cfg.Roots.Clone()
	}
	transport := &http.Transport{
		// Proxy is deliberately nil: process-wide environment is not authority
		// to reroute authenticated vault requests.
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots},
		DialContext:            (&net.Dialer{Timeout: cfg.Timeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:    cfg.Timeout,
		ResponseHeaderTimeout:  cfg.Timeout,
		MaxResponseHeaderBytes: 16 << 10,
		DisableCompression:     true,
		MaxConnsPerHost:        8,
		MaxIdleConnsPerHost:    8,
		MaxIdleConns:           8,
		IdleConnTimeout:        30 * time.Second,
	}
	client := &http.Client{Transport: transport, Timeout: cfg.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return &OpenBaoReader{transport: transport, client: client, address: "https://" + u.Host, mount: cfg.Mount, scope: cfg.Scope, token: cfg.Token, timeout: cfg.Timeout, now: cfg.Now, slots: make(chan struct{}, 8)}, nil
}

func (r *OpenBaoReader) ReadVersion(ctx context.Context, ref SecretVersionRef) (SecretVersion, error) {
	if r == nil || r.client == nil {
		return SecretVersion{}, ErrVaultNotConfigured
	}
	if err := ctx.Err(); err != nil {
		return SecretVersion{}, err
	}
	if ref.Scope != r.scope || !vaultID.MatchString(ref.ID) || ref.Version == 0 || ref.Version > 1<<53 {
		return SecretVersion{}, ErrVaultDenied
	}
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	case <-ctx.Done():
		return SecretVersion{}, ctx.Err()
	}
	token, err := r.token(ctx)
	if err != nil {
		return SecretVersion{}, baoReadError(ctx)
	}
	if !validOpenBaoToken(token) {
		return SecretVersion{}, ErrVaultDenied
	}
	path := "/v1/" + r.mount + "/data/runtime/" + url.PathEscape(ref.Scope.OrganizationID) + "/" + url.PathEscape(ref.Scope.EnvironmentID) + "/" + url.PathEscape(ref.ID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.address+path+"?version="+strconv.FormatUint(ref.Version, 10), nil)
	if err != nil {
		return SecretVersion{}, ErrVaultUnavailable
	}
	req.Header.Set("X-Vault-Token", token)
	req.Header.Set("X-Vault-Request", "true")
	req.Header.Set("Accept", "application/json")
	response, err := r.client.Do(req)
	if err != nil {
		return SecretVersion{}, baoReadError(ctx)
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 || response.StatusCode == 404 {
		return SecretVersion{}, ErrVaultDenied
	}
	if response.StatusCode != http.StatusOK {
		return SecretVersion{}, ErrVaultUnavailable
	}
	media, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || media != "application/json" || response.Header.Get("Content-Encoding") != "" {
		return SecretVersion{}, ErrVaultUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxOpenBaoResponse+1))
	// Reduce the lifetime of this raw copy. Decoded Go strings still exist
	// until reclaimed; this is not a promise of complete memory erasure.
	defer clear(raw)
	if err != nil {
		return SecretVersion{}, baoReadError(ctx)
	}
	if len(raw) > maxOpenBaoResponse {
		return SecretVersion{}, ErrVaultUnavailable
	}
	result, err := decodeOpenBaoVersion(raw, ref)
	if ctx.Err() != nil {
		return SecretVersion{}, ctx.Err()
	}
	if err != nil {
		return SecretVersion{}, err
	}
	if !r.now().Before(result.ExpiresAt) {
		return SecretVersion{}, ErrVaultDenied
	}
	return result, nil
}

func (r *OpenBaoReader) CloseIdleConnections() {
	if r != nil && r.transport != nil {
		r.transport.CloseIdleConnections()
	}
}

func baoReadError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return ErrVaultUnavailable
}

func validOpenBaoToken(token string) bool {
	if len(token) == 0 || len(token) > 4096 {
		return false
	}
	for i := range len(token) {
		if token[i] < 33 || token[i] > 126 {
			return false
		}
	}
	return true
}

func decodeOpenBaoVersion(raw []byte, ref SecretVersionRef) (SecretVersion, error) {
	if !utf8.Valid(raw) {
		return SecretVersion{}, ErrVaultUnavailable
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	root, err := openBaoJSONValue(decoder, 0)
	if err != nil {
		return SecretVersion{}, ErrVaultUnavailable
	}
	if _, err = decoder.Token(); err != io.EOF {
		return SecretVersion{}, ErrVaultUnavailable
	}
	object, _ := root.(map[string]any)
	data, _ := object["data"].(map[string]any)
	metadata, _ := data["metadata"].(map[string]any)
	payload, _ := data["data"].(map[string]any)
	version, _ := metadata["version"].(json.Number)
	destroyed, hasDestroyed := metadata["destroyed"].(bool)
	deletionTime, hasDeletionTime := metadata["deletion_time"].(string)
	if version.String() != strconv.FormatUint(ref.Version, 10) || !hasDestroyed || destroyed || !hasDeletionTime || deletionTime != "" {
		return SecretVersion{}, ErrVaultDenied
	}
	if len(payload) != 5 || payload["organizationId"] != ref.Scope.OrganizationID || payload["environmentId"] != ref.Scope.EnvironmentID || payload["secretId"] != ref.ID {
		return SecretVersion{}, ErrVaultDenied
	}
	value, _ := payload["value"].(string)
	expiresAt, _ := payload["expiresAt"].(string)
	expires, err := time.Parse(time.RFC3339Nano, expiresAt)
	result := SecretVersion{Scope: ref.Scope, ID: ref.ID, Version: ref.Version, Value: value, ExpiresAt: expires.UTC()}
	if err != nil || !validVersion(result) {
		return SecretVersion{}, ErrVaultDenied
	}
	return result, nil
}

// Reject duplicate/case-ambiguous keys and excessive nesting before accessing
// security fields. Unused OpenBao envelope/metadata fields may evolve; the
// five fields of our own value payload remain closed and case-sensitive.
func openBaoJSONValue(d *json.Decoder, depth int) (any, error) {
	if depth > 32 {
		return nil, ErrVaultUnavailable
	}
	token, err := d.Token()
	if err != nil {
		return nil, ErrVaultUnavailable
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return token, nil
	}
	switch delim {
	case '{':
		out := map[string]any{}
		keys := map[string]bool{}
		for d.More() {
			keyToken, err := d.Token()
			key, ok := keyToken.(string)
			folded := strings.ToLower(key)
			if err != nil || !ok || keys[folded] {
				return nil, ErrVaultUnavailable
			}
			keys[folded] = true
			value, err := openBaoJSONValue(d, depth+1)
			if err != nil {
				return nil, err
			}
			out[key] = value
		}
		end, err := d.Token()
		if err != nil || end != json.Delim('}') {
			return nil, ErrVaultUnavailable
		}
		return out, nil
	case '[':
		var out []any
		for d.More() {
			value, err := openBaoJSONValue(d, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, value)
		}
		end, err := d.Token()
		if err != nil || end != json.Delim(']') {
			return nil, ErrVaultUnavailable
		}
		return out, nil
	default:
		return nil, ErrVaultUnavailable
	}
}
