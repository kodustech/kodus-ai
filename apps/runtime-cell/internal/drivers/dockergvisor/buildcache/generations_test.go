package buildcache

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
)

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// cacheFrom writes a finished build's cache, as a setup build leaves it.
func cacheFrom(t *testing.T, body string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "out")
	writeFile(t, filepath.Join(dir, "index.json"), body)
	writeFile(t, filepath.Join(dir, "blobs", "sha256", "abc"), body)
	return dir
}

// Two builds hold one generation: it goes after the second ends, not the first.
func TestAGenerationGoesWithItsLastReader(t *testing.T) {
	c := New(t.TempDir(), filepath.Join(t.TempDir(), "trash"), nil)
	dir := filepath.Join(c.root, "env", "api")
	if err := c.Promote(cacheFrom(t, "gen1"), dir); err != nil {
		t.Fatal(err)
	}
	gen1, r1 := c.Acquire(dir)
	_, r2 := c.Acquire(dir)
	if err := c.Promote(cacheFrom(t, "gen2"), dir); err != nil {
		t.Fatal(err)
	}
	r1()
	r1() // a release is idempotent: it never gives back another build's hold
	if _, err := os.Stat(filepath.Join(gen1, "index.json")); err != nil {
		t.Fatalf("the generation went while a build still read it: %v", err)
	}
	r2()
	if _, err := os.Stat(gen1); !os.IsNotExist(err) {
		t.Fatal("the generation outlived its last reader")
	}
	// Nobody reads the current one: a promotion retires it at once.
	gen2, r3 := c.Acquire(dir)
	r3()
	if err := c.Promote(cacheFrom(t, "gen3"), dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(gen2); !os.IsNotExist(err) {
		t.Fatal("a generation nobody reads outlived its promotion")
	}
}

// The sweep takes what no link names and no build holds: generations a
// crash left, and the files of the layout before generations.
func TestTheSweepRemovesLeftoverGenerations(t *testing.T) {
	c := New(t.TempDir(), filepath.Join(t.TempDir(), "trash"), nil)
	dir := filepath.Join(c.root, "env", "api")
	writeFile(t, filepath.Join(dir, "index.json"), "legacy")
	writeFile(t, filepath.Join(dir, "gen-crashed", "index.json"), "x")
	if err := c.Promote(cacheFrom(t, "held"), dir); err != nil {
		t.Fatal(err)
	}
	held, release := c.Acquire(dir)
	defer release()
	if err := c.Promote(cacheFrom(t, "current"), dir); err != nil {
		t.Fatal(err)
	}
	current, _ := c.Acquire(dir)
	if err := c.Sweep(); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	var left []string
	for _, e := range entries {
		left = append(left, e.Name())
	}
	want := map[string]bool{currentLink: true, filepath.Base(held): true, filepath.Base(current): true}
	if len(left) != len(want) {
		t.Fatalf("left %v, want only the link, the current and the held generation", left)
	}
	for _, n := range left {
		if !want[n] {
			t.Fatalf("left %v, want only the link, the current and the held generation", left)
		}
	}
	if entries, _ := os.ReadDir(c.trash); len(entries) != 0 {
		t.Fatalf("trash not emptied: %v", entries)
	}
}

// A generation's name is stamped from the cell's clock: it read time.Now()
// directly, so no test could pin what a promotion names.
func TestCacheGenerationsAreNamedFromTheClock(t *testing.T) {
	at := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	c := New(t.TempDir(), filepath.Join(t.TempDir(), "trash"), clock.NewFake(at))
	dir := filepath.Join(c.root, "env", "api")
	if err := c.Promote(cacheFrom(t, "gen1"), dir); err != nil {
		t.Fatal(err)
	}
	name, err := os.Readlink(filepath.Join(dir, currentLink))
	if want := genPrefix + strconv.FormatInt(at.UnixNano(), 36) + "-1"; err != nil || name != want {
		t.Fatalf("current names %q (%v), want %q", name, err, want)
	}
}
