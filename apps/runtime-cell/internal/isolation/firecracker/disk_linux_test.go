//go:build linux

package firecracker

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A machine's root is a copy-on-write clone of the base: the clone reads as
// the base, and a write to it leaves the base as it was. A file system that
// cannot clone is refused by name. Needs a directory on XFS (reflink=1) or
// btrfs, and one on a file system without reflink:
//
//	KODY_E2E_REFLINK_DIR=/mnt/btrfs KODY_E2E_NOREFLINK_DIR=/mnt/ext4 go test -run TestARootIsACopyOnWriteClone ./internal/isolation/firecracker/
func TestARootIsACopyOnWriteCloneOfTheBase(t *testing.T) {
	dir, nodir := os.Getenv("KODY_E2E_REFLINK_DIR"), os.Getenv("KODY_E2E_NOREFLINK_DIR")
	if dir == "" || nodir == "" {
		t.Skip("KODY_E2E_REFLINK_DIR (XFS or btrfs) and KODY_E2E_NOREFLINK_DIR (ext4, tmpfs) name the two file systems")
	}
	c := defaultChecks()
	if err := probeReflink(c, dir); err != nil {
		t.Fatalf("a file system that clones was refused: %v", err)
	}
	err := probeReflink(c, nodir)
	if err == nil || !strings.Contains(err.Error(), "XFS with reflink=1 or btrfs") {
		t.Fatalf("a file system without reflink: %v", err)
	}
	base, clone := filepath.Join(dir, "base.ext4"), filepath.Join(dir, "clone.ext4")
	t.Cleanup(func() { _ = os.Remove(base); _ = os.Remove(clone) })
	if err := os.WriteFile(base, []byte(strings.Repeat("base", 4096)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := reflink(base, clone); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(clone, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteAt([]byte("MINE"), 0)
	_ = f.Close()
	b, _ := os.ReadFile(base)
	cl, _ := os.ReadFile(clone)
	if !strings.HasPrefix(string(b), "basebase") || !strings.HasPrefix(string(cl), "MINEbase") || len(cl) != len(b) {
		t.Fatalf("base %q clone %q", b[:8], cl[:8])
	}
}
