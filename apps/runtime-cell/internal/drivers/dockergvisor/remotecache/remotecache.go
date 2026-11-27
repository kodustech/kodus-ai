// Package remotecache keeps an environment's exported BuildKit cache off the
// cell (docs/runtime/build-cache.md), so it outlives the cell's disk floor:
// the default branch's setup pushes the cache its build exported, and a build
// that finds the environment's state and exported cache gone pulls it back.
//
// The store is an OCI distribution registry. What moves is a BuildKit local
// cache (an OCI image layout: index.json and blobs/sha256), pushed by the cell
// itself, never by the builder: the builder runs the code under test and
// holds no credential and no route to the store. One repository per org,
// environment and service, named from hashes that start with the org's
// (Key.Repository), so no two orgs ever share one and a registry can scope a
// credential to an org's prefix. Every blob is checked against its digest and
// size as it is pulled, before the cache is handed to a build.
//
// What it does not do: it knows no Docker and no BuildKit, and it never
// decides who may write. The driver pushes only a seeding setup's cache (the
// default branch's, S-52), so nothing a pull request built reaches the store.
package remotecache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// Media types of what the cell pushes: an OCI image manifest whose config is
// the cache's index.json and whose layers are the cache's blobs, as they are.
const (
	ManifestMediaType = "application/vnd.oci.image.manifest.v1+json"
	ArtifactType      = "application/vnd.kodus.buildkit-cache.v1"
	IndexMediaType    = "application/vnd.kodus.buildkit-cache.index.v1+json"
	BlobMediaType     = "application/octet-stream"
	// Tag is the one tag of an environment's cache: the latest seed's.
	Tag = "cache"
)

// Bounds of what a push or a pull moves.
const (
	maxManifestBytes = 4 << 20
	maxIndexBytes    = 1 << 20
	maxBlobs         = 20_000
	// DefaultMaxBytes bounds one cache, all blobs together.
	DefaultMaxBytes int64 = 40 << 30
)

// Key names one environment's cache of one service.
type Key struct {
	Org, Env, Service string
}

func hashOf(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		fmt.Fprintf(h, "%d:%s", len(p), p)
	}
	return hex.EncodeToString(h.Sum(nil))[:32]
}

// Repository is the key's repository under prefix: <prefix>/o-<org>/e-<env,
// service>, each a hash. The org's hash is its own path segment, so a
// registry's access rule can grant one org's prefix and nothing else.
func (k Key) Repository(prefix string) string {
	return prefix + "/o-" + hashOf(k.Org) + "/e-" + hashOf(k.Org, k.Env, k.Service)
}

func (k Key) valid() bool { return k.Org != "" && k.Env != "" && k.Service != "" }

// Stats is what a push or a pull moved.
type Stats struct {
	Blobs, Moved int
	Bytes        int64
	MovedBytes   int64
}

// ErrNotFound is a pull of a cache nobody pushed.
var ErrNotFound = errors.New("remotecache: no cache for this environment")

// Registry is the store over an OCI distribution registry (distribution,
// zot, ECR with a token refresher; docs/runtime/build-cache.md).
type Registry struct {
	base     *url.URL
	prefix   string
	user     string
	password string
	// token, when set, is asked on every request for a bearer token: a claim's store credential,
	// renewed while a long push or pull runs.
	token    func() string
	http     *http.Client
	maxBytes int64
}

// Config is the store's location: URL is http(s)://host[:port]/<prefix>.
// Plain HTTP is taken only for a loopback host. Auth is "user:password"
// for basic auth, or empty.
type Config struct {
	URL  string
	Auth string
	// Token, when set, takes the place of Auth: the registry gets `Authorization: Bearer <Token()>`.
	Token    func() string
	MaxBytes int64
	HTTP     *http.Client
}

var repoSegment = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`)

// New checks the location and makes the store.
func New(c Config) (*Registry, error) {
	u, err := url.Parse(c.URL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("remotecache: %q is not http(s)://host/prefix", c.URL)
	}
	if u.Scheme == "http" && !loopback(u.Hostname()) {
		return nil, fmt.Errorf("remotecache: plain HTTP only to a loopback registry, not %s", u.Hostname())
	}
	prefix := strings.Trim(u.Path, "/")
	if prefix == "" {
		return nil, errors.New("remotecache: the URL names no repository prefix")
	}
	for _, seg := range strings.Split(prefix, "/") {
		if !repoSegment.MatchString(seg) {
			return nil, fmt.Errorf("remotecache: prefix segment %q is not a repository name", seg)
		}
	}
	r := &Registry{base: &url.URL{Scheme: u.Scheme, Host: u.Host}, prefix: prefix, maxBytes: c.MaxBytes}
	client := http.Client{}
	if c.HTTP != nil {
		client = *c.HTTP
	}
	// Go keeps the Authorization header on a redirect to the same host name
	// on another port: the store drops it for anything but the registry.
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("remotecache: too many redirects")
		}
		if !sameHost(req.URL, r.base) {
			req.Header.Del("Authorization")
		}
		return nil
	}
	r.http = &client
	if r.maxBytes <= 0 {
		r.maxBytes = DefaultMaxBytes
	}
	r.token = c.Token
	if c.Auth != "" && c.Token == nil {
		user, pass, ok := strings.Cut(c.Auth, ":")
		if !ok || user == "" {
			return nil, errors.New("remotecache: auth is user:password")
		}
		r.user, r.password = user, pass
	}
	return r, nil
}

func loopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Where says where the store is, with no credential: for a log line.
func (r *Registry) Where() string { return r.base.String() + "/" + r.prefix }

type descriptor struct {
	MediaType string `json:"mediaType"`
	Digest    string `json:"digest"`
	Size      int64  `json:"size"`
}

type manifest struct {
	SchemaVersion int          `json:"schemaVersion"`
	MediaType     string       `json:"mediaType"`
	ArtifactType  string       `json:"artifactType,omitempty"`
	Config        descriptor   `json:"config"`
	Layers        []descriptor `json:"layers"`
}

// ociIndex is the part of a BuildKit cache's index.json the store checks:
// every descriptor names a blob of the cache.
type ociIndex struct {
	SchemaVersion int          `json:"schemaVersion"`
	Manifests     []descriptor `json:"manifests"`
}

var digestRE = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func (r *Registry) request(ctx context.Context, method, path string, body io.Reader, size int64, header map[string]string) (*http.Response, error) {
	u := path
	if !strings.HasPrefix(path, "http://") && !strings.HasPrefix(path, "https://") {
		u = r.base.String() + path
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.ContentLength = size
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	if sameHost(req.URL, r.base) {
		if r.token != nil {
			req.Header.Set("Authorization", "Bearer "+r.token())
		} else if r.user != "" {
			req.SetBasicAuth(r.user, r.password)
		}
	}
	return r.http.Do(req)
}

// sameHost: the credential goes only to the registry, never to where a blob
// read redirects (an S3-backed registry hands out signed URLs).
func sameHost(a, b *url.URL) bool { return a.Scheme == b.Scheme && a.Host == b.Host }

func drain(resp *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
}

func statusErr(what string, resp *http.Response) error {
	return fmt.Errorf("remotecache: %s: registry answered %d", what, resp.StatusCode)
}

// Push sends the cache in dir (a BuildKit local cache) as the key's cache:
// the blobs the registry does not hold, then the manifest under Tag.
func (r *Registry) Push(ctx context.Context, k Key, dir string) (Stats, error) {
	var st Stats
	if !k.valid() {
		return st, errors.New("remotecache: key needs org, environment and service")
	}
	repo := k.Repository(r.prefix)
	// dir is the builder's /cache-out: the builder wrote every entry of it,
	// so nothing in it is trusted. The root keeps every read inside it (a
	// link out of it fails), and each entry must be what a BuildKit export
	// writes: directories and regular files, never a link.
	root, err := os.OpenRoot(dir)
	if err != nil {
		return st, fmt.Errorf("remotecache: %w", err)
	}
	defer func() { _ = root.Close() }()
	idx, err := readRegular(root, "index.json", maxIndexBytes)
	if err != nil {
		return st, fmt.Errorf("remotecache: index.json: %w", err)
	}
	blobs, err := r.localBlobs(root)
	if err != nil {
		return st, err
	}
	if err := checkIndex(idx, blobs); err != nil {
		return st, err
	}
	m := manifest{SchemaVersion: 2, MediaType: ManifestMediaType, ArtifactType: ArtifactType}
	for _, b := range blobs {
		st.Blobs++
		st.Bytes += b.Size
		moved, err := r.pushBlob(ctx, repo, b, func() (io.ReadCloser, error) { return openBlob(root, b) })
		if err != nil {
			return st, err
		}
		if moved {
			st.Moved++
			st.MovedBytes += b.Size
		}
		m.Layers = append(m.Layers, descriptor{MediaType: BlobMediaType, Digest: b.Digest, Size: b.Size})
	}
	cfg := descriptor{MediaType: IndexMediaType, Digest: digestOf(idx), Size: int64(len(idx))}
	if _, err := r.pushBlob(ctx, repo, cfg, func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(string(idx))), nil }); err != nil {
		return st, err
	}
	m.Config = cfg
	body, err := json.Marshal(m)
	if err != nil {
		return st, err
	}
	if len(body) > maxManifestBytes {
		return st, fmt.Errorf("remotecache: the cache has too many blobs for one manifest (%d bytes)", len(body))
	}
	resp, err := r.request(ctx, http.MethodPut, "/v2/"+repo+"/manifests/"+Tag, strings.NewReader(string(body)), int64(len(body)), map[string]string{"Content-Type": ManifestMediaType})
	if err != nil {
		return st, fmt.Errorf("remotecache: manifest: %w", err)
	}
	defer drain(resp)
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return st, statusErr("manifest", resp)
	}
	return st, nil
}

// localBlobs lists the cache's blobs: regular files named by their digest,
// within the bounds. blobs and blobs/sha256 must be real directories, every
// entry of blobs/sha256 a regular file (a link or anything else refuses the
// whole cache), and every blob's bytes must hash to its name: all of it is
// checked before the first byte leaves the cell, so a tampered cache pushes
// nothing. The upload checks the digest again as it reads (openBlob).
func (r *Registry) localBlobs(root *os.Root) ([]descriptor, error) {
	for _, d := range []string{"blobs", filepath.Join("blobs", "sha256")} {
		info, err := root.Lstat(d)
		if err != nil {
			return nil, fmt.Errorf("remotecache: blobs: %w", err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("remotecache: %s is not a directory", d)
		}
	}
	dir, err := root.Open(filepath.Join("blobs", "sha256"))
	if err != nil {
		return nil, fmt.Errorf("remotecache: blobs: %w", err)
	}
	entries, err := dir.ReadDir(-1)
	_ = dir.Close()
	if err != nil {
		return nil, fmt.Errorf("remotecache: blobs: %w", err)
	}
	var out []descriptor
	var total int64
	for _, e := range entries {
		if !e.Type().IsRegular() {
			return nil, fmt.Errorf("remotecache: blobs/sha256/%s is not a regular file", e.Name())
		}
		d := "sha256:" + e.Name()
		if !digestRE.MatchString(d) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			return nil, err
		}
		if len(out) >= maxBlobs {
			return nil, fmt.Errorf("remotecache: the cache holds more than %d blobs", maxBlobs)
		}
		if total += info.Size(); total > r.maxBytes {
			return nil, fmt.Errorf("remotecache: the cache passes %d bytes", r.maxBytes)
		}
		b := descriptor{Digest: d, Size: info.Size()}
		if err := verifyBlob(root, b); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}

// verifyBlob reads a blob whole and fails unless its bytes are its digest.
func verifyBlob(root *os.Root, b descriptor) error {
	f, err := openBlob(root, b)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	_, err = io.Copy(io.Discard, f)
	return err
}

// errBlobDigest is a blob whose bytes are not its name.
var errBlobDigest = errors.New("does not match its digest")

// openBlob opens a blob of the cache for reading: a regular file inside the
// root (the one Lstat saw, so a link swapped in after is refused), whose
// reads hash it and fail, holding back its last bytes, unless it is exactly
// b.Size bytes of digest b.Digest. An upload cut short is never committed.
func openBlob(root *os.Root, b descriptor) (io.ReadCloser, error) {
	f, err := openRegular(root, blobPath(b.Digest))
	if err != nil {
		return nil, fmt.Errorf("remotecache: blob %s: %w", short(b.Digest), err)
	}
	return &digestReader{f: f, h: sha256.New(), want: b.Digest, left: b.Size}, nil
}

type digestReader struct {
	f    *os.File
	h    hash.Hash
	want string
	left int64
	done bool
}

func (v *digestReader) Read(p []byte) (int, error) {
	if v.done {
		return 0, io.EOF
	}
	if len(p) == 0 {
		return 0, nil
	}
	if int64(len(p)) > v.left {
		p = p[:v.left]
	}
	n, err := io.ReadFull(v.f, p)
	v.h.Write(p[:n])
	v.left -= int64(n)
	if err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			err = fmt.Errorf("remotecache: blob %s is shorter than its size", short(v.want))
		}
		return 0, err
	}
	if v.left > 0 {
		return n, nil
	}
	// The last bytes go out only if the blob is whole and its digest.
	var extra [1]byte
	if m, _ := v.f.Read(extra[:]); m > 0 {
		return 0, fmt.Errorf("remotecache: blob %s is longer than its size", short(v.want))
	}
	if "sha256:"+hex.EncodeToString(v.h.Sum(nil)) != v.want {
		return 0, fmt.Errorf("remotecache: blob %s %w", short(v.want), errBlobDigest)
	}
	v.done = true
	return n, nil
}

func (v *digestReader) Close() error { return v.f.Close() }

// pushBlob sends one blob unless the repository holds it already (true: it was sent).
func (r *Registry) pushBlob(ctx context.Context, repo string, b descriptor, open func() (io.ReadCloser, error)) (bool, error) {
	resp, err := r.request(ctx, http.MethodHead, "/v2/"+repo+"/blobs/"+b.Digest, nil, 0, nil)
	if err != nil {
		return false, fmt.Errorf("remotecache: blob %s: %w", short(b.Digest), err)
	}
	drain(resp)
	if resp.StatusCode == http.StatusOK {
		return false, nil
	}
	resp, err = r.request(ctx, http.MethodPost, "/v2/"+repo+"/blobs/uploads/", nil, 0, nil)
	if err != nil {
		return false, fmt.Errorf("remotecache: upload %s: %w", short(b.Digest), err)
	}
	drain(resp)
	if resp.StatusCode != http.StatusAccepted {
		return false, statusErr("upload", resp)
	}
	loc, err := resp.Location()
	if err != nil {
		return false, fmt.Errorf("remotecache: upload location: %w", err)
	}
	if !sameHost(loc, r.base) {
		return false, fmt.Errorf("remotecache: the registry sent the upload to another host (%s)", loc.Host)
	}
	q := loc.Query()
	q.Set("digest", b.Digest)
	loc.RawQuery = q.Encode()
	f, err := open()
	if err != nil {
		return false, err
	}
	defer func() { _ = f.Close() }()
	resp, err = r.request(ctx, http.MethodPut, loc.String(), f, b.Size, map[string]string{"Content-Type": "application/octet-stream"})
	if err != nil {
		return false, fmt.Errorf("remotecache: blob %s: %w", short(b.Digest), err)
	}
	drain(resp)
	if resp.StatusCode != http.StatusCreated {
		return false, statusErr("blob "+short(b.Digest), resp)
	}
	return true, nil
}

// Pull writes the key's cache into dir (which must not exist) as a BuildKit
// local cache: every blob checked against its digest and size, index.json
// last, so a cache cut short is never one a build reads (no index.json).
func (r *Registry) Pull(ctx context.Context, k Key, dir string) (Stats, error) {
	var st Stats
	if !k.valid() {
		return st, errors.New("remotecache: key needs org, environment and service")
	}
	repo := k.Repository(r.prefix)
	resp, err := r.request(ctx, http.MethodGet, "/v2/"+repo+"/manifests/"+Tag, nil, 0, map[string]string{"Accept": ManifestMediaType})
	if err != nil {
		return st, fmt.Errorf("remotecache: manifest: %w", err)
	}
	if resp.StatusCode == http.StatusNotFound {
		drain(resp)
		return st, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		drain(resp)
		return st, statusErr("manifest", resp)
	}
	body, err := readBounded(resp.Body, maxManifestBytes)
	drain(resp)
	if err != nil {
		return st, fmt.Errorf("remotecache: manifest: %w", err)
	}
	var m manifest
	if err := json.Unmarshal(body, &m); err != nil {
		return st, fmt.Errorf("remotecache: manifest: %w", err)
	}
	if m.SchemaVersion != 2 || m.MediaType != ManifestMediaType || m.ArtifactType != ArtifactType || m.Config.MediaType != IndexMediaType || !digestRE.MatchString(m.Config.Digest) || m.Config.Size <= 0 || m.Config.Size > maxIndexBytes {
		return st, errors.New("remotecache: the manifest is not a build cache the cell pushed")
	}
	if len(m.Layers) > maxBlobs {
		return st, fmt.Errorf("remotecache: the manifest names more than %d blobs", maxBlobs)
	}
	var total int64
	for _, l := range m.Layers {
		if !digestRE.MatchString(l.Digest) || l.Size < 0 {
			return st, errors.New("remotecache: the manifest names a blob that is not sha256")
		}
		if total += l.Size; total > r.maxBytes {
			return st, fmt.Errorf("remotecache: the cache passes %d bytes", r.maxBytes)
		}
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		return st, err
	}
	ok := false
	defer func() {
		if !ok {
			_ = os.RemoveAll(dir)
		}
	}()
	idx, err := r.fetchBytes(ctx, repo, m.Config)
	if err != nil {
		return st, err
	}
	if err := checkIndex(idx, m.Layers); err != nil {
		return st, err
	}
	if err := os.MkdirAll(filepath.Join(dir, "blobs", "sha256"), 0o700); err != nil {
		return st, err
	}
	seen := map[string]bool{}
	for _, l := range m.Layers {
		if seen[l.Digest] {
			continue
		}
		seen[l.Digest] = true
		if err := r.fetchFile(ctx, repo, l, filepath.Join(dir, blobPath(l.Digest))); err != nil {
			return st, err
		}
		st.Blobs++
		st.Moved++
		st.Bytes += l.Size
		st.MovedBytes += l.Size
	}
	if err := os.WriteFile(filepath.Join(dir, "oci-layout"), []byte(`{"imageLayoutVersion":"1.0.0"}`), 0o600); err != nil {
		return st, err
	}
	if err := os.WriteFile(filepath.Join(dir, "index.json"), idx, 0o600); err != nil {
		return st, err
	}
	ok = true
	return st, nil
}

func (r *Registry) blob(ctx context.Context, repo string, d descriptor) (*http.Response, error) {
	resp, err := r.request(ctx, http.MethodGet, "/v2/"+repo+"/blobs/"+d.Digest, nil, 0, nil)
	if err != nil {
		return nil, fmt.Errorf("remotecache: blob %s: %w", short(d.Digest), err)
	}
	if resp.StatusCode != http.StatusOK {
		drain(resp)
		return nil, statusErr("blob "+short(d.Digest), resp)
	}
	return resp, nil
}

func (r *Registry) fetchBytes(ctx context.Context, repo string, d descriptor) ([]byte, error) {
	resp, err := r.blob(ctx, repo, d)
	if err != nil {
		return nil, err
	}
	defer drain(resp)
	b, err := readBounded(resp.Body, d.Size)
	if err != nil {
		return nil, err
	}
	if int64(len(b)) != d.Size || digestOf(b) != d.Digest {
		return nil, fmt.Errorf("remotecache: blob %s does not match its digest", short(d.Digest))
	}
	return b, nil
}

// fetchFile streams a blob to path, hashing it on the way; a blob that is
// longer, shorter or other than its digest is removed and fails the pull.
func (r *Registry) fetchFile(ctx context.Context, repo string, d descriptor, path string) error {
	resp, err := r.blob(ctx, repo, d)
	if err != nil {
		return err
	}
	defer drain(resp)
	tmp := path + ".part"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) //nolint:gosec // G304: a new file in the cell's own cache directory
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, d.Size+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && (n != d.Size || "sha256:"+hex.EncodeToString(h.Sum(nil)) != d.Digest) {
		err = fmt.Errorf("remotecache: blob %s does not match its digest", short(d.Digest))
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

// checkIndex refuses an index.json that is not an OCI index, or names a
// blob the cache does not carry: BuildKit would import a cache with holes.
func checkIndex(idx []byte, blobs []descriptor) error {
	var ix ociIndex
	if err := json.Unmarshal(idx, &ix); err != nil || ix.SchemaVersion != 2 || len(ix.Manifests) == 0 {
		return errors.New("remotecache: index.json is not an OCI index of a cache")
	}
	have := map[string]bool{}
	for _, b := range blobs {
		have[b.Digest] = true
	}
	for _, d := range ix.Manifests {
		if !digestRE.MatchString(d.Digest) || !have[d.Digest] {
			return fmt.Errorf("remotecache: index.json names %s, which the cache does not carry", short(d.Digest))
		}
	}
	return nil
}

// blobPath is a blob's path relative to a cache's directory.
func blobPath(digest string) string {
	return filepath.Join("blobs", "sha256", strings.TrimPrefix(digest, "sha256:"))
}

func digestOf(b []byte) string {
	s := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(s[:])
}

func short(d string) string {
	d = strings.TrimPrefix(d, "sha256:")
	if len(d) > 12 {
		return d[:12]
	}
	return d
}

func readBounded(r io.Reader, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("remotecache: more than %d bytes", limit)
	}
	return b, nil
}

// readRegular reads a regular file inside root (never a link), bounded.
func readRegular(root *os.Root, name string, limit int64) ([]byte, error) {
	f, err := openRegular(root, name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return readBounded(f, limit)
}

// openRegular opens name inside root only if it is a regular file, and the
// same file its Lstat saw: an entry swapped for a link, a FIFO or a device
// between the two is refused (O_NONBLOCK: opening a FIFO does not hang).
func openRegular(root *os.Root, name string) (*os.File, error) {
	before, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	f, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	after, err := f.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		_ = f.Close()
		return nil, errors.New("not a regular file")
	}
	return f, nil
}

// DefaultPullTimeout bounds a pull on a build's path: past it the build runs cold.
const DefaultPullTimeout = 10 * time.Minute
