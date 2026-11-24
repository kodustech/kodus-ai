package toollayer_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/toollayer"
)

func assertCorruptMiss(t *testing.T, r *rig, org, key string) {
	t.Helper()
	_, err := r.lookup(org, key)
	if !errors.Is(err, toollayer.ErrMiss) || toollayer.MissReason(err) != "corrupt" {
		t.Fatalf("lookup = %v, want a corrupt miss", err)
	}
	if n := r.layerDirs(org); len(n) != 0 {
		t.Fatalf("corrupt layer not evicted: %v", n)
	}
	if _, err := r.lookup(org, key); toollayer.MissReason(err) != "no_key" {
		t.Fatalf("second lookup = %v, want no_key", err)
	}
}

func TestAFileChangedOnDiskIsRefusedEvictedAndAnsweredMiss(t *testing.T) {
	r := newRig(t)
	r.mustIngest("o", hex64("1"), npmTree())
	h := r.mustHit("o", hex64("1"))
	p := filepath.Join(h.TreePath, "node_modules", "foo", "package.json")
	h.Release()
	chmodWritable(t, p)
	if err := os.WriteFile(p, []byte(`{"name":"evil","version":"1.2.3"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	assertCorruptMiss(t, r, "o", hex64("1"))
}

func TestOtherTamperingIsCaughtToo(t *testing.T) {
	tamper := map[string]func(t *testing.T, tree string){
		"mode change": func(t *testing.T, tree string) {
			chmodWritable(t, filepath.Join(tree, "node_modules", "foo", "cli.js"))
		},
		"file removed": func(t *testing.T, tree string) {
			chmodWritable(t, filepath.Join(tree, "node_modules", "foo"))
			if err := os.Remove(filepath.Join(tree, "node_modules", "foo", "package.json")); err != nil {
				t.Fatal(err)
			}
		},
		"file added": func(t *testing.T, tree string) {
			chmodWritable(t, filepath.Join(tree, "node_modules", "foo"))
			if err := os.WriteFile(filepath.Join(tree, "node_modules", "foo", "inject.js"), []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"symlink retargeted": func(t *testing.T, tree string) {
			d := filepath.Join(tree, "node_modules", ".bin")
			chmodWritable(t, d)
			l := filepath.Join(d, "foo")
			if err := os.Remove(l); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink("/workspace/pr/x.js", l); err != nil {
				t.Fatal(err)
			}
		},
		"tree replaced by a symlink": func(t *testing.T, tree string) {
			moved := tree + ".moved"
			if err := os.Rename(tree, moved); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(moved, tree); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, f := range tamper {
		t.Run(name, func(t *testing.T) {
			r := newRig(t)
			r.mustIngest("o", hex64("1"), npmTree())
			h := r.mustHit("o", hex64("1"))
			tree := h.TreePath
			h.Release()
			f(t, tree)
			assertCorruptMiss(t, r, "o", hex64("1"))
		})
	}
}

// A second layer linking a shared file changes its ctime; that is not a
// tamper, and the mount must still hit.
func TestSharingAFileWithAnotherLayerIsNotCorruption(t *testing.T) {
	r := newRig(t)
	r.mustIngest("o", hex64("1"), npmTree())
	h := r.mustHit("o", hex64("1"))
	h.Release()
	r.mustIngest("o", hex64("2"), npmTree(file("./node_modules/foo/extra.txt", "more")))
	h = r.mustHit("o", hex64("1"))
	h.Release()
	// And the refreshed fingerprint is accepted again without a rehash.
	h = r.mustHit("o", hex64("1"))
	h.Release()
}

func TestMountedLayerKeepsAHoldAndReleaseIsIdempotent(t *testing.T) {
	r := newRig(t)
	l := r.mustIngest("o", hex64("1"), npmTree())
	h := r.mustHit("o", hex64("1"))
	h.Release()
	h.Release()
	rel := r.store.Hold("o", l.Digest)
	rel()
	rel()
}
