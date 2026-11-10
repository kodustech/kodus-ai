package checkoutfs

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestReplaceNeverWritesThroughAPlantedSymlink(t *testing.T) {
	outside := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(outside, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	checkout := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(checkout, ".kodus-compose.yaml")); err != nil {
		t.Fatal(err)
	}
	if err := Replace(checkout, ".kodus-compose.yaml", []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(outside); string(b) != "original" {
		t.Fatalf("the file the symlink pointed at was written: %q", b)
	}
	fi, err := os.Lstat(filepath.Join(checkout, ".kodus-compose.yaml"))
	if err != nil || !fi.Mode().IsRegular() {
		t.Fatalf("the cell's file is not a regular file: %v %v", fi, err)
	}
}

func TestReplaceRefusesPathsOutsideTheCheckout(t *testing.T) {
	checkout := t.TempDir()
	for _, name := range []string{"", "/etc/passwd", "../x", "a/../../x"} {
		if err := Replace(checkout, name, nil, 0o600); err == nil {
			t.Errorf("%q accepted", name)
		}
	}
	// A planted directory symlink does not carry a nested write out either.
	if err := os.Symlink(t.TempDir(), filepath.Join(checkout, "sub")); err != nil {
		t.Fatal(err)
	}
	if err := Replace(checkout, "sub/f", []byte("x"), 0o600); err == nil {
		t.Error("wrote through a directory symlink")
	}
}

func TestRemove(t *testing.T) {
	checkout := t.TempDir()
	if err := Remove(checkout, "absent"); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(checkout, "f"), nil, 0o600)
	if err := Remove(checkout, "f"); err != nil {
		t.Fatal(err)
	}
}

// A seed file the PR made a symlink to a file of the cell's is never read:
// the cell would pipe the cell's file into the PR's database.
func TestReadStaysInsideTheCheckoutAndUnderItsBound(t *testing.T) {
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("cell's"), 0o600); err != nil {
		t.Fatal(err)
	}
	checkout := t.TempDir()
	if err := os.MkdirAll(filepath.Join(checkout, "db"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(checkout, "db", "seed.sql"), []byte("SELECT 1;"), 0o600); err != nil {
		t.Fatal(err)
	}
	if b, err := Read(checkout, "db/seed.sql", 64); err != nil || string(b) != "SELECT 1;" {
		t.Fatalf("read %q %v", b, err)
	}
	if err := os.Symlink(outside, filepath.Join(checkout, "db", "planted.sql")); err != nil {
		t.Fatal(err)
	}
	if b, err := Read(checkout, "db/planted.sql", 64); err == nil {
		t.Fatalf("read through a symlink out of the checkout: %q", b)
	}
	for _, name := range []string{"", "/etc/passwd", "../x"} {
		if _, err := Read(checkout, name, 64); err == nil {
			t.Errorf("%q read", name)
		}
	}
	if _, err := Read(checkout, "db/seed.sql", 4); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("a file over the bound: %v", err)
	}
}
