package mirror

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// ArtifactEntry is one known read-only build artifact the mirror serves
// (docs/runtime/egress-allowlist.md §17): not a host, but an exact upstream
// (scheme and host), a path prefix inside it, and the one shape a file name
// under that prefix may have. A path the entry does not spell is not served.
type ArtifactEntry struct {
	// ID is the entry's segment under /artifacts/.
	ID string
	// Upstream is the https origin: scheme and host, no path.
	Upstream *url.URL
	// PathPrefix is the upstream path the artifacts live under ("/a/b/"),
	// slashes both ends.
	PathPrefix string
	// Name is what a request may spell after PathPrefix, whole.
	Name *regexp.Regexp
	// MaxBytes bounds one response.
	MaxBytes int64
}

// nameRE is a name pattern that must match the whole name.
func nameRE(pattern string) *regexp.Regexp { return regexp.MustCompile(`^(?:` + pattern + `)$`) }

func (e ArtifactEntry) matches(name string) bool { return e.Name.MatchString(name) }

// DefaultArtifacts is the fixed, reviewed list. A change is a PR a security
// code owner approves (it is part of the egress list's change rule).
//
// None is pinned by checksum here: each is addressed by a version the tool
// asks for, and the tool checks what it downloads (Prisma's .gz.sha256 and .sha256
// next to each engine, mongodb-memory-server's .md5, firebase-tools' own
// expected hash per emulator version), as npm's client checks a lockfile's
// integrity. A hash list here would have to follow every release of three
// publishers and would break builds the day one ships. What the mirror keeps
// closed is the path (prefix plus a name that cannot spell a slash, a query
// or an escape), the method (GET and HEAD), the size and the source.
func DefaultArtifacts() []ArtifactEntry {
	mustURL := func(s string) *url.URL {
		u, err := url.Parse(s)
		if err != nil {
			panic(err)
		}
		return u
	}
	return []ArtifactEntry{
		// firebase-tools (13.35.1 and 14.27.0, lib/emulator/downloadableEmulators.js
		// and downloadableEmulatorInfo.json) downloads its emulators from this
		// bucket path: three jars, the UI zip and the Pub/Sub zip, each named
		// by an exact version. The bucket host is on the deny list on purpose
		// (writable object storage): this is the one read-only prefix. The UI
		// "SNAPSHOT" zip (an experiment, no checksum) is not spelled here.
		{
			ID: "firebase-emulators", Upstream: mustURL("https://storage.googleapis.com"), PathPrefix: "/firebase-preview-drop/emulator/",
			Name: nameRE(`(?:firebase-database-emulator-v|cloud-firestore-emulator-v|cloud-storage-rules-runtime-v)[0-9]+\.[0-9]+\.[0-9]+\.jar|(?:ui-v|pubsub-emulator-)[0-9]+\.[0-9]+\.[0-9]+\.zip`), MaxBytes: 256 << 20,
		},
		// The Data Connect emulator, a Linux binary from a second bucket path:
		// `-linux-v<ver>` in 13.x, `-linux-amd64-v<ver>` in 14.x (there is no
		// arm64 build on Linux in either).
		{
			ID: "firebase-dataconnect", Upstream: mustURL("https://storage.googleapis.com"), PathPrefix: "/firemat-preview-drop/emulator/",
			Name: nameRE(`dataconnect-emulator-linux(?:-amd64)?-v[0-9]+\.[0-9]+\.[0-9]+`), MaxBytes: 256 << 20,
		},
		// Prisma's engines (@prisma/fetch-engine 5.22.0 and 6.19.3, getDownloadUrl):
		// <PRISMA_ENGINES_MIRROR>/all_commits/<engines commit>/<binary target>/<engine>.gz,
		// plus both checksums downloadZip fetches before it: `<engine>.gz.sha256`
		// (the zip) and `<engine>.sha256` (the engine unzipped). Nothing else:
		// the `.sig` the publisher also keeps is never requested, nor is the
		// engine unzipped. The three engine names are the BinaryType values; an
		// engine is about 8 MB.
		{
			ID: "prisma", Upstream: mustURL("https://binaries.prisma.sh"), PathPrefix: "/all_commits/",
			Name: nameRE(`[0-9a-f]{40}/(?:(?:debian|rhel)-openssl-[0-9]+\.[0-9]+\.x|linux-(?:musl-)?(?:arm64-)?openssl-[0-9]+\.[0-9]+\.x|linux-musl|linux-static-(?:x64|arm64))/(?:libquery_engine\.so\.node|query-engine|schema-engine)(?:\.gz(?:\.sha256)?|\.sha256)`), MaxBytes: 64 << 20,
		},
		// The Cypress app (cypress 13.x and 14.x, lib/tasks/download.js): its
		// npm package's postinstall downloads it, and `cypress run` needs it.
		// With CYPRESS_DOWNLOAD_MIRROR=<root>/cypress and the path template
		// buildmirror sets, the URL is <root>/cypress/desktop/<version>/
		// linux-<x64|arm64>/cypress.zip: the exact object download.cypress.io
		// redirects to on cdn.cypress.io (about 200 MB). The CDN's
		// x-amz-meta-checksum goes through (integrityHeaders): the package
		// checks the zip's SHA-512 against it.
		{
			ID: "cypress", Upstream: mustURL("https://cdn.cypress.io"), PathPrefix: "/desktop/",
			Name: nameRE(`[0-9]+\.[0-9]+\.[0-9]+/linux-(?:x64|arm64)/cypress\.zip`), MaxBytes: 512 << 20,
		},
		// MongoDB server builds for Linux (mongodb-memory-server-core 9.5.0 and
		// 10.4.3, MongoBinaryDownloadUrl and MongoBinaryDownload):
		// <MONGOMS_DOWNLOAD_MIRROR>/linux/mongodb-linux-<x86_64|aarch64>[-<distro>]-<version>.tgz
		// and the `.tgz.md5` it checks it against (no `.sha256` is requested).
		{
			ID: "mongodb", Upstream: mustURL("https://fastdl.mongodb.org"), PathPrefix: "/linux/",
			Name: nameRE(`mongodb-linux-(?:x86_64|aarch64)-(?:[a-z]+[0-9]+(?:-clang)?-)?[0-9]+\.[0-9]+\.[0-9]+(?:-rc[0-9]+)?\.tgz(?:\.md5)?`), MaxBytes: 512 << 20,
		},
	}
}

// ArtifactProxy serves /artifacts/<id>/<upstream path>: the upstream path of
// an entry, GET or HEAD, no query, from a claim of this cell, no credential.
type ArtifactProxy struct {
	entries []ArtifactEntry
	allowed func(*http.Request) bool
	client  *http.Client
}

// NewArtifacts is the proxy of entries. allowed decides whether the request
// is from a claim of this cell; nil refuses everything.
func NewArtifacts(entries []ArtifactEntry, allowed func(*http.Request) bool) *ArtifactProxy {
	return &ArtifactProxy{entries: entries, allowed: allowed, client: &http.Client{
		Timeout:       10 * time.Minute,
		Transport:     &http.Transport{DisableCompression: true, Proxy: nil, ResponseHeaderTimeout: time.Minute},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// integrityHeaders are the publisher's own checksum and size of an object,
// which a client checks what it downloaded against (Cypress's install reads
// both): passed on when they are plain tokens, never any other header.
var integrityHeaders = []string{"X-Amz-Meta-Checksum", "X-Amz-Meta-Size"}

var integrityValue = regexp.MustCompile(`^[0-9a-fA-F]{1,256}$`)

// credentialHeaders say the request carries an identity: a private object
// would be reached with it, and the mirror serves public ones only.
var credentialHeaders = []string{"Authorization", "Cookie", "Proxy-Authorization", "X-Goog-Api-Key", "X-Goog-Iam-Authorization-Token", "X-Amz-Security-Token"}

func (p *ArtifactProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "the mirror is read only: a write goes nowhere from a claim", http.StatusMethodNotAllowed)
		return
	}
	for _, h := range credentialHeaders {
		if r.Header.Get(h) != "" {
			http.Error(w, "the mirror serves public artifacts only", http.StatusUnauthorized)
			return
		}
	}
	if p.allowed == nil || !p.allowed(r) {
		http.Error(w, "not a claim of this cell", http.StatusForbidden)
		return
	}
	e, upPath, ok := p.route(r)
	if !ok {
		http.Error(w, errNotServed.Error(), http.StatusNotFound)
		return
	}
	p.fetch(w, r, e, upPath)
}

// route maps /artifacts/<id>/<path> to its entry and the upstream path, or
// not ok: any query, escape, backslash, empty or dot segment is refused
// before the entry's own pattern is asked.
func (p *ArtifactProxy) route(r *http.Request) (ArtifactEntry, string, bool) {
	raw := r.URL.EscapedPath()
	if strings.ContainsAny(r.RequestURI, "?#") || r.URL.RawQuery != "" || r.URL.ForceQuery || strings.ContainsAny(raw, "%\\") || strings.Contains(raw, "//") || hasDot(raw) {
		return ArtifactEntry{}, "", false
	}
	rest, ok := strings.CutPrefix(raw, "/artifacts/")
	if !ok {
		return ArtifactEntry{}, "", false
	}
	id, rest, ok := strings.Cut(rest, "/")
	if !ok {
		return ArtifactEntry{}, "", false
	}
	for _, e := range p.entries {
		if e.ID != id {
			continue
		}
		name, ok := strings.CutPrefix("/"+rest, e.PathPrefix)
		if !ok || !e.matches(name) {
			return ArtifactEntry{}, "", false
		}
		return e, e.PathPrefix + name, true
	}
	return ArtifactEntry{}, "", false
}

func (p *ArtifactProxy) fetch(w http.ResponseWriter, r *http.Request, e ArtifactEntry, upPath string) {
	up := *e.Upstream
	up.Path, up.RawPath, up.RawQuery = upPath, "", ""
	req, err := http.NewRequestWithContext(r.Context(), r.Method, up.String(), nil)
	if err != nil {
		http.Error(w, "bad upstream request", http.StatusBadGateway)
		return
	}
	req.Header.Set("Accept-Encoding", "identity")
	resp, err := p.client.Do(req) //nolint:gosec // G704: same fixed upstream
	if err != nil {
		http.Error(w, "upstream unreachable: "+e.Upstream.Host, http.StatusBadGateway)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		code := http.StatusBadGateway
		if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusForbidden {
			code = http.StatusNotFound // a bucket answers 403 for a name it does not have
		}
		http.Error(w, fmt.Sprintf("upstream answered %d", resp.StatusCode), code)
		return
	}
	if resp.ContentLength > e.MaxBytes {
		http.Error(w, "file larger than the mirror serves", http.StatusBadGateway)
		return
	}
	for _, h := range integrityHeaders {
		if v := resp.Header.Get(h); integrityValue.MatchString(v) {
			w.Header().Set(h, v)
		}
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if resp.ContentLength >= 0 {
		w.Header().Set("Content-Length", fmt.Sprint(resp.ContentLength))
	}
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	n, err := io.Copy(w, io.LimitReader(resp.Body, e.MaxBytes+1))
	if err != nil || n > e.MaxBytes {
		// Cut the connection: a short body must not look like a whole file.
		panic(http.ErrAbortHandler)
	}
}
