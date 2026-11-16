package buildstate

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// evictAll runs Evict with the disk below the floor until every state nobody
// holds is gone.
func evictAll(t *testing.T, st *Store) {
	t.Helper()
	st.minFree = 100
	st.freeBytes = func(string) (int64, error) { return 10, nil }
	if err := st.Evict(); err != nil {
		t.Fatal(err)
	}
}

// The disk floor removed every environment's state on the dev cell and the
// cell only logged build.state.evicted with the state's hashed name: nothing
// told the hub, the environments stayed "active", and calcom's next PR built
// cold past its boot's ceiling. The ledger names whose state went and when,
// survives a restart, and ends when a seed makes the state again.
func TestEvictionRecordsWhoseStateItRemovedUntilASeedMakesItAgain(t *testing.T) {
	st, _ := newStore(t)
	useAt(t, st, testEnv, fakeClock(st).Now())
	at := fakeClock(st).Now().Add(time.Hour)
	fakeClock(st).Set(at)
	evictAll(t, st)

	got := st.Evicted()
	if len(got) != 1 || got[0].Org != testOrg || got[0].Env != testEnv || !got[0].At.Equal(at) {
		t.Fatalf("evicted = %+v, want %s/%s at %s", got, testOrg, testEnv, at)
	}
	if when, ok := st.EvictedAt(testOrg, testEnv); !ok || !when.Equal(at) {
		t.Fatalf("EvictedAt = %s %v", when, ok)
	}
	// A pull request's build finds the state gone: it builds on its own, as before.
	if _, ok := st.Acquire(context.Background(), pr("m-pr")); ok {
		t.Fatal("a reader got a state that was evicted")
	}

	// A restart reads the ledger back.
	again := newStoreAt(t, st.root, &fakeMounter{})
	if got := again.Evicted(); len(got) != 1 || got[0].Env != testEnv {
		t.Fatalf("after a restart evicted = %+v", got)
	}

	// The default branch's setup seeds it again: the environment is no longer reported.
	s, ok := again.Acquire(context.Background(), seed("m-setup"))
	if !ok {
		t.Fatal("seed refused")
	}
	again.Release(s)
	if got := again.Evicted(); len(got) != 0 {
		t.Fatalf("a seeded state is still reported evicted: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(again.evictedDir(), EnvKey(testCell, testOrg, testEnv))); !os.IsNotExist(err) {
		t.Fatalf("the ledger entry outlived the seed: %v", err)
	}
	if _, ok := newStoreAt(t, st.root, &fakeMounter{}).EvictedAt(testOrg, testEnv); ok {
		t.Fatal("a restart after the seed reports the state evicted again")
	}
}

// A state made before the owner mark existed is evicted as before, and named
// to nobody: the cell cannot tell whose it was from its hashed name.
func TestAStateWithNoOwnerMarkIsEvictedWithoutAReport(t *testing.T) {
	st, _ := newStore(t)
	mkdir(t, st.EnvDir(testOrg, testEnv))
	evictAll(t, st)
	if _, err := os.Stat(st.EnvDir(testOrg, testEnv)); !os.IsNotExist(err) {
		t.Fatal("the state was not evicted")
	}
	if got := st.Evicted(); len(got) != 0 {
		t.Fatalf("evicted = %+v, want none", got)
	}
}

// An owner mark the builder replaced (a link, not the cell's shape) names nobody.
func TestAnOwnerMarkThatIsNotTheCellsNamesNobody(t *testing.T) {
	dir := t.TempDir()
	if err := os.Symlink("/etc/hostname", filepath.Join(dir, stateOwnerMark)); err != nil {
		t.Fatal(err)
	}
	if _, ok := ownerOf(dir); ok {
		t.Fatal("a symlinked owner mark was read")
	}
}

// The ledger keeps the newest maxEvicted environments.
func TestTheLedgerKeepsTheNewestEvictions(t *testing.T) {
	st, _ := newStore(t)
	base := fakeClock(st).Now()
	for i := range maxEvicted + 3 {
		st.recordEvicted(ownerMark{Org: testOrg, Env: "env-" + string(rune('a'+i%26)) + string(rune('a'+i/26))}, base.Add(time.Duration(i)*time.Minute), 0)
	}
	got := st.Evicted()
	if len(got) != maxEvicted {
		t.Fatalf("kept %d, want %d", len(got), maxEvicted)
	}
	if !got[0].At.Equal(base.Add(time.Duration(maxEvicted+2) * time.Minute)) {
		t.Fatalf("newest first: %+v", got[0])
	}
	files, _ := os.ReadDir(st.evictedDir())
	if len(files) != maxEvicted {
		t.Fatalf("%d ledger files, want %d", len(files), maxEvicted)
	}
}
