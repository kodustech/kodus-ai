package mirror

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// The cached half of the OCI mirror. Every claim of a cell builds from the
// same few base images, and Docker Hub limits anonymous manifest pulls per
// address, so the mirror keeps what it fetched:
//
//   - by digest (layers, and manifests by digest): fetched once, checked
//     against the digest, kept in the Store and served from disk after;
//   - by tag: the manifest is kept with the time the registry last said
//     which digest the tag names. Within TagTTL it is served as is; after,
//     a HEAD asks the registry again (Docker Hub does not count a HEAD
//     against the limit), and a moved tag is fetched. While the registry
//     fails, the last manifest is served for up to StaleFor.
//
// Concurrent requests for one digest or tag share one fetch (flightGroup),
// and every request waits for it to be committed, then reads the disk.
// Nobody streams the bytes in flight: a reader is never handed a byte that
// is not yet checked, and a wrong blob ends as a 502, never as a complete
// response. The cost is the first byte of a cold layer waiting for its
// last; builders read headers without a deadline, and the next claim gets
// the layer from disk.

const (
	manifestMax = 4 << 20 // registries refuse larger manifests
	maxTags     = 4096

	manifestAccept = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, " +
		"application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"
)

type tagEntry struct {
	digest  string
	checked time.Time // when the registry last said the tag names digest
}

// upstreamError is the registry's own answer (404, 429, 5xx), forwarded to
// the builder as is.
type upstreamError struct{ code int }

func (e *upstreamError) Error() string {
	return fmt.Sprintf("mirror: the registry answered %d", e.code)
}

func (o *OCIProxy) serveCached(w http.ResponseWriter, r *http.Request, name, kind, ref string) {
	if kind == "manifests" && !IsDigest(ref) {
		o.serveTag(w, r, name, ref)
		return
	}
	metricKind := map[string]string{"blobs": "blob", "manifests": "manifest"}[kind]
	if o.serveStored(w, r, kind, ref) {
		o.Metrics.count(metricKind, "hit")
		return
	}
	if r.Method == http.MethodHead && kind == "blobs" {
		// A HEAD is not worth downloading a layer for: ask the registry.
		o.stream(w, r, name, kind, ref)
		return
	}
	o.Metrics.count(metricKind, "miss")
	accept := o.accept(r)
	if err := o.flights.do(r.Context(), ref, func() error {
		ctx, cancel := o.fetchContext()
		defer cancel()
		return o.fetchDigest(ctx, name, kind, ref, accept)
	}); err != nil {
		o.fail(w, err)
		return
	}
	if !o.serveStored(w, r, kind, ref) {
		// Evicted between its commit and this read: only when the cache is
		// smaller than what is being pulled at once.
		http.Error(w, "the mirror's cache is too small for this pull", http.StatusServiceUnavailable)
	}
}

func (o *OCIProxy) serveTag(w http.ResponseWriter, r *http.Request, name, tag string) {
	accept := o.accept(r)
	// What a tag names depends on what the builder accepts (an index, one
	// platform's manifest), so the answer is kept per Accept.
	key := name + ":" + tag + "\x00" + accept
	if e, ok := o.tag(key); ok && o.now().Sub(e.checked) < o.tagTTL() && o.serveStored(w, r, "manifests", e.digest) {
		o.Metrics.count("manifest", "hit")
		return
	}
	err := o.flights.do(r.Context(), "tag\x00"+key, func() error {
		ctx, cancel := o.fetchContext()
		defer cancel()
		return o.refreshTag(ctx, key, name, tag, accept)
	})
	e, ok := o.tag(key)
	if err == nil && ok && o.serveStored(w, r, "manifests", e.digest) {
		return
	}
	var ue *upstreamError
	transient := err != nil && (!errors.As(err, &ue) || ue.code == http.StatusTooManyRequests || ue.code >= 500)
	if transient && ok && o.now().Sub(e.checked) <= o.staleFor() && o.serveStored(w, r, "manifests", e.digest) {
		o.Metrics.count("manifest", "stale")
		o.log().Warn("mirror.manifest.stale", "repo", name, "tag", tag, "age_s", int(o.now().Sub(e.checked).Seconds()), "err", err.Error())
		return
	}
	if err == nil {
		err = errors.New("mirror: the tag's manifest left the cache")
	}
	o.fail(w, err)
}

// refreshTag asks the registry which manifest tag names now and makes sure
// the cache holds it.
func (o *OCIProxy) refreshTag(ctx context.Context, key, name, tag, accept string) error {
	if e, ok := o.tag(key); ok && o.stored(e.digest) {
		res, err := o.upstream(ctx, http.MethodHead, name, "manifests", tag, accept)
		if err != nil {
			return err
		}
		res.Body.Close()
		if res.Header.Get("Docker-Content-Digest") == e.digest {
			o.setTag(key, tagEntry{digest: e.digest, checked: o.now()})
			o.Metrics.count("manifest", "revalidated")
			return nil
		}
	}
	res, err := o.upstream(ctx, http.MethodGet, name, "manifests", tag, accept)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, manifestMax+1))
	if err != nil || len(body) > manifestMax {
		return errors.New("mirror: the tag's manifest could not be read whole")
	}
	d := sha256Digest(body)
	if h := res.Header.Get("Docker-Content-Digest"); h != "" && h != d {
		return ErrDigestMismatch
	}
	if err := o.put(d, bytes.NewReader(body), manifestMax); err != nil {
		return err
	}
	o.setTag(key, tagEntry{digest: d, checked: o.now()})
	o.Metrics.count("manifest", "miss")
	return nil
}

// fetchDigest downloads ref (a digest) into the store, which refuses bytes
// that are not that digest.
func (o *OCIProxy) fetchDigest(ctx context.Context, name, kind, ref, accept string) error {
	res, err := o.upstream(ctx, http.MethodGet, name, kind, ref, accept)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	limit := o.maxBytes()
	if kind == "manifests" {
		limit = manifestMax
	}
	if res.ContentLength > limit {
		return errors.New("mirror: larger than the mirror serves")
	}
	return o.put(ref, res.Body, limit)
}

func (o *OCIProxy) put(digest string, body io.Reader, limit int64) error {
	bw, err := o.Store.Create(digest)
	if err != nil {
		return err
	}
	n, err := io.Copy(bw, io.LimitReader(body, limit+1))
	if err != nil || n > limit {
		bw.Abort()
		return errors.New("mirror: the upstream body was cut or too large")
	}
	return bw.Commit()
}

// upstream asks the registry for one object; anything but 200 is an
// *upstreamError (the body is closed then).
func (o *OCIProxy) upstream(ctx context.Context, method, name, kind, ref, accept string) (*http.Response, error) {
	token, err := o.token(ctx, name)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, o.Registry.JoinPath("v2", name, kind, ref).String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if kind == "manifests" {
		req.Header.Set("Accept", accept)
	}
	res, err := o.client().Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, &upstreamError{code: res.StatusCode}
	}
	return res, nil
}

// serveStored answers from the store; false when digest is not there.
func (o *OCIProxy) serveStored(w http.ResponseWriter, r *http.Request, kind, digest string) bool {
	b, err := o.Store.Open(digest)
	if err != nil {
		return false
	}
	defer b.Close()
	var content io.ReadSeeker = b
	ctype := "application/octet-stream"
	if kind == "manifests" {
		m, err := io.ReadAll(io.LimitReader(b, manifestMax+1))
		if err != nil || len(m) > manifestMax {
			return false
		}
		ctype, content = manifestMediaType(m), bytes.NewReader(m)
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Docker-Content-Digest", digest)
	w.Header().Set("Etag", `"`+digest+`"`)
	// ServeContent answers HEAD and Range (a builder resuming a layer).
	http.ServeContent(w, r, "", time.Time{}, content)
	return true
}

// manifestMediaType is the type a stored manifest is served as: its own
// mediaType field (Docker's types always carry it), else the OCI type its
// shape says, since OCI makes the field optional.
func manifestMediaType(b []byte) string {
	var m struct {
		MediaType string          `json:"mediaType"`
		Manifests json.RawMessage `json:"manifests"`
	}
	_ = json.Unmarshal(b, &m)
	switch {
	case m.MediaType != "":
		return m.MediaType
	case m.Manifests != nil:
		return "application/vnd.oci.image.index.v1+json"
	default:
		return "application/vnd.oci.image.manifest.v1+json"
	}
}

func (o *OCIProxy) fail(w http.ResponseWriter, err error) {
	var ue *upstreamError
	switch {
	case errors.As(err, &ue):
		// The registry's own status (404, 429) tells the builder what happened.
		w.WriteHeader(ue.code)
	case errors.Is(err, ErrDigestMismatch):
		http.Error(w, "the registry served bytes that are not their digest", http.StatusBadGateway)
	default:
		http.Error(w, "the registry is unreachable", http.StatusBadGateway)
	}
}

func (o *OCIProxy) stored(digest string) bool {
	b, err := o.Store.Open(digest)
	if err != nil {
		return false
	}
	_ = b.Close()
	return true
}

func (o *OCIProxy) tag(key string) (tagEntry, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	e, ok := o.tags[key]
	return e, ok
}

// setTag records a confirmed tag. The map is bounded: past maxTags, the
// entries too old to be served stale go first.
func (o *OCIProxy) setTag(key string, e tagEntry) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.tags == nil {
		o.tags = map[string]tagEntry{}
	}
	if _, ok := o.tags[key]; !ok && len(o.tags) >= maxTags {
		for k, old := range o.tags {
			if e.checked.Sub(old.checked) > o.staleFor() {
				delete(o.tags, k)
			}
		}
		if len(o.tags) >= maxTags {
			clear(o.tags)
		}
	}
	o.tags[key] = e
}

// accept is what the builder accepts for a manifest, or every type the
// mirror can serve.
func (o *OCIProxy) accept(r *http.Request) string {
	if a := r.Header.Get("Accept"); a != "" && len(a) <= 1024 {
		return a
	}
	return manifestAccept
}

// fetchContext bounds a shared fetch on its own: it outlives the request
// that started it (flightGroup).
func (o *OCIProxy) fetchContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 10*time.Minute)
}

func (o *OCIProxy) tagTTL() time.Duration {
	if o.TagTTL > 0 {
		return o.TagTTL
	}
	return 10 * time.Minute
}

func (o *OCIProxy) staleFor() time.Duration {
	if o.StaleFor > 0 {
		return o.StaleFor
	}
	return 6 * time.Hour
}

func (o *OCIProxy) log() *slog.Logger {
	if o.Log != nil {
		return o.Log
	}
	return slog.New(slog.DiscardHandler)
}

func sha256Digest(b []byte) string {
	s := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(s[:])
}
