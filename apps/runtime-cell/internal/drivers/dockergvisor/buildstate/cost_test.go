package buildstate

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// seedTaking seeds env's state at the store's clock time at, the build
// holding it for took.
func seedTaking(t *testing.T, st *Store, env string, at time.Time, took time.Duration) {
	t.Helper()
	fakeClock(st).Set(at)
	req := seed("m-" + env)
	req.Env = env
	s, ok := st.Acquire(context.Background(), req)
	if !ok {
		t.Fatalf("seed of %s refused", env)
	}
	fakeClock(st).Set(at.Add(took))
	st.Release(s)
}

// evictOne runs Evict with the disk below the floor until one state is gone.
func evictOne(t *testing.T, st *Store) {
	t.Helper()
	st.minFree = 100
	calls := 0
	st.freeBytes = func(string) (int64, error) {
		// Below for the first state only (the store makes no spares here).
		if calls++; calls > 1 {
			return 1000, nil
		}
		return 10, nil
	}
	if err := st.Evict(); err != nil {
		t.Fatal(err)
	}
}

func gone(st *Store, env string) bool {
	_, err := os.Stat(st.EnvDir(testOrg, env))
	return os.IsNotExist(err)
}

// Under the disk floor, of two states used as recently, the one that was
// cheap to make goes first: eviction took states least recently used first
// whatever they cost, so the heaviest repositories' states went as readily as
// the lightest and their next pull requests built cold for fifteen minutes.
func TestEvictionTakesTheStateCheapestToRebuildFirst(t *testing.T) {
	st, _ := newStore(t)
	base := fakeClock(st).Now()
	// The costly one was used a little earlier: least recently used would take it.
	seedTaking(t, st, "env-heavy", base, 30*time.Minute)
	seedTaking(t, st, "env-light", base.Add(31*time.Minute), time.Minute)
	evictOne(t, st)
	if !gone(st, "env-light") {
		t.Fatal("the state cheap to rebuild was kept")
	}
	if gone(st, "env-heavy") {
		t.Fatal("the state costly to rebuild was evicted first")
	}
}

// What a state costs stops counting once nobody uses it: a costly state
// unused for days goes before a cheap one in use, so a heavy environment
// nobody runs does not keep its disk forever.
func TestACostlyStateNobodyUsesGoesBeforeACheapOneInUse(t *testing.T) {
	st, _ := newStore(t)
	base := fakeClock(st).Now()
	seedTaking(t, st, "env-heavy", base, 30*time.Minute)
	seedTaking(t, st, "env-light", base.Add(7*24*time.Hour), time.Minute)
	evictOne(t, st)
	if !gone(st, "env-heavy") {
		t.Fatal("a costly state unused for a week was kept over a cheap one in use")
	}
	if gone(st, "env-light") {
		t.Fatal("the cheap state in use was evicted")
	}
}

// Of two states as costly and used at the same time, the larger goes first:
// it frees more for the same loss.
func TestOfTwoStatesWorthTheSameTheLargerGoesFirst(t *testing.T) {
	st, _ := newStore(t)
	base := fakeClock(st).Now()
	seedTaking(t, st, "env-small", base, time.Minute)
	seedTaking(t, st, "env-large", base, time.Minute)
	if err := os.WriteFile(filepath.Join(st.EnvDir(testOrg, "env-large"), "layer"), make([]byte, 1<<16), 0o600); err != nil {
		t.Fatal(err)
	}
	evictOne(t, st)
	if !gone(st, "env-large") || gone(st, "env-small") {
		t.Fatalf("large gone %v, small gone %v; want only the large one gone", gone(st, "env-large"), gone(st, "env-small"))
	}
}

// The ledger says what the evicted state cost to make: the build that made it
// from none, not a later warm seed's, so the hub can tell a pull request
// that would build cold past its ceiling from one that would not.
func TestTheLedgerSaysWhatTheEvictedStateCostToMake(t *testing.T) {
	st, _ := newStore(t)
	base := fakeClock(st).Now()
	seedTaking(t, st, testEnv, base, 17*time.Minute)
	seedTaking(t, st, testEnv, base.Add(time.Hour), 2*time.Minute) // warm: the state was there
	evictAll(t, st)
	got := st.Evicted()
	if len(got) != 1 || got[0].Rebuild != 17*time.Minute {
		t.Fatalf("evicted = %+v, want one with a rebuild of 17m", got)
	}
	// A restart reads it back.
	if again := newStoreAt(t, st.root, &fakeMounter{}).Evicted(); len(again) != 1 || again[0].Rebuild != 17*time.Minute {
		t.Fatalf("after a restart evicted = %+v", again)
	}
}

// A rebuild mark the builder replaced (a link, or not the cell's shape) says nothing.
func TestARebuildMarkThatIsNotTheCellsSaysNothing(t *testing.T) {
	link := t.TempDir()
	if err := os.Symlink("/etc/hostname", filepath.Join(link, stateRebuildMark)); err != nil {
		t.Fatal(err)
	}
	junk := t.TempDir()
	if err := os.WriteFile(filepath.Join(junk, stateRebuildMark), []byte(`{"seconds":-4}`), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{link, junk} {
		if _, ok := rebuildOf(dir); ok {
			t.Fatalf("%s: a mark that is not the cell's was read", dir)
		}
	}
}
