package dockergvisor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// R3-06: Destroy built paths from the caller's MachineID without checking
// it: an empty one made removeMachineCache remove <work>/cache/machine, the
// writable cache of every machine. A ref whose MachineID is not a machine
// name is refused before anything is read or removed.
func TestARefThatNamesNoMachineIsRefused(t *testing.T) {
	work := t.TempDir()
	d, err := New(context.Background(), newMemDocker(), Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: work})
	if err != nil {
		t.Fatal(err)
	}
	kept := filepath.Join(work, "cache", "machine", "kodus-claim-2-workload")
	if err := os.MkdirAll(kept, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"", ".", "..", "kodus-a/../..", "kodus-.*", "Kodus-A"} {
		if err := d.Destroy(context.Background(), driver.MachineRef{MachineID: id}); !errors.Is(err, driver.ErrNotOwned) {
			t.Errorf("Destroy(%q): %v", id, err)
		}
	}
	if _, err := os.Stat(kept); err != nil {
		t.Fatalf("another machine's cache: %v", err)
	}
}
