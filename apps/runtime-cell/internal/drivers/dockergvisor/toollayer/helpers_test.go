package toollayer_test

import (
	"archive/tar"
	"bytes"
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/toollayer"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type ent struct {
	name string
	typ  byte
	mode int64
	body string
	link string
	size int64 // overrides len(body) for the header when non-zero
}

func dir(name string) ent        { return ent{name: name, typ: tar.TypeDir, mode: 0o755} }
func file(name, body string) ent { return ent{name: name, typ: tar.TypeReg, mode: 0o644, body: body} }

func script(name, body string) ent { return ent{name: name, typ: tar.TypeReg, mode: 0o755, body: body} }

func symlink(name, target string) ent {
	return ent{name: name, typ: tar.TypeSymlink, mode: 0o777, link: target}
}

const nodeScript = "#!/usr/bin/env node\nconsole.log('hi')\n"

// npmTree is what an npm global install into the prefix leaves.
func npmTree(extra ...ent) []ent {
	es := []ent{
		dir("./"),
		dir("./node_modules/"),
		dir("./node_modules/foo/"),
		file("./node_modules/foo/package.json", `{"name":"foo","version":"1.2.3"}`),
		script("./node_modules/foo/cli.js", nodeScript),
		dir("./node_modules/.bin/"),
		symlink("./node_modules/.bin/foo", "../foo/cli.js"),
	}
	return append(es, extra...)
}

func buildTar(t *testing.T, es []ent) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range es {
		size := int64(len(e.body))
		if e.size != 0 {
			size = e.size
		}
		if e.typ != tar.TypeReg {
			size = 0
		}
		hdr := &tar.Header{Name: e.name, Typeflag: e.typ, Mode: e.mode, Size: size, Linkname: e.link, Format: tar.FormatPAX}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if e.typ == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func hex64(c string) string { return strings.Repeat(c, 64) }

type rig struct {
	t     *testing.T
	root  string
	clock *fakeClock
	store *toollayer.Store
	cfg   toollayer.Config
}

func newRig(t *testing.T, tweak ...func(*toollayer.Config)) *rig {
	t.Helper()
	r := &rig{t: t, root: filepath.Join(t.TempDir(), "toollayers"), clock: newClock()}
	t.Cleanup(func() { unlock(r.root) })
	r.cfg = toollayer.Config{Root: r.root, Now: r.clock.Now}
	for _, f := range tweak {
		f(&r.cfg)
	}
	r.reopen()
	return r
}

// reopen builds a new Store on the same root: a cell restart.
func (r *rig) reopen() {
	r.t.Helper()
	s, err := toollayer.New(r.cfg)
	if err != nil {
		r.t.Fatal(err)
	}
	r.store = s
}

func (r *rig) ingest(org, key string, es []ent) (toollayer.Layer, error) {
	return r.ingestBytes(org, key, buildTar(r.t, es))
}

func (r *rig) ingestBytes(org, key string, raw []byte) (toollayer.Layer, error) {
	return r.store.Ingest(context.Background(), toollayer.IngestInput{
		Org: org, Key: key, ImageDigest: imageA, Binary: "foo", Tar: bytes.NewReader(raw),
	})
}

func (r *rig) mustIngest(org, key string, es []ent) toollayer.Layer {
	r.t.Helper()
	l, err := r.ingest(org, key, es)
	if err != nil {
		r.t.Fatalf("ingest: %v", err)
	}
	return l
}

func (r *rig) lookup(org, key string) (*toollayer.Hit, error) {
	return r.store.Lookup(context.Background(), org, key)
}

func (r *rig) mustHit(org, key string) *toollayer.Hit {
	r.t.Helper()
	h, err := r.lookup(org, key)
	if err != nil {
		r.t.Fatalf("lookup: %v", err)
	}
	return h
}

func (r *rig) layerDirs(org string) []string {
	return names(r.t, filepath.Join(r.store.OrgDir(org), "layers"))
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	des, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatal(err)
	}
	var out []string
	for _, d := range des {
		out = append(out, d.Name())
	}
	return out
}

// chmodWritable lets a test tamper with the read-only tree the way root on the host could.
func chmodWritable(t *testing.T, paths ...string) {
	t.Helper()
	for _, p := range paths {
		if err := os.Chmod(p, 0o700); err != nil {
			t.Fatal(err)
		}
	}
}

// unlock makes the read-only trees removable by the test's temp dir cleanup.
func unlock(root string) {
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.IsDir() {
			_ = os.Chmod(p, 0o700) //nolint:gosec // G122: the tree lives in the test's own t.TempDir(); nothing races it
		}
		return nil
	})
}
