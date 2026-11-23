package bakecatalog

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func open(t *testing.T, dir string, sync func(*os.File) error) *Catalog {
	t.Helper()
	c, err := Open(context.Background(), Config{
		Dir: dir, Cell: "cell-1", Driver: "test", SyncDir: sync,
		Valid: func(g Generation) bool { return g.ID != "" && g.Cell == "cell-1" },
	})
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

// One controller at a time; a catalog that is not what this package writes
// never stops the cell: it is moved aside and the cell starts empty.
func TestACatalogTheCellCannotAcceptIsMovedAsideNotFatal(t *testing.T) {
	dir := t.TempDir()
	c := open(t, dir, nil)
	cfg := Config{Dir: dir, Cell: "cell-1", Driver: "test", Valid: func(Generation) bool { return true }}
	if _, err := Open(context.Background(), cfg); err == nil {
		t.Fatal("a second controller opened the catalog")
	}
	_ = c.Close()
	var got []Quarantine
	cfg.Quarantined = func(q Quarantine) { got = append(got, q) }
	cfg.Now = func() time.Time { return time.Unix(1000, 0) }
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte(`{"version":1,"version":2}`), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Open(context.Background(), cfg)
	if err != nil {
		t.Fatalf("a corrupt catalog stopped the cell: %v", err)
	}
	if len(got) != 1 || got[0].Reason != "corrupt" || got[0].File != quarantinePrefix+"1000" {
		t.Fatalf("quarantine report: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(dir, FileName)); !os.IsNotExist(err) {
		t.Fatal("the corrupt catalog was left in place")
	}
	if e, r, _ := c.Counts(); e != 0 || r != 0 {
		t.Fatalf("the cell did not start empty: %d %d", e, r)
	}
	if err := c.Publish(gen("g1", "env-1")); err != nil {
		t.Fatalf("the empty catalog cannot be written: %v", err)
	}
	_ = c.Close()
}

// The catalog of another cell is moved aside with its counts, the new cell
// starts empty, and only the newest quarantined file is kept.
func TestTheCatalogOfAnotherCellIsQuarantinedAndOnlyTheNewestKept(t *testing.T) {
	dir := t.TempDir()
	foreign := open(t, dir, nil)
	if err := foreign.Publish(gen("g1", "env-1")); err != nil {
		t.Fatal(err)
	}
	if _, err := foreign.Stage(gen("g2", "env-2")); err != nil {
		t.Fatal(err)
	}
	_ = foreign.Close()
	var got []Quarantine
	cfg := Config{Dir: dir, Cell: "cell-2", Driver: "test", Valid: func(g Generation) bool { return g.Cell == "cell-2" },
		Quarantined: func(q Quarantine) { got = append(got, q) }}
	cfg.Now = func() time.Time { return time.Unix(1, 0) }
	c, err := Open(context.Background(), cfg)
	if err != nil {
		t.Fatalf("another cell's catalog stopped the cell: %v", err)
	}
	if len(got) != 1 || got[0].Reason != "foreign_cell" || got[0].Owner != "cell-1" || got[0].Eligible != 1 || got[0].Retired != 1 {
		t.Fatalf("quarantine report: %+v", got)
	}
	if _, ok := c.Adopted(); ok || c.Owner() != "cell-2" {
		t.Fatal("a catalog of another cell was adopted without an adoption")
	}
	_ = c.Close()
	// A second quarantine leaves one file.
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg.Now = func() time.Time { return time.Unix(2, 0) }
	c2, err := Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	_ = c2.Close()
	files, _ := filepath.Glob(filepath.Join(dir, quarantinePrefix+"*"))
	if len(files) != 1 || filepath.Base(files[0]) != quarantinePrefix+"2" {
		t.Fatalf("quarantined files: %v", files)
	}
}

// A catalog file with loose permissions or a link is moved aside too.
func TestAnUnsafeCatalogFileIsQuarantined(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	var got []Quarantine
	c, err := Open(context.Background(), Config{Dir: dir, Cell: "cell-1", Driver: "test", Valid: func(Generation) bool { return true }, Quarantined: func(q Quarantine) { got = append(got, q) }})
	if err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
	if len(got) != 1 || got[0].Reason != "unsafe" {
		t.Fatalf("quarantine report: %+v", got)
	}
}

func adoptConfig(dir, org string) Config {
	return Config{Dir: dir, Cell: "cell-2", Driver: "test", Valid: func(g Generation) bool { return g.Cell == "cell-2" },
		Adopt: &Adoption{Org: org, Valid: func(owner string) func(Generation) bool { return func(g Generation) bool { return g.Cell == owner } }}}
}

// A host made from a template adopts the template's catalog for the org it
// serves, keeps the owner's name on the generations, and retires every other
// org's generation.
func TestAdoptionKeepsOnlyTheServedOrgsGenerations(t *testing.T) {
	dir := t.TempDir()
	foreign := open(t, dir, nil)
	mine := gen("g1", "env-1")
	other := gen("g2", "env-9")
	other.Org = "org-b"
	for _, g := range []Generation{mine, other} {
		if err := foreign.Publish(g); err != nil {
			t.Fatal(err)
		}
	}
	_ = foreign.Close()
	c, err := Open(context.Background(), adoptConfig(dir, "org-a"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	a, ok := c.Adopted()
	if !ok || a.From != "cell-1" || a.Kept != 1 || a.Retired != 1 || c.Owner() != "cell-1" {
		t.Fatalf("adoption: %+v %v owner %q", a, ok, c.Owner())
	}
	if _, _, ok := c.Hold("g1", "org-a", "env-1"); !ok {
		t.Fatal("the served org's generation cannot be used")
	}
	if _, _, ok := c.Hold("g2", "org-b", "env-9"); ok {
		t.Fatal("another org's generation is usable")
	}
	if c.Current("org-b", "env-9") != "" {
		t.Fatal("another org's generation is still current")
	}
	var removed []string
	_ = c.Acknowledge("g1")
	if err := c.Prune(func(g Generation) error { removed = append(removed, g.ID); return nil }); err != nil || len(removed) != 1 || removed[0] != "g2" {
		t.Fatalf("the other org's artifacts were not left for removal: %v %v", removed, err)
	}
	// The change is on disk under the owner's name: a restart reads it back.
	_ = c.Close()
	again, err := Open(context.Background(), adoptConfig(dir, "org-a"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = again.Close() }()
	if e, _, _ := again.Counts(); e != 1 {
		t.Fatalf("restart lost the adopted generation: %d", e)
	}
}

// Adoption never extends to a catalog whose generations the driver would not
// have made for its owner.
func TestAdoptionRefusesACatalogOfInvalidGenerations(t *testing.T) {
	dir := t.TempDir()
	foreign := open(t, dir, nil)
	if err := foreign.Publish(gen("g1", "env-1")); err != nil {
		t.Fatal(err)
	}
	_ = foreign.Close()
	cfg := adoptConfig(dir, "org-a")
	cfg.Adopt.Valid = func(string) func(Generation) bool { return func(Generation) bool { return false } }
	var got []Quarantine
	cfg.Quarantined = func(q Quarantine) { got = append(got, q) }
	c, err := Open(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
	if _, ok := c.Adopted(); ok || len(got) != 1 {
		t.Fatalf("adopted a catalog it should refuse: %+v", got)
	}
}

// A generation the driver finds gone is retired, not fatal; a held one stays.
func TestRetireMakesAnEligibleGenerationCleanupWork(t *testing.T) {
	c := open(t, t.TempDir(), nil)
	if err := c.Publish(gen("g1", "env-1")); err != nil {
		t.Fatal(err)
	}
	_, release, _ := c.Hold("g1", "org-a", "env-1")
	if c.Retire("g1") {
		t.Fatal("a held generation was retired")
	}
	release()
	if !c.Retire("g1") || c.Current("org-a", "env-1") != "" {
		t.Fatal("not retired")
	}
	if _, eligible, retired := c.Lookup("g1"); eligible || !retired {
		t.Fatal("not waiting for removal")
	}
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
