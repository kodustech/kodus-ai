package mirror

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
)

// The OCI half of the registry mirror: a read-only pull-through of Docker
// Hub for the claims' builders (BuildKit asks it as the docker.io mirror).
// Docker Hub serves layers from signed object-storage URLs (an S3 bucket
// today, a CloudFront host before); the netguard denies every S3 endpoint to
// a claim on purpose, since anyone can own a bucket. So only the mirror,
// on the platform's side, follows those redirects, and only for what the
// claim's Dockerfiles name: an image fetched by any name would make Docker
// Hub carry the claim's data out in the repository names it is asked for.

// ImagePins answers whether the claim may pull repo at ref: a tag the
// claim's Dockerfiles name, or any digest of a repository they name (the
// manifests and layers a pinned tag resolves to).
type ImagePins func(r *http.Request, repo, ref string) bool

// OCIProxy serves /v2/ of the OCI distribution API, GET and HEAD only.
type OCIProxy struct {
	// Registry is Docker Hub's registry (https://registry-1.docker.io).
	Registry *url.URL
	// Auth is its token service (https://auth.docker.io/token).
	Auth *url.URL
	// Pins decides per claim; nil refuses everything.
	Pins ImagePins
	// Client fetches the upstream; nil: a client that follows at most
	// three HTTPS redirects (ociRedirect).
	Client *http.Client
	// MaxBytes bounds one blob.
	MaxBytes int64

	// Store caches blobs and manifests by digest (cache.go); nil: every
	// request streams from the registry, nothing is kept.
	Store BlobStore
	// TagTTL is how long a tag's manifest is served without asking the
	// registry again (default 10 minutes).
	TagTTL time.Duration
	// StaleFor is how long after the registry last confirmed a tag its
	// manifest may still be served while the registry fails (429, 5xx,
	// unreachable); default 6 hours, Docker Hub's rate-limit window.
	StaleFor time.Duration
	// Credentials, when set, are the Docker Hub account pull tokens are
	// asked for; nil: anonymous. They buy a higher rate limit, never
	// access: with them set, a repository is served only when an
	// anonymous client may pull it too (public).
	Credentials *Credentials
	Metrics     *CacheMetrics
	Log         *slog.Logger
	Clock       clock.Clock

	mu      sync.Mutex
	tokens  map[string]cachedToken
	public  map[string]time.Time // when an anonymous token last granted pull of a repository
	tags    map[string]tagEntry
	flights flightGroup
}

type cachedToken struct {
	token   string
	expires time.Time
}

var (
	ociName   = regexp.MustCompile(`^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*){0,3}$`)
	ociTag    = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)
	ociDigest = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

// IsDigest reports whether ref is a sha256 digest.
func IsDigest(ref string) bool { return ociDigest.MatchString(ref) }

// ociRedirect follows a redirect of Docker Hub only over HTTPS, at most
// three times. The target comes from Docker Hub's answer, never from the
// claim, and the blob is checked against its digest whatever serves it.
func ociRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 3 {
		return errors.New("mirror: too many redirects")
	}
	if req.URL.Scheme != "https" {
		return fmt.Errorf("mirror: redirect to %s refused", req.URL.Redacted())
	}
	// A signed URL carries its own credentials; Docker Hub's token must not follow it.
	req.Header.Del("Authorization")
	return nil
}

func (o *OCIProxy) client() *http.Client {
	if o.Client != nil {
		return o.Client
	}
	return &http.Client{Timeout: 10 * time.Minute, CheckRedirect: ociRedirect}
}

func (o *OCIProxy) maxBytes() int64 {
	if o.MaxBytes > 0 {
		return o.MaxBytes
	}
	return 4 << 30
}

// parseOCIPath splits /v2/<name>/<kind>/<ref>; kind is manifests or blobs.
func parseOCIPath(p string) (name, kind, ref string, ok bool) {
	rest, found := strings.CutPrefix(p, "/v2/")
	if !found {
		return "", "", "", false
	}
	for _, k := range []string{"/manifests/", "/blobs/"} {
		if i := strings.LastIndex(rest, k); i > 0 {
			name, ref = rest[:i], rest[i+len(k):]
			kind = strings.Trim(k, "/")
			break
		}
	}
	if kind == "" || !ociName.MatchString(name) {
		return "", "", "", false
	}
	if kind == "blobs" && !IsDigest(ref) {
		return "", "", "", false
	}
	if kind == "manifests" && !IsDigest(ref) && !ociTag.MatchString(ref) {
		return "", "", "", false
	}
	return name, kind, ref, true
}

func (o *OCIProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "the mirror is read only", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path == "/v2/" || r.URL.Path == "/v2" {
		w.Header().Set("Docker-Distribution-API-Version", "registry/2.0")
		w.WriteHeader(http.StatusOK)
		return
	}
	name, kind, ref, ok := parseOCIPath(r.URL.Path)
	// containerd (BuildKit) names the registry a mirror stands in for with
	// ?ns=docker.io; any other query is refused.
	if q := r.URL.RawQuery; q != "" && q != "ns=docker.io" {
		ok = false
	}
	if !ok {
		http.Error(w, "only /v2/<name>/manifests/<tag|digest> and /v2/<name>/blobs/<digest> are served", http.StatusNotFound)
		return
	}
	if o.Pins == nil || !o.Pins(r, name, ref) {
		http.Error(w, fmt.Sprintf("%s:%s is not named by this claim's Dockerfiles", name, ref), http.StatusForbidden)
		return
	}
	// The pull account's reach is not the claim's: a repository it can
	// read but an anonymous client cannot is private, and would land in
	// the cache every tenant of the cell shares. Checked before the store,
	// so nothing fetched for one org is served under a private name.
	if o.Credentials != nil {
		if err := o.checkPublic(r.Context(), name); err != nil {
			code := http.StatusBadGateway
			if errors.Is(err, errNotPublic) {
				code = http.StatusForbidden
			}
			http.Error(w, err.Error(), code)
			return
		}
	}
	// Only past the pins check: a cached blob is served to a claim that
	// names its repository, never to one that merely knows its digest.
	if o.Store != nil {
		o.serveCached(w, r, name, kind, ref)
		return
	}
	o.stream(w, r, name, kind, ref)
}

// stream passes one request through to the registry, keeping nothing.
func (o *OCIProxy) stream(w http.ResponseWriter, r *http.Request, name, kind, ref string) {
	token, err := o.token(r.Context(), name)
	if err != nil {
		http.Error(w, "the registry refused a pull token", http.StatusBadGateway)
		return
	}
	up := o.Registry.JoinPath("v2", name, kind, ref)
	req, err := http.NewRequestWithContext(r.Context(), r.Method, up.String(), nil) //nolint:gosec // G704: the host is the operator's Registry; the path is a parsed OCI reference the claim pins
	if err != nil {
		http.Error(w, "bad upstream request", http.StatusBadGateway)
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if a := r.Header.Get("Accept"); a != "" && kind == "manifests" {
		req.Header.Set("Accept", a)
	}
	res, err := o.client().Do(req) //nolint:gosec // G704: the host is the operator's Registry; the path is a parsed OCI reference the claim pins
	if err != nil {
		http.Error(w, "the registry is unreachable", http.StatusBadGateway)
		return
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		// The registry's own status (404, 429) tells the builder what happened.
		w.WriteHeader(res.StatusCode)
		return
	}
	if res.ContentLength > o.maxBytes() {
		http.Error(w, "larger than the mirror serves", http.StatusBadGateway)
		return
	}
	for _, h := range []string{"Content-Type", "Docker-Content-Digest", "Content-Length"} {
		if v := res.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	// Whatever object storage served it, the bytes must be the digest asked
	// for (a blob, or a manifest by digest): a mismatch cuts the response,
	// so the builder never gets a complete wrong blob.
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(w, h), io.LimitReader(res.Body, o.maxBytes()+1))
	if err != nil || n > o.maxBytes() {
		panic(http.ErrAbortHandler)
	}
	if IsDigest(ref) && "sha256:"+hex.EncodeToString(h.Sum(nil)) != ref {
		panic(http.ErrAbortHandler)
	}
}

var errNotPublic = errors.New("mirror: an anonymous client may not pull this repository, and the mirror serves public repositories only")

// checkPublic is nil when an anonymous client may pull name: Docker Hub's
// token service grants it in the token's access claim. A grant is trusted
// for TagTTL; past that it is asked again, and while the token service
// fails a grant seen within StaleFor still stands (the stale manifests it
// lets the mirror serve are of that repository). A refusal is never kept:
// a repository made public is served at the next request.
func (o *OCIProxy) checkPublic(ctx context.Context, name string) error {
	o.mu.Lock()
	seen, ok := o.public[name]
	o.mu.Unlock()
	now := o.now()
	if ok && now.Sub(seen) < o.tagTTL() {
		return nil
	}
	token, _, err := o.fetchToken(ctx, name, nil)
	if err != nil {
		if ok && now.Sub(seen) < o.staleFor() {
			return nil
		}
		return fmt.Errorf("mirror: could not check that %s is public: %w", name, err)
	}
	if !publicGrant(token, name) {
		return fmt.Errorf("%s: %w", name, errNotPublic)
	}
	o.mu.Lock()
	if o.public == nil {
		o.public = map[string]time.Time{}
	}
	if len(o.public) >= maxTags {
		clear(o.public)
	}
	o.public[name] = now
	o.mu.Unlock()
	return nil
}

// publicGrant reads the access claim of a Docker Hub token (a JWT; the
// claim names each repository and the actions granted) and says whether
// it grants pull of name. Read, not verified: the token came over TLS from
// the token service the mirror is configured with, and is only ever an
// answer to the mirror's own question. Anything else is no grant.
func publicGrant(token, name string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims struct {
		Access []struct {
			Type    string   `json:"type"`
			Name    string   `json:"name"`
			Actions []string `json:"actions"`
		} `json:"access"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return false
	}
	for _, a := range claims.Access {
		if a.Type == "repository" && a.Name == name && slices.Contains(a.Actions, "pull") {
			return true
		}
	}
	return false
}

// token is a pull token for one repository (anonymous, or as Credentials),
// cached until shortly before it expires.
func (o *OCIProxy) token(ctx context.Context, name string) (string, error) {
	o.mu.Lock()
	if t, ok := o.tokens[name]; ok && o.now().Before(t.expires) {
		o.mu.Unlock()
		return t.token, nil
	}
	o.mu.Unlock()
	token, ttl, err := o.fetchToken(ctx, name, o.Credentials)
	if err != nil {
		return "", err
	}
	o.mu.Lock()
	if o.tokens == nil {
		o.tokens = map[string]cachedToken{}
	}
	o.tokens[name] = cachedToken{token: token, expires: o.now().Add(ttl - 10*time.Second)}
	o.mu.Unlock()
	return token, nil
}

// fetchToken asks the token service for a pull token of name, as c (nil:
// anonymous), and how long it lives.
func (o *OCIProxy) fetchToken(ctx context.Context, name string, c *Credentials) (string, time.Duration, error) {
	u := *o.Auth
	q := url.Values{"service": {"registry.docker.io"}, "scope": {"repository:" + name + ":pull"}}
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", 0, err
	}
	if c != nil {
		req.SetBasicAuth(c.Username, c.Token)
	}
	res, err := o.client().Do(req)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("mirror: token service answered %d", res.StatusCode)
	}
	var body struct {
		Token     string `json:"token"`
		ExpiresIn int    `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&body); err != nil || body.Token == "" {
		return "", 0, errors.New("mirror: no token in the answer")
	}
	ttl := time.Duration(body.ExpiresIn) * time.Second
	if ttl <= 0 {
		ttl = 60 * time.Second
	}
	return body.Token, ttl, nil
}

func (o *OCIProxy) now() time.Time { return clock.Or(o.Clock).Now() }
