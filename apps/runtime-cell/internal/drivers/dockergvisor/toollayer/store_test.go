package toollayer_test

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/toollayer"
)

func TestIngestAcceptsANormalNpmTreeAndMountsItReadOnly(t *testing.T) {
	r := newRig(t)
	key := hex64("1")
	layer := r.mustIngest("org-a", key, npmTree())

	if layer.BinaryPath != "node_modules/foo/cli.js" || layer.Interpreter != "node" {
		t.Fatalf("entry = %q via %q", layer.BinaryPath, layer.Interpreter)
	}
	if want := int64(len(`{"name":"foo","version":"1.2.3"}`) + len(nodeScript)); layer.Bytes != want {
		t.Fatalf("bytes = %d, want %d", layer.Bytes, want)
	}
	if layer.Key != key || layer.ImageDigest != imageA || !layer.BuiltAt.Equal(r.clock.Now()) {
		t.Fatalf("layer = %+v", layer)
	}

	hit := r.mustHit("org-a", key)
	defer hit.Release()
	if hit.Digest != layer.Digest || hit.BinaryPath != layer.BinaryPath {
		t.Fatalf("hit = %+v", hit.Layer)
	}
	cli := filepath.Join(hit.TreePath, "node_modules/foo/cli.js")
	info, err := os.Lstat(cli)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o444 {
		t.Fatalf("script mode = %v, want 0444 (exec bit stripped)", info.Mode().Perm())
	}
	di, err := os.Lstat(filepath.Join(hit.TreePath, "node_modules"))
	if err != nil {
		t.Fatal(err)
	}
	if di.Mode().Perm() != 0o555 || !di.IsDir() {
		t.Fatalf("dir mode = %v", di.Mode())
	}
	target, err := os.Readlink(filepath.Join(hit.TreePath, "node_modules/.bin/foo"))
	if err != nil || target != "../foo/cli.js" {
		t.Fatalf("symlink = %q, %v", target, err)
	}
	body, _ := os.ReadFile(cli)
	if string(body) != nodeScript {
		t.Fatal("content changed")
	}
}

func TestLayerDigestIsDeterministicAndFollowsContent(t *testing.T) {
	a := newRig(t)
	b := newRig(t)
	la := a.mustIngest("o", hex64("1"), npmTree())
	lb := b.mustIngest("o", hex64("2"), npmTree())
	if la.Digest != lb.Digest {
		t.Fatal("same tree, different digest")
	}
	changed := npmTree()
	changed[3] = file("./node_modules/foo/package.json", `{"name":"foo","version":"1.2.4"}`)
	if lc := b.mustIngest("o", hex64("3"), changed); lc.Digest == la.Digest {
		t.Fatal("different content, same digest")
	}
	// An exec bit in the archive does not change the layer: modes are normalized.
	plain := npmTree()
	plain[4] = file("./node_modules/foo/cli.js", nodeScript)
	if lp := b.mustIngest("o", hex64("4"), plain); lp.Digest != la.Digest {
		t.Fatal("exec bit leaked into the digest")
	}
}

func TestExtractorRefusesAdversarialArchives(t *testing.T) {
	long := strings.Repeat("a", 256)
	cases := []struct {
		name   string
		extra  []ent
		reason string
	}{
		{"device", []ent{{name: "./dev0", typ: tar.TypeChar, mode: 0o644}}, "unsupported_type"},
		{"block device", []ent{{name: "./dev1", typ: tar.TypeBlock, mode: 0o644}}, "unsupported_type"},
		{"fifo", []ent{{name: "./pipe", typ: tar.TypeFifo, mode: 0o644}}, "unsupported_type"},
		{"hard link", []ent{{name: "./node_modules/foo/h", typ: tar.TypeLink, mode: 0o644, link: "node_modules/foo/cli.js"}}, "hardlink"},
		{"absolute path", []ent{file("/etc/passwd", "x")}, "absolute_path"},
		{"dotdot", []ent{file("./node_modules/../../escape", "x")}, "dotdot"},
		{"leading dotdot", []ent{file("../escape", "x")}, "dotdot"},
		{"name too long", []ent{file("./node_modules/"+long, "x")}, "name_too_long"},
		{"path too long", []ent{file("./"+strings.Repeat(strings.Repeat("d", 100)+"/", 41)+"f", "x")}, "path_too_long"},
		{"duplicate file", []ent{file("./node_modules/foo/package.json", "other")}, "duplicate"},
		{"duplicate dir", []ent{dir("./node_modules/foo/")}, "duplicate"},
		{"parent is symlink", []ent{symlink("./lnk", "node_modules/foo"), file("./lnk/pwn.js", "x")}, "parent_symlink"},
		{"absolute symlink", []ent{symlink("./node_modules/foo/abs", "/workspace/pr")}, "symlink_absolute"},
		{"escaping symlink", []ent{symlink("./node_modules/foo/up", "../../../x")}, "symlink_escape"},
		{"escaping symlink from the root", []ent{symlink("./up", "..")}, "symlink_escape"},
		{"dotdot after a name in a symlink target", []ent{symlink("./d", "."), symlink("./e", "d/..")}, "symlink_escape"},
		{"empty symlink target", []ent{symlink("./empty", "")}, "symlink_escape"},
		{"setuid", []ent{{name: "./su", typ: tar.TypeReg, mode: 0o4755, body: "x"}}, "setid"},
		{"setgid", []ent{{name: "./sg", typ: tar.TypeReg, mode: 0o2755, body: "x"}}, "setid"},
		{"sticky", []ent{{name: "./st", typ: tar.TypeReg, mode: 0o1755, body: "x"}}, "setid"},
		{"setgid dir", []ent{{name: "./sgdir/", typ: tar.TypeDir, mode: 0o2755}}, "setid"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t)
			_, err := r.ingest("org", hex64("1"), npmTree(c.extra...))
			if !errors.Is(err, toollayer.ErrRefused) {
				t.Fatalf("err = %v, want ErrRefused", err)
			}
			if got := toollayer.RefusalReason(err); got != c.reason {
				t.Fatalf("reason = %q, want %q (%v)", got, c.reason, err)
			}
			if _, err := r.lookup("org", hex64("1")); !errors.Is(err, toollayer.ErrMiss) {
				t.Fatalf("lookup after refusal = %v, want miss", err)
			}
			assertNothingStored(t, r, "org")
		})
	}
}

func assertNothingStored(t *testing.T, r *rig, org string) {
	t.Helper()
	od := r.store.OrgDir(org)
	for _, sub := range []string{"layers", "keys", "files", "staging"} {
		if n := names(t, filepath.Join(od, sub)); len(n) != 0 {
			t.Errorf("%s/ not empty after a refusal: %v", sub, n)
		}
	}
}

func TestExtractorRefusesOverTheEntryCap(t *testing.T) {
	r := newRig(t, func(c *toollayer.Config) { c.MaxEntries = 10 })
	es := []ent{dir("./d/")}
	for i := 0; i < 20; i++ {
		es = append(es, file("./d/f"+string(rune('a'+i)), "x"))
	}
	es = append(es, script("./d/cli.js", nodeScript))
	_, err := r.ingest("org", hex64("1"), es)
	if toollayer.RefusalReason(err) != "too_many_entries" {
		t.Fatalf("err = %v", err)
	}
	assertNothingStored(t, r, "org")
}

func TestExtractorRefusesOverTheByteCap(t *testing.T) {
	r := newRig(t, func(c *toollayer.Config) { c.MaxLayerBytes = 1024 })
	es := npmTree(file("./node_modules/foo/big.bin", strings.Repeat("x", 4096)))
	_, err := r.ingest("org", hex64("1"), es)
	if toollayer.RefusalReason(err) != "too_large" || !errors.Is(err, toollayer.ErrTooLarge) {
		t.Fatalf("err = %v", err)
	}
	assertNothingStored(t, r, "org")
}

func TestExtractorStopsAtTheDeadline(t *testing.T) {
	r := newRig(t)
	ctx, cancel := context.WithCancel(context.Background())
	raw := buildTar(t, npmTree())
	// The build's deadline passes while the stream is being read.
	rd := &cancelAfter{r: bytes.NewReader(raw), cancel: cancel, after: 600}
	_, err := r.store.Ingest(ctx, toollayer.IngestInput{Org: "org", Key: hex64("1"), ImageDigest: imageA, Binary: "foo", Tar: rd})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	assertNothingStored(t, r, "org")

	expired, cancel2 := context.WithDeadline(context.Background(), r.clock.Now().Add(-time.Hour))
	defer cancel2()
	_, err = r.store.Ingest(expired, toollayer.IngestInput{Org: "org", Key: hex64("1"), ImageDigest: imageA, Binary: "foo", Tar: bytes.NewReader(raw)})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want DeadlineExceeded", err)
	}
}

type cancelAfter struct {
	r      io.Reader
	cancel func()
	after  int
	n      int
}

func (c *cancelAfter) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	if c.n >= c.after {
		c.cancel()
	}
	return n, err
}

func TestEntryScriptRules(t *testing.T) {
	elf := "\x7fELF\x02\x01\x01 rest of a native binary"
	cases := []struct {
		name        string
		es          []ent
		reason      string
		interpreter string
	}{
		{"elf entry", []ent{dir("./node_modules/"), dir("./node_modules/.bin/"), file("./node_modules/.bin/foo", elf)}, "native_entry", ""},
		{"elf behind a symlink", []ent{dir("./node_modules/"), dir("./node_modules/.bin/"), file("./node_modules/real", elf), symlink("./node_modules/.bin/foo", "../real")}, "native_entry", ""},
		{"no shebang", []ent{dir("./node_modules/"), dir("./node_modules/.bin/"), file("./node_modules/.bin/foo", "console.log(1)\n")}, "no_shebang", ""},
		{"unsupported shebang", []ent{dir("./node_modules/"), dir("./node_modules/.bin/"), file("./node_modules/.bin/foo", "#!/usr/bin/env ruby\n")}, "no_shebang", ""},
		{"entry missing", []ent{dir("./node_modules/"), file("./node_modules/other.js", nodeScript)}, "entry_missing", ""},
		{"dangling symlink", []ent{dir("./node_modules/"), dir("./node_modules/.bin/"), symlink("./node_modules/.bin/foo", "../nope.js")}, "entry_missing", ""},
		{"entry is a directory", []ent{dir("./node_modules/"), dir("./node_modules/.bin/"), dir("./node_modules/.bin/foo/")}, "entry_not_file", ""},
		{"empty file", []ent{dir("./node_modules/"), dir("./node_modules/.bin/"), file("./node_modules/.bin/foo", "")}, "no_shebang", ""},
		{"python", []ent{dir("./.local/"), dir("./.local/bin/"), file("./.local/bin/foo", "#!/usr/bin/python3\n")}, "", "python3"},
		{"bash", []ent{dir("./.local/"), dir("./.local/bin/"), file("./.local/bin/foo", "#!/bin/bash\n")}, "", "bash"},
		{"sh", []ent{dir("./.local/"), dir("./.local/bin/"), file("./.local/bin/foo", "#!/bin/sh\r\n")}, "", "sh"},
		{"node with crlf", []ent{dir("./node_modules/"), dir("./node_modules/.bin/"), file("./node_modules/.bin/foo", "#!/usr/bin/env node\r\n")}, "", "node"},
		{"symlink chain", []ent{dir("./node_modules/"), dir("./node_modules/.bin/"), dir("./node_modules/p/"), file("./node_modules/p/c.js", nodeScript), symlink("./node_modules/mid", "p"), symlink("./node_modules/.bin/foo", "../mid/c.js")}, "", "node"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t)
			layer, err := r.ingest("org", hex64("1"), c.es)
			if c.reason != "" {
				if toollayer.RefusalReason(err) != c.reason {
					t.Fatalf("err = %v, want reason %s", err, c.reason)
				}
				assertNothingStored(t, r, "org")
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if layer.Interpreter != c.interpreter {
				t.Fatalf("interpreter = %q, want %q", layer.Interpreter, c.interpreter)
			}
		})
	}
}

func TestEntryBinaryNameCannotBeAPath(t *testing.T) {
	r := newRig(t)
	for _, b := range []string{"", "../foo", "a/b", ".", ".."} {
		_, err := r.store.Ingest(context.Background(), toollayer.IngestInput{Org: "o", Key: hex64("1"), ImageDigest: imageA, Binary: b, Tar: bytes.NewReader(buildTar(t, npmTree()))})
		if err == nil {
			t.Errorf("binary %q accepted", b)
		}
	}
}

func TestIngestNeedsAnImageDigestAndAKey(t *testing.T) {
	r := newRig(t)
	raw := buildTar(t, npmTree())
	for _, d := range []string{"", "latest", "sha256:short"} {
		_, err := r.store.Ingest(context.Background(), toollayer.IngestInput{Org: "o", Key: hex64("1"), ImageDigest: d, Binary: "foo", Tar: bytes.NewReader(raw)})
		if !errors.Is(err, toollayer.ErrNoImageDigest) {
			t.Errorf("digest %q: err = %v", d, err)
		}
	}
	for _, k := range []string{"", "../../x", hex64("z"), strings.Repeat("a", 63)} {
		if _, err := r.ingestBytes("o", k, raw); err == nil {
			t.Errorf("key %q accepted", k)
		}
	}
	if _, err := r.ingestBytes("", hex64("1"), raw); err == nil {
		t.Error("empty org accepted")
	}
	assertNothingStored(t, r, "o")
}

func TestIntegrityIsRecordedAndAnInvalidSignatureRefusesTheLayer(t *testing.T) {
	r := newRig(t)
	raw := buildTar(t, npmTree())
	in := toollayer.IngestInput{Org: "o", Key: hex64("1"), ImageDigest: imageA, Binary: "foo", Tar: bytes.NewReader(raw),
		Integrity: toollayer.Integrity{LockfileIntegrity: true, SignaturesVerified: 3, SignaturesMissing: 1, SignaturesInvalid: 1}}
	_, err := r.store.Ingest(context.Background(), in)
	if !errors.Is(err, toollayer.ErrRefused) || toollayer.RefusalReason(err) != "invalid_signature" {
		t.Fatalf("err = %v", err)
	}
	assertNothingStored(t, r, "o")

	in.Tar = bytes.NewReader(raw)
	in.Integrity = toollayer.Integrity{LockfileIntegrity: true, SignaturesVerified: 3, SignaturesMissing: 1}
	if _, err := r.store.Ingest(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	h := r.mustHit("o", hex64("1"))
	defer h.Release()
	if h.Integrity != in.Integrity {
		t.Fatalf("integrity = %+v", h.Integrity)
	}
	// layer.json records it for audit.
	raw2, err := os.ReadFile(filepath.Join(r.store.OrgDir("o"), "layers", h.Digest, "layer.json"))
	if err != nil || !bytes.Contains(raw2, []byte(`"signaturesMissing": 1`)) {
		t.Fatalf("layer.json = %s, %v", raw2, err)
	}
}

func TestOrgsNeverShareADirectoryOrAKey(t *testing.T) {
	r := newRig(t)
	r.mustIngest("org-a", hex64("1"), npmTree())
	if _, err := r.lookup("org-b", hex64("1")); !errors.Is(err, toollayer.ErrMiss) {
		t.Fatalf("org B resolved org A's key: %v", err)
	}
	a, b := r.store.OrgDir("org-a"), r.store.OrgDir("org-b")
	if a == b || filepath.Dir(a) != filepath.Dir(b) || filepath.Dir(a) != r.root {
		t.Fatalf("org dirs %q %q", a, b)
	}
	if strings.Contains(a, "org-a") {
		t.Fatalf("org id appears in its path: %s", a)
	}
	for _, hostile := range []string{"../../etc", "/etc", "a/../../b", "o-x", "."} {
		d := r.store.OrgDir(hostile)
		if filepath.Dir(d) != r.root || !strings.HasPrefix(filepath.Base(d), "o-") || strings.ContainsAny(filepath.Base(d), "./ ") {
			t.Errorf("org %q -> %q", hostile, d)
		}
	}
	// The same bytes in two orgs are two copies, never one inode.
	r.mustIngest("org-b", hex64("1"), npmTree())
	ha, hb := r.mustHit("org-a", hex64("1")), r.mustHit("org-b", hex64("1"))
	defer ha.Release()
	defer hb.Release()
	fa, _ := os.Stat(filepath.Join(ha.TreePath, "node_modules/foo/package.json"))
	fb, _ := os.Stat(filepath.Join(hb.TreePath, "node_modules/foo/package.json"))
	if os.SameFile(fa, fb) {
		t.Fatal("two orgs share a file")
	}
}

func TestFilesAreSharedWithinAnOrg(t *testing.T) {
	r := newRig(t)
	r.mustIngest("o", hex64("1"), npmTree())
	r.mustIngest("o", hex64("2"), npmTree(file("./node_modules/foo/extra.txt", "more")))
	h1, h2 := r.mustHit("o", hex64("1")), r.mustHit("o", hex64("2"))
	defer h1.Release()
	defer h2.Release()
	f1, _ := os.Stat(filepath.Join(h1.TreePath, "node_modules/foo/package.json"))
	f2, _ := os.Stat(filepath.Join(h2.TreePath, "node_modules/foo/package.json"))
	if !os.SameFile(f1, f2) {
		t.Fatal("identical files of one org's layers are stored twice")
	}
}

func TestANewBuildSwapsTheKeyAndKeepsTheOldLayerUntilGC(t *testing.T) {
	r := newRig(t)
	old := r.mustIngest("o", hex64("1"), npmTree())
	next := r.mustIngest("o", hex64("1"), npmTree(file("./node_modules/foo/new.txt", "n")))
	if old.Digest == next.Digest {
		t.Fatal("same digest")
	}
	h := r.mustHit("o", hex64("1"))
	defer h.Release()
	if h.Digest != next.Digest {
		t.Fatalf("key points to %s, want the new layer", h.Digest)
	}
	if len(r.layerDirs("o")) != 2 {
		t.Fatalf("layers = %v", r.layerDirs("o"))
	}
	// The key file is swapped, never left half written.
	for _, n := range names(t, filepath.Join(r.store.OrgDir("o"), "keys")) {
		if strings.Contains(n, "tmp") {
			t.Fatalf("temp key file left: %s", n)
		}
	}
}

func TestIngestOfAnExistingLayerIsIdempotent(t *testing.T) {
	r := newRig(t)
	a := r.mustIngest("o", hex64("1"), npmTree())
	b := r.mustIngest("o", hex64("1"), npmTree())
	if a.Digest != b.Digest || len(r.layerDirs("o")) != 1 {
		t.Fatalf("layers = %v", r.layerDirs("o"))
	}
	if n := names(t, filepath.Join(r.store.OrgDir("o"), "staging")); len(n) != 0 {
		t.Fatalf("staging left: %v", n)
	}
}

func TestStoreRootIsPrivate(t *testing.T) {
	r := newRig(t)
	info, err := os.Lstat(r.root)
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("root = %v, %v", info, err)
	}
	r.mustIngest("o", hex64("1"), npmTree())
	oi, _ := os.Lstat(r.store.OrgDir("o"))
	if oi.Mode().Perm() != 0o700 {
		t.Fatalf("org dir mode = %v", oi.Mode().Perm())
	}
	// A root that is a symlink is refused.
	base := t.TempDir()
	real := filepath.Join(base, "real")
	if err := os.Mkdir(real, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if _, err := toollayer.New(toollayer.Config{Root: link}); err == nil {
		t.Fatal("symlink root accepted")
	}
	if _, err := toollayer.New(toollayer.Config{}); err == nil {
		t.Fatal("empty root accepted")
	}
}

func TestConcurrentIngestLookupAndGCStayConsistent(t *testing.T) {
	r := newRig(t)
	r.mustIngest("o", hex64("1"), npmTree())
	done := make(chan struct{})
	errs := make(chan error, 64)
	go func() {
		defer close(done)
		for i := 0; i < 8; i++ {
			if _, err := r.ingest("o", hex64("2"), npmTree(file("./x", string(rune('a'+i))))); err != nil {
				errs <- err
			}
		}
	}()
	for i := 0; i < 20; i++ {
		h, err := r.lookup("o", hex64("1"))
		if err != nil {
			errs <- err
			break
		}
		h.Release()
		if _, err := r.store.GC(context.Background()); err != nil {
			errs <- err
		}
	}
	<-done
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}
