package tarball

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type entry struct {
	name     string
	typ      byte
	body     string
	linkname string
	mode     int64
}

func archive(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Typeflag: tar.TypeXGlobalHeader, Name: "pax_global_header", PAXRecords: map[string]string{"comment": "abc"}})
	for _, e := range entries {
		mode := e.mode
		if mode == 0 {
			mode = 0o644
		}
		h := &tar.Header{Name: e.name, Typeflag: e.typ, Mode: mode, Size: int64(len(e.body)), Linkname: e.linkname}
		if e.typ != tar.TypeReg {
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if e.typ == tar.TypeReg {
			_, _ = tw.Write([]byte(e.body))
		}
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func TestExtractGood(t *testing.T) {
	dest := t.TempDir()
	st, err := Extract(bytes.NewReader(archive(t,
		entry{name: "o-r-abc/", typ: tar.TypeDir},
		entry{name: "o-r-abc/src/", typ: tar.TypeDir},
		entry{name: "o-r-abc/src/main.go", typ: tar.TypeReg, body: "package main"},
		entry{name: "o-r-abc/run.sh", typ: tar.TypeReg, body: "#!/bin/sh", mode: 0o4755},
		entry{name: "o-r-abc/.gitmodules", typ: tar.TypeReg, body: "[submodule]"},
	)), dest, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if st.Files != 3 || st.Prefix != "o-r-abc" {
		t.Fatalf("%+v", st)
	}
	fi, err := os.Stat(filepath.Join(dest, "run.sh"))
	if err != nil || fi.Mode().Perm() != 0o755 || fi.Mode()&os.ModeSetuid != 0 {
		t.Fatalf("mode %v %v", fi.Mode(), err)
	}
}

// S-05: every hostile shape refuses the whole archive and leaves dest empty.
func TestExtractRefusesHostileRepos(t *testing.T) {
	cases := map[string][]entry{
		"symlink out":        {{name: "p/", typ: tar.TypeDir}, {name: "p/etc", typ: tar.TypeSymlink, linkname: "/etc"}},
		"relative symlink":   {{name: "p/a", typ: tar.TypeSymlink, linkname: "../../.."}},
		"hard link":          {{name: "p/a", typ: tar.TypeReg, body: "x"}, {name: "p/b", typ: tar.TypeLink, linkname: "/etc/passwd"}},
		"dot dot":            {{name: "p/../../evil", typ: tar.TypeReg, body: "x"}},
		"absolute":           {{name: "/tmp/evil", typ: tar.TypeReg, body: "x"}},
		"git hook":           {{name: "p/.git/hooks/post-checkout", typ: tar.TypeReg, body: "#!/bin/sh\ncurl x", mode: 0o755}},
		"nested git dir":     {{name: "p/vendor/x/.git/config", typ: tar.TypeReg, body: "[core]"}},
		"device":             {{name: "p/dev", typ: tar.TypeChar}},
		"fifo":               {{name: "p/fifo", typ: tar.TypeFifo}},
		"two roots":          {{name: "p/a", typ: tar.TypeReg, body: "x"}, {name: "q/b", typ: tar.TypeReg, body: "x"}},
		"non canonical":      {{name: "p/./a", typ: tar.TypeReg, body: "x"}},
		"backslash":          {{name: `p\..\a`, typ: tar.TypeReg, body: "x"}},
		"file then same dir": {{name: "p/a", typ: tar.TypeReg, body: "x"}, {name: "p/a/b", typ: tar.TypeReg, body: "y"}},
		// Links that read as inside but land outside through another link.
		"chain out": {{name: "p/a/", typ: tar.TypeDir}, {name: "p/a/b/", typ: tar.TypeDir}, {name: "p/k/", typ: tar.TypeDir},
			{name: "p/a/b/z", typ: tar.TypeSymlink, linkname: "../../k"}, {name: "p/a/b/q", typ: tar.TypeSymlink, linkname: "z/../../../x"}},
		"chain out, link after": {{name: "p/a/b/q", typ: tar.TypeSymlink, linkname: "z/../../../etc/passwd"},
			{name: "p/a/b/z", typ: tar.TypeSymlink, linkname: "../../k"}, {name: "p/k/", typ: tar.TypeDir}},
		"through a link out":  {{name: "p/up", typ: tar.TypeSymlink, linkname: ".."}, {name: "p/b", typ: tar.TypeSymlink, linkname: "up/etc"}},
		"link to the root":    {{name: "p/sub/l", typ: tar.TypeSymlink, linkname: ".."}},
		"link to its parent":  {{name: "p/a/b/l", typ: tar.TypeSymlink, linkname: ".."}},
		"cycle":               {{name: "p/x", typ: tar.TypeSymlink, linkname: "y"}, {name: "p/y", typ: tar.TypeSymlink, linkname: "x"}},
		"write through link":  {{name: "p/sub/", typ: tar.TypeDir}, {name: "p/l", typ: tar.TypeSymlink, linkname: "sub"}, {name: "p/l/evil", typ: tar.TypeReg, body: "x"}},
		"link into .git":      {{name: "p/l", typ: tar.TypeSymlink, linkname: ".git/config"}},
		"link with backslash": {{name: "p/l", typ: tar.TypeSymlink, linkname: `..\..\etc`}},
		"empty link":          {{name: "p/l", typ: tar.TypeSymlink, linkname: ""}},
	}
	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			dest := t.TempDir()
			// a good file first, to prove the cleanup
			all := append([]entry{{name: "p/ok.txt", typ: tar.TypeReg, body: "ok"}}, entries...)
			if name == "two roots" || name == "absolute" || name == "dot dot" || name == "backslash" {
				all = entries
			}
			_, err := Extract(bytes.NewReader(archive(t, all...)), dest, Limits{})
			var re *RefusedError
			if !errors.As(err, &re) {
				t.Fatalf("not refused: %v", err)
			}
			t.Logf("refused: %s", re.Reason)
			left, _ := os.ReadDir(dest)
			if len(left) != 0 {
				t.Fatalf("dest not empty after refusal: %v", left)
			}
		})
	}
}

// Links a repo keeps inside itself are extracted as links: one to a file the
// repo leaves out (Cal.com's packages/prisma/.env -> ../../.env), one to a
// file it has, and one through another link that stays inside.
func TestExtractKeepsLinksInsideTheRepo(t *testing.T) {
	dest := t.TempDir()
	_, err := Extract(bytes.NewReader(archive(t,
		entry{name: "o-r-abc/", typ: tar.TypeDir},
		entry{name: "o-r-abc/shared/b.txt", typ: tar.TypeReg, body: "shared"},
		entry{name: "o-r-abc/packages/prisma/.env", typ: tar.TypeSymlink, linkname: "../../.env"},
		entry{name: "o-r-abc/docs/a.txt", typ: tar.TypeSymlink, linkname: "../shared/b.txt"},
		entry{name: "o-r-abc/docs/c.txt", typ: tar.TypeSymlink, linkname: "a.txt"},
		entry{name: "o-r-abc/docs/shared", typ: tar.TypeSymlink, linkname: "../shared"},
	)), dest, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := os.Readlink(filepath.Join(dest, "packages/prisma/.env")); err != nil || got != "../../.env" {
		t.Fatalf("dangling link %q %v", got, err)
	}
	for _, p := range []string{"docs/c.txt", "docs/shared/b.txt"} {
		if b, err := os.ReadFile(filepath.Join(dest, p)); err != nil || string(b) != "shared" {
			t.Fatalf("%s: %q %v", p, b, err)
		}
	}
}

// M21: directories count toward the entry limit.
func TestExtractCountsDirectoriesTowardTheLimit(t *testing.T) {
	var many []entry
	for i := 0; i < 20; i++ {
		many = append(many, entry{name: fmt.Sprintf("p/d%d/", i), typ: tar.TypeDir})
	}
	dest := t.TempDir()
	_, err := Extract(bytes.NewReader(archive(t, many...)), dest, Limits{MaxFiles: 10, MaxTotal: 1 << 20, MaxFileBytes: 1 << 20})
	var re *RefusedError
	if !errors.As(err, &re) {
		t.Fatalf("20 directories under a 10-entry limit: %v", err)
	}
	if left, _ := os.ReadDir(dest); len(left) != 0 {
		t.Fatalf("dest not empty after refusal: %v", left)
	}
}

func TestExtractLimits(t *testing.T) {
	_, err := Extract(bytes.NewReader(archive(t, entry{name: "p/a", typ: tar.TypeReg, body: "0123456789"})), t.TempDir(), Limits{MaxFiles: 10, MaxTotal: 5, MaxFileBytes: 100})
	var re *RefusedError
	if !errors.As(err, &re) {
		t.Fatalf("size limit: %v", err)
	}
}

type countRevoker struct{ n atomic.Int32 }

func (c *countRevoker) Revoke(context.Context, string) error { c.n.Add(1); return nil }

func TestFetchRevokesOnEveryPath(t *testing.T) {
	good := archive(t, entry{name: "p/a.txt", typ: tar.TypeReg, body: "hi"})
	bad := archive(t, entry{name: "p/l", typ: tar.TypeSymlink, linkname: "/"})
	var seenAuth atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth.Store(r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/good":
			_, _ = w.Write(good)
		case "/bad":
			_, _ = w.Write(bad)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	for _, p := range []string{"/good", "/bad", "/missing"} {
		rev := &countRevoker{}
		dest := filepath.Join(t.TempDir(), "repo")
		_, err := FetchExtractRevoke(context.Background(), FetchOptions{URL: srv.URL + p, Token: "ghs_tok", Dest: dest, WorkDir: t.TempDir(), Extractor: InProcessExtractor{}, Revoker: rev})
		if (p == "/good") != (err == nil) {
			t.Fatalf("%s: err %v", p, err)
		}
		if rev.n.Load() != 1 {
			t.Fatalf("%s: revoked %d times", p, rev.n.Load())
		}
	}
	if seenAuth.Load() != "Bearer ghs_tok" {
		t.Fatal("token not sent")
	}
}

type flakyRevoker struct {
	fails int32
	n     atomic.Int32
}

func (f *flakyRevoker) Revoke(context.Context, string) error {
	if f.n.Add(1) <= f.fails {
		return errors.New("context deadline exceeded")
	}
	return nil
}

// A revocation that times out once is tried again; one that never answers
// still fails the fetch (S-05: a token is never left valid silently).
func TestFetchRetriesTheRevocationAndFailsWhenItNeverWorks(t *testing.T) {
	revokeBackoff = time.Millisecond
	defer func() { revokeBackoff = time.Second }()
	good := archive(t, entry{name: "p/a.txt", typ: tar.TypeReg, body: "hi"})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(good) }))
	defer srv.Close()
	fetch := func(rev Revoker) error {
		_, err := FetchExtractRevoke(context.Background(), FetchOptions{URL: srv.URL, Token: "ghs_tok", Dest: filepath.Join(t.TempDir(), "repo"), WorkDir: t.TempDir(), Extractor: InProcessExtractor{}, Revoker: rev})
		return err
	}
	once := &flakyRevoker{fails: 1}
	if err := fetch(once); err != nil || once.n.Load() != 2 {
		t.Fatalf("one blip: %v after %d tries", err, once.n.Load())
	}
	never := &flakyRevoker{fails: 100}
	if err := fetch(never); err == nil || never.n.Load() != int32(revokeAttempts) {
		t.Fatalf("never revoked: %v after %d tries", err, never.n.Load())
	}
}

// The isolated extractor re-executes the test binary as the child.
func TestMain(m *testing.M) {
	if os.Getenv("TARBALL_CHILD") == "1" {
		os.Exit(RunExtractChild(os.Args[1:], os.Stdout, os.Stderr))
	}
	if os.Getenv("TARBALL_CHILD") == "netcheck" {
		// Prints the interfaces this process can use besides loopback.
		ifs, _ := net.Interfaces()
		n := 0
		for _, i := range ifs {
			if i.Flags&net.FlagLoopback == 0 {
				n++
			}
		}
		fmt.Printf(`{"files":%d}`, n)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestIsolatedExtractor(t *testing.T) {
	src := filepath.Join(t.TempDir(), "r.tar.gz")
	_ = os.WriteFile(src, archive(t, entry{name: "p/a.txt", typ: tar.TypeReg, body: "hi"}), 0o600)
	exe, _ := os.Executable()
	t.Setenv("TARBALL_CHILD", "1")
	iso := NetNSExtractor{Command: []string{exe}, AllowWithoutNetNS: true}
	// The child gets a clean env; pass the marker through the command.
	iso.Command = []string{"/usr/bin/env", "TARBALL_CHILD=1", exe}
	st, err := iso.Extract(context.Background(), src, t.TempDir())
	if err != nil {
		t.Skipf("isolation unavailable here: %v", err)
	}
	if st.Files != 1 {
		t.Fatalf("%+v", st)
	}
	if _, err := (NetNSExtractor{Command: []string{exe}}).Extract(context.Background(), src, t.TempDir()); err == nil && !onLinux() {
		t.Fatal("ran without a network namespace")
	}
}

// On Linux the extraction child has no network interface at all, even when
// the agent has one (S-05: no process of the repo's tarball near a network).
func TestIsolatedChildHasNoNetwork(t *testing.T) {
	if !onLinux() {
		t.Skip("network namespaces are Linux only")
	}
	exe, _ := os.Executable()
	st, err := NetNSExtractor{Command: []string{"/usr/bin/env", "TARBALL_CHILD=netcheck", exe}}.Extract(context.Background(), "x", t.TempDir())
	if err != nil {
		t.Skipf("user namespaces unavailable: %v", err)
	}
	if st.Files != 0 {
		t.Fatalf("child sees %d non-loopback interfaces", st.Files)
	}
	ifs, _ := net.Interfaces()
	t.Logf("parent interfaces: %d", len(ifs))
}
