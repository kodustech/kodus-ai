package checkout

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGoSumPinsReadsTheCheckoutsGoSum(t *testing.T) {
	dir := t.TempDir()
	if pins, err := GoSumPins(dir); err != nil || pins != nil {
		t.Fatalf("no go.sum: %v %v", pins, err)
	}
	_ = os.WriteFile(filepath.Join(dir, "go.sum"), []byte("golang.org/x/mod v0.20.0 h1:a=\ngithub.com/a/b v1.0.0/go.mod h1:b=\n"), 0o644)
	pins, err := GoSumPins(dir)
	if err != nil || len(pins) != 2 || pins[0] != "github.com/a/b@v1.0.0" {
		t.Fatalf("%v %v", pins, err)
	}
	// A workspace module's go.sum and go.work.sum count too.
	_ = os.MkdirAll(filepath.Join(dir, "apps", "x"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "apps", "x", "go.sum"), []byte("github.com/c/d v2.0.0 h1:c=\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "go.work.sum"), []byte("github.com/e/f v0.1.0 h1:e=\n"), 0o644)
	if pins, err := GoSumPins(dir); err != nil || len(pins) != 4 {
		t.Fatalf("workspace: %v %v", pins, err)
	}
	_ = os.WriteFile(filepath.Join(dir, "go.sum"), []byte("not a go.sum line\n"), 0o644)
	if _, err := GoSumPins(dir); err == nil {
		t.Fatal("a malformed go.sum pinned something")
	}
}
