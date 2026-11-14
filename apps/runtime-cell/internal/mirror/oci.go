package mirror

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
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
	// asked for; nil: anonymous.
	Credentials *Credentials
	Metrics     *CacheMetrics
	Log         *slog.Logger
	Clock       clock.Clock

	mu      sync.Mutex
	tokens  map[string]cachedToken
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
	req, err := http.NewRequestWithContext(r.Context(), r.Method, up.String(), nil)
	if err != nil {
		http.Error(w, "bad upstream request", http.StatusBadGateway)
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if a := r.Header.Get("Accept"); a != "" && kind == "manifests" {
		req.Header.Set("Accept", a)
	}
	res, err := o.client().Do(req)
	if err != nil {
		http.Error(w, "the registry is unreachable", http.StatusBadGateway)
		return
	}
	defer res.Body.Close()
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

// token is a pull token for one repository (anonymous, or as Credentials),
// cached until shortly before it expires.
func (o *OCIProxy) token(ctx context.Context, name string) (string, error) {
	o.mu.Lock()
	if t, ok := o.tokens[name]; ok && o.now().Before(t.expires) {
		o.mu.Unlock()
		return t.token, nil
	}
	o.mu.Unlock()
	u := *o.Auth
	q := url.Values{"service": {"registry.docker.io"}, "scope": {"repository:" + name + ":pull"}}
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	if c := o.Credentials; c != nil {
		req.SetBasicAuth(c.Username, c.Token)
	}
	res, err := o.client().Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("mirror: token service answered %d", res.StatusCode)
	}
	var body struct {
		Token     string `json:"token"`
		ExpiresIn int    `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&body); err != nil || body.Token == "" {
		return "", errors.New("mirror: no token in the answer")
	}
	ttl := time.Duration(body.ExpiresIn) * time.Second
	if ttl <= 0 {
		ttl = 60 * time.Second
	}
	o.mu.Lock()
	if o.tokens == nil {
		o.tokens = map[string]cachedToken{}
	}
	o.tokens[name] = cachedToken{token: body.Token, expires: o.now().Add(ttl - 10*time.Second)}
	o.mu.Unlock()
	return body.Token, nil
}

func (o *OCIProxy) now() time.Time { return clock.Or(o.Clock).Now() }
