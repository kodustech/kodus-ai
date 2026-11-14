//go:build linux

package claimlimits

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestLinuxConstructorRefusesGlobalOrOrdinaryRoots(t *testing.T) {
	for _, root := range []string{"", "/", "/sys/fs/cgroup", "/sys/fs/cgroup/../cgroup/x", t.TempDir()} {
		if f, err := New(root); err == nil {
			f.Close()
			t.Errorf("accepted unsafe root %q", root)
		}
	}
}

// These are descriptor-security tests on an ordinary owned temp directory,
// not kernel controller proofs. New refuses such a directory as a cgroup root.
func TestLinuxDirectoryDoesNotFollowSymlinks(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	target := filepath.Join(outside, "keep")
	if err := os.WriteFile(target, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "memory.max")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "child")); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	d := &localDirectory{file}
	defer d.Close()
	if err := d.Write("memory.max", "0"); err == nil {
		t.Fatal("wrote through symlink")
	}
	if _, err := d.Read("memory.max"); err == nil {
		t.Fatal("read through symlink")
	}
	if _, err := d.Open("child"); err == nil {
		t.Fatal("opened symlink directory")
	}
	if got, err := os.ReadFile(target); err != nil || string(got) != "unchanged" {
		t.Fatalf("outside mutated %q %v", got, err)
	}
}
func TestLinuxReadControlFileIsBounded(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "cpu.max"), []byte(strings.Repeat("x", maxControlBytes+1)), 0600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	d := &localDirectory{file}
	defer d.Close()
	if _, err := d.Read("cpu.max"); err == nil {
		t.Fatal("accepted oversized control output")
	}
}

// Before the lifetime lock, two cell processes could prune each other's new
// empty parents between Ensure and launch. Separate directory descriptors and
// an independent process must both be excluded for the manager's full lifetime.
func TestLinuxDirectoryLockLifetime(t *testing.T) {
	dir := t.TempDir()
	open := func() *localDirectory {
		t.Helper()
		file, err := os.Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		return &localDirectory{file}
	}
	first := open()
	defer first.Close()
	if err := lockRoot(first); err != nil {
		t.Fatal(err)
	}
	second := open()
	defer second.Close()
	if err := lockRoot(second); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("second descriptor accepted: %v", err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestLinuxDirectoryLockChild$", "-test.count=1")
	child.Env = append(os.Environ(), "KODY_CGROUP_LOCK_PATH="+dir)
	if output, err := child.CombinedOutput(); err != nil {
		t.Fatalf("independent process lock check: %v %s", err, output)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lockRoot(second); err != nil {
		t.Fatalf("lock not released with descriptor: %v", err)
	}
}
func TestLinuxDirectoryLockChild(t *testing.T) {
	path := os.Getenv("KODY_CGROUP_LOCK_PATH")
	if path == "" {
		return
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	d := &localDirectory{file}
	defer d.Close()
	if err := lockRoot(d); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("independent manager accepted: %v", err)
	}
}
func TestLinuxDirectoryLockFailsClosedOnInvalidDescriptor(t *testing.T) {
	file, err := os.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lockRoot(&localDirectory{file}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("lock failure accepted: %v", err)
	}
}
