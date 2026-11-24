package toollayer_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/toollayer"
)

func gc(t *testing.T, r *rig) toollayer.GCReport {
	t.Helper()
	rep, err := r.store.GC(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return rep
}

func TestGCRemovesALayerOnlyWhenNothingPointsToItAndItIsUnused(t *testing.T) {
	r := newRig(t)
	old := r.mustIngest("o", hex64("1"), npmTree())
	r.mustIngest("o", hex64("1"), npmTree(file("./node_modules/foo/new.txt", "n"))) // key now points elsewhere

	r.clock.Advance(23 * time.Hour)
	gc(t, r)
	if len(r.layerDirs("o")) != 2 {
		t.Fatal("an unreferenced layer went before 24 h unused")
	}
	r.clock.Advance(2 * time.Hour)
	// Keep the current layer in use so only the old one is a candidate.
	h := r.mustHit("o", hex64("1"))
	h.Release()
	rep := gc(t, r)
	dirs := r.layerDirs("o")
	if len(dirs) != 1 || dirs[0] == old.Digest || rep.LayersRemoved != 1 {
		t.Fatalf("layers = %v, report %+v", dirs, rep)
	}
}

func TestGCNeverRemovesAHeldLayer(t *testing.T) {
	r := newRig(t)
	old := r.mustIngest("o", hex64("1"), npmTree())
	r.mustIngest("o", hex64("1"), npmTree(file("./node_modules/foo/new.txt", "n")))
	release := r.store.Hold("o", old.Digest)
	r.clock.Advance(48 * time.Hour)
	gc(t, r)
	if len(r.layerDirs("o")) != 2 {
		t.Fatal("a held layer was removed")
	}
	release()
	gc(t, r)
	if len(r.layerDirs("o")) != 1 {
		t.Fatalf("layer not removed after release: %v", r.layerDirs("o"))
	}
}

func TestGCNeverRemovesALayerAKeyPointsTo(t *testing.T) {
	r := newRig(t)
	r.mustIngest("o", hex64("1"), npmTree())
	r.clock.Advance(25 * time.Hour)
	gc(t, r)
	if len(r.layerDirs("o")) != 1 {
		t.Fatal("a referenced layer was removed")
	}
	if _, err := r.lookup("o", hex64("1")); err != nil {
		t.Fatal(err)
	}
}

func TestGCRemovesKeysUnusedFor30DaysThenTheirLayer(t *testing.T) {
	r := newRig(t)
	r.mustIngest("o", hex64("1"), npmTree())
	r.mustIngest("o", hex64("2"), npmTree(file("./node_modules/foo/b.txt", "b")))
	r.clock.Advance(29 * 24 * time.Hour)
	h := r.mustHit("o", hex64("2")) // key 2 is used, key 1 is not
	h.Release()
	r.clock.Advance(2 * 24 * time.Hour)
	rep := gc(t, r)
	if rep.KeysRemoved != 1 {
		t.Fatalf("report %+v", rep)
	}
	if _, err := r.lookup("o", hex64("1")); toollayer.MissReason(err) != "no_key" {
		t.Fatalf("key 1: %v", err)
	}
	if _, err := r.lookup("o", hex64("2")); err != nil {
		t.Fatalf("key 2: %v", err)
	}
	if len(r.layerDirs("o")) != 1 {
		t.Fatalf("layers = %v", r.layerDirs("o"))
	}
}

func TestGCRemovesOnlyFilesWithLinkCountOne(t *testing.T) {
	r := newRig(t)
	r.mustIngest("o", hex64("1"), npmTree())
	files := filepath.Join(r.store.OrgDir("o"), "files")
	before := len(names(t, files))
	stray := filepath.Join(files, hex64("e"))
	if err := os.WriteFile(stray, []byte("orphan"), 0o444); err != nil {
		t.Fatal(err)
	}
	rep := gc(t, r)
	if _, err := os.Stat(stray); !os.IsNotExist(err) {
		t.Fatal("orphan file kept")
	}
	if rep.FilesRemoved != 1 || len(names(t, files)) != before {
		t.Fatalf("files %d -> %d, report %+v", before, len(names(t, files)), rep)
	}
	if _, err := r.lookup("o", hex64("1")); err != nil {
		t.Fatalf("a live layer lost a file: %v", err)
	}
}

func TestGCFreesFilesOfARemovedLayerButKeepsSharedOnes(t *testing.T) {
	r := newRig(t)
	r.mustIngest("o", hex64("1"), npmTree())
	r.mustIngest("o", hex64("1"), npmTree(file("./node_modules/foo/new.txt", "n")))
	r.clock.Advance(48 * time.Hour)
	gc(t, r) // drops the old layer; files are shared except none unique to it
	h := r.mustHit("o", hex64("1"))
	h.Release()
	// Replace the layer under another key with unrelated content and drop the first.
	r.mustIngest("o", hex64("2"), []ent{dir("./.local/"), dir("./.local/bin/"), script("./.local/bin/foo", "#!/bin/sh\necho unique\n")})
	files := filepath.Join(r.store.OrgDir("o"), "files")
	if len(names(t, files)) == 0 {
		t.Fatal("setup: no files to free")
	}
	r.clock.Advance(31 * 24 * time.Hour)
	gc(t, r)
	if len(names(t, files)) != 0 {
		t.Fatalf("files after everything expired: %v", names(t, files))
	}
}

func TestLimitsOrgLayerCountEvictsLeastRecentlyMountedWithoutAHold(t *testing.T) {
	r := newRig(t, func(c *toollayer.Config) { c.MaxOrgLayers = 2 })
	a := r.mustIngest("o", hex64("1"), npmTree(file("./a", "a")))
	r.clock.Advance(time.Minute)
	b := r.mustIngest("o", hex64("2"), npmTree(file("./b", "b")))
	r.clock.Advance(time.Minute)
	h := r.mustHit("o", hex64("1")) // a is now more recently mounted than b
	h.Release()
	r.clock.Advance(time.Minute)
	c := r.mustIngest("o", hex64("3"), npmTree(file("./c", "c")))
	dirs := map[string]bool{}
	for _, d := range r.layerDirs("o") {
		dirs[d] = true
	}
	if len(dirs) != 2 || !dirs[a.Digest] || !dirs[c.Digest] || dirs[b.Digest] {
		t.Fatalf("layers = %v; want a and c, b evicted", dirs)
	}
	if _, err := r.lookup("o", hex64("2")); !errors.Is(err, toollayer.ErrMiss) {
		t.Fatalf("evicted layer's key: %v", err)
	}
}

func TestLimitsAHeldLayerIsNeverEvictedAndTheNewOneIsRefused(t *testing.T) {
	r := newRig(t, func(c *toollayer.Config) { c.MaxOrgLayers = 1 })
	a := r.mustIngest("o", hex64("1"), npmTree(file("./a", "a")))
	release := r.store.Hold("o", a.Digest)
	_, err := r.ingest("o", hex64("2"), npmTree(file("./b", "b")))
	if !errors.Is(err, toollayer.ErrTooLarge) || toollayer.RefusalReason(err) != "org_full" {
		t.Fatalf("err = %v", err)
	}
	if len(r.layerDirs("o")) != 1 {
		t.Fatalf("layers = %v", r.layerDirs("o"))
	}
	release()
	if _, err := r.ingest("o", hex64("2"), npmTree(file("./b", "b"))); err != nil {
		t.Fatalf("after release: %v", err)
	}
}

func TestLimitsOrgBytesAndALayerTooLargeAloneIsRefused(t *testing.T) {
	size := int64(len(nodeScript) + len(`{"name":"foo","version":"1.2.3"}`))
	r := newRig(t, func(c *toollayer.Config) { c.MaxOrgBytes = size*2 + 10 })
	r.mustIngest("o", hex64("1"), npmTree(file("./a", "aaaa")))
	r.clock.Advance(time.Minute)
	r.mustIngest("o", hex64("2"), npmTree(file("./b", "bbbb"))) // fits both
	r.clock.Advance(time.Minute)
	r.mustIngest("o", hex64("3"), npmTree(file("./c", "cccc"))) // evicts the least recently mounted
	if len(r.layerDirs("o")) != 2 {
		t.Fatalf("layers = %v", r.layerDirs("o"))
	}
	if _, err := r.lookup("o", hex64("1")); !errors.Is(err, toollayer.ErrMiss) {
		t.Fatal("least recently mounted layer was kept")
	}

	small := newRig(t, func(c *toollayer.Config) { c.MaxOrgBytes = 10 })
	_, err := small.ingest("o", hex64("1"), npmTree())
	if !errors.Is(err, toollayer.ErrTooLarge) || toollayer.RefusalReason(err) != "too_large" {
		t.Fatalf("err = %v", err)
	}
	assertNothingStored(t, small, "o")
}

func TestLimitsCellBytesEvictAcrossOrgs(t *testing.T) {
	size := int64(len(nodeScript) + len(`{"name":"foo","version":"1.2.3"}`))
	r := newRig(t, func(c *toollayer.Config) { c.MaxCellBytes = size*2 + 10 })
	r.mustIngest("org-a", hex64("1"), npmTree(file("./a", "aaaa")))
	r.clock.Advance(time.Minute)
	r.mustIngest("org-b", hex64("1"), npmTree(file("./b", "bbbb")))
	r.clock.Advance(time.Minute)
	r.mustIngest("org-b", hex64("2"), npmTree(file("./c", "cccc")))
	if _, err := r.lookup("org-a", hex64("1")); !errors.Is(err, toollayer.ErrMiss) {
		t.Fatal("the least recently mounted layer of the cell was kept")
	}
	if _, err := r.lookup("org-b", hex64("2")); err != nil {
		t.Fatal(err)
	}
}

func TestPurgeOrgRemovesTheWholeTreeAndOnlyThatOrgs(t *testing.T) {
	r := newRig(t)
	r.mustIngest("a", hex64("1"), npmTree())
	r.mustIngest("b", hex64("1"), npmTree())
	if err := r.store.RecordMiss("a", hex64("2")); err != nil {
		t.Fatal(err)
	}
	if err := r.store.PurgeOrg("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(r.store.OrgDir("a")); !os.IsNotExist(err) {
		t.Fatalf("org dir still there: %v", err)
	}
	if _, err := r.lookup("a", hex64("1")); !errors.Is(err, toollayer.ErrMiss) {
		t.Fatal("purged org still hits")
	}
	if r.store.ShouldBuild("a", hex64("2")) {
		t.Fatal("miss record survived the purge")
	}
	h := r.mustHit("b", hex64("1"))
	h.Release()
	if err := r.store.PurgeOrg("never-seen"); err != nil {
		t.Fatalf("purging an unknown org: %v", err)
	}
	if err := r.store.PurgeOrg(""); err == nil {
		t.Fatal("empty org accepted")
	}
	// The org can build again afterwards.
	r.mustIngest("a", hex64("1"), npmTree())
}
