package bakecatalog

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func open(t *testing.T, dir string, sync func(*os.File) error) *Catalog {
	t.Helper()
	c, err := Open(context.Background(), Config{Dir: dir, Cell: "cell-1", Driver: "test", SyncDir: sync,
		Valid: func(g Generation) bool { return g.ID != "" && g.Cell == "cell-1" }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func gen(id, env string) Generation {
	return Generation{ID: id, Cell: "cell-1", Org: "org-a", Environment: env, SHA: "s", RecipeSHA: "r", Nonce: "n", Images: map[string]string{}, Volumes: map[string]string{}}
}

// A generation is retired while staged, eligible and current once published,
// and the one it replaces goes only after the acknowledge, when nothing
// holds it and its artifacts were removed.
func TestAGenerationsLifeFromStageToPrune(t *testing.T) {
	dir := t.TempDir()
	c := open(t, dir, nil)
	release, err := c.Stage(gen("g1", "env-1"))
	if err != nil {
		t.Fatal(err)
	}
	if _, eligible, retired := c.Lookup("g1"); eligible || !retired {
		t.Fatal("a staged generation is not retired-and-held")
	}
	var removed []string
	remove := func(g Generation) error { removed = append(removed, g.ID); return nil }
	if err := c.Prune(remove); err != nil || len(removed) != 0 {
		t.Fatalf("a held staged generation was dropped: %v %v", removed, err)
	}
	if err := c.Publish(gen("g1", "env-1")); err != nil {
		t.Fatal(err)
	}
	release()
	if c.Current("org-a", "env-1") != "g1" {
		t.Fatal("the published generation is not current")
	}
	if err := c.Publish(gen("g2", "env-1")); err != nil {
		t.Fatal(err)
	}
	// Until the acknowledge the replaced generation stays eligible.
	if err := c.Prune(remove); err != nil || len(removed) != 0 {
		t.Fatalf("pruned before the acknowledge: %v %v", removed, err)
	}
	_, hold, ok := c.Hold("g1", "org-a", "env-1")
	if !ok || !c.Acknowledge("g2") || c.Acknowledge("g1") {
		t.Fatal("hold or acknowledge")
	}
	if err := c.Prune(remove); err != nil || len(removed) != 0 {
		t.Fatalf("a held generation was dropped: %v %v", removed, err)
	}
	hold()
	hold() // idempotent
	if err := c.Prune(remove); err != nil || len(removed) != 1 || removed[0] != "g1" {
		t.Fatalf("removed %v (%v), want g1", removed, err)
	}
	if eligible, retired, held := c.Counts(); eligible != 1 || retired != 0 || held != 0 {
		t.Fatalf("eligible %d retired %d held %d", eligible, retired, held)
	}
	// What a restart reads is what was published.
	_ = c.Close()
	again := open(t, dir, nil)
	if again.Current("org-a", "env-1") != "g2" {
		t.Fatal("the current generation did not survive a restart")
	}
}

// Artifacts that could not be removed keep their journal entry for a retry.
func TestAFailedRemovalStaysRetired(t *testing.T) {
	c := open(t, t.TempDir(), nil)
	for _, id := range []string{"g1", "g2"} {
		if err := c.Publish(gen(id, "env-1")); err != nil {
			t.Fatal(err)
		}
	}
	c.Acknowledge("g2")
	if err := c.Prune(func(Generation) error { return errors.New("busy") }); err == nil {
		t.Fatal("the removal's failure was lost")
	}
	if _, eligible, retired := c.Lookup("g1"); eligible || !retired {
		t.Fatal("a generation whose artifacts stayed left the journal")
	}
}

// One controller, and only the bytes this package writes.
func TestTheCatalogRefusesASecondControllerAndForeignBytes(t *testing.T) {
	dir := t.TempDir()
	c := open(t, dir, nil)
	cfg := Config{Dir: dir, Cell: "cell-1", Driver: "test", Valid: func(Generation) bool { return true }}
	if _, err := Open(context.Background(), cfg); err == nil {
		t.Fatal("a second controller opened the catalog")
	}
	_ = c.Close()
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte(`{"version":1,"version":2}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(context.Background(), cfg); err == nil {
		t.Fatal("a non-canonical catalog was accepted")
	}
	other := t.TempDir()
	open(t, other, nil).Close()
	cfg.Dir, cfg.Cell = other, "cell-2"
	foreign, err := Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err) // nothing written yet: an empty directory is anyone's
	}
	foreign.Close()
}

// A rename that may not be durable keeps the change: it may have landed.
func TestAnUncertainCommitIsKeptInMemory(t *testing.T) {
	fail := false
	c := open(t, t.TempDir(), func(f *os.File) error {
		if fail {
			return errors.New("fsync failed after rename")
		}
		return f.Sync()
	})
	fail = true
	if err := c.Publish(gen("g1", "env-1")); !errors.Is(err, ErrCommitUncertain) {
		t.Fatalf("lost commit uncertainty: %v", err)
	}
	if c.Current("org-a", "env-1") != "g1" {
		t.Fatal("a potential commit was rolled back in memory")
	}
}
