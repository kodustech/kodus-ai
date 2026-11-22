package toollayer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// What U8 accepts: the stat fingerprint is the hot path; the full rehash
// runs at the first mount after a start and every 24 h per layer. These
// tests forge the fingerprint (an attacker who also fixes layer.json) to see
// which of the two catches a change.

func testStore(t *testing.T) (*Store, *clockT) {
	t.Helper()
	c := &clockT{t: time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)}
	root := filepath.Join(t.TempDir(), "tl")
	t.Cleanup(func() {
		filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err == nil && d.IsDir() {
				os.Chmod(p, 0o700)
			}
			return nil
		})
	})
	s, err := New(Config{Root: root, Now: c.Now})
	if err != nil {
		t.Fatal(err)
	}
	return s, c
}

type clockT struct{ t time.Time }

func (c *clockT) Now() time.Time          { return c.t }
func (c *clockT) Advance(d time.Duration) { c.t = c.t.Add(d) }

func tinyTar(t *testing.T) []byte {
	t.Helper()
	return buildTinyTar(t)
}

func ingestTiny(t *testing.T, s *Store, key string) Layer {
	t.Helper()
	l, err := s.Ingest(context.Background(), IngestInput{Org: "o", Key: key, ImageDigest: "sha256:" + strings.Repeat("a", 64), Binary: "foo", Tar: bytes.NewReader(tinyTar(t))})
	if err != nil {
		t.Fatal(err)
	}
	return l
}

// forge rewrites the file's content and then layer.json's fingerprint to match.
func forge(t *testing.T, s *Store, l Layer, rel, content string) {
	t.Helper()
	tree := filepath.Join(s.OrgDir("o"), "layers", l.Digest, "tree")
	p := filepath.Join(tree, rel)
	if err := os.Chmod(p, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, 0o444); err != nil {
		t.Fatal(err)
	}
	jp := filepath.Join(s.OrgDir("o"), "layers", l.Digest, "layer.json")
	raw, err := os.ReadFile(jp)
	if err != nil {
		t.Fatal(err)
	}
	var doc Layer
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for i := range doc.Entries {
		if doc.Entries[i].Path == rel {
			info, err := os.Lstat(p)
			if err != nil {
				t.Fatal(err)
			}
			fp := fingerprintOf(info)
			doc.Entries[i].FP = &fp
			doc.Entries[i].Size = info.Size()
		}
	}
	out, _ := json.Marshal(doc)
	if err := os.Chmod(jp, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(jp, out, 0o444); err != nil {
		t.Fatal(err)
	}
}

func TestFullRehashRunsEvery24HoursAndAtTheFirstMountAfterAStart(t *testing.T) {
	s, clock := testStore(t)
	key := strings.Repeat("1", 64)
	l := ingestTiny(t, s, key)
	h, err := s.Lookup(context.Background(), "o", key) // first mount: full rehash
	if err != nil {
		t.Fatal(err)
	}
	h.Release()

	forge(t, s, l, "node_modules/foo/package.json", "{\"name\":\"evil\"}")

	clock.Advance(time.Hour) // inside the window: the forged fingerprint is accepted
	h, err = s.Lookup(context.Background(), "o", key)
	if err != nil {
		t.Fatalf("fast path should accept a forged fingerprint inside 24 h: %v", err)
	}
	h.Release()

	clock.Advance(24 * time.Hour) // the periodic rehash catches it
	if _, err = s.Lookup(context.Background(), "o", key); !errors.Is(err, ErrMiss) || MissReason(err) != "corrupt" {
		t.Fatalf("after 24 h: %v, want a corrupt miss", err)
	}
}

func TestFullRehashRunsAtTheFirstMountAfterARestart(t *testing.T) {
	s, clock := testStore(t)
	key := strings.Repeat("1", 64)
	l := ingestTiny(t, s, key)
	h, err := s.Lookup(context.Background(), "o", key)
	if err != nil {
		t.Fatal(err)
	}
	h.Release()
	forge(t, s, l, "node_modules/foo/package.json", "{\"name\":\"evil\"}")

	s2, err := New(Config{Root: s.cfg.Root, Now: clock.Now}) // a cell restart
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s2.Lookup(context.Background(), "o", key); MissReason(err) != "corrupt" {
		t.Fatalf("after a restart: %v, want a corrupt miss", err)
	}
}
