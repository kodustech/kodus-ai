package isolation

import (
	"os"
	"path/filepath"
	"testing"
)

func TestKVMIsOnlyACharacterDeviceTheCellCanOpen(t *testing.T) {
	dir := t.TempDir()
	plain := filepath.Join(dir, "kvm")
	if err := os.WriteFile(plain, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if kvmAt(plain) {
		t.Fatal("a regular file named kvm reads as KVM")
	}
	if kvmAt(filepath.Join(dir, "missing")) {
		t.Fatal("a missing /dev/kvm reads as KVM")
	}
	// /dev/null is a character device anyone opens: the probe accepts what it can open.
	if !kvmAt(os.DevNull) {
		t.Fatal("an openable character device does not read as usable")
	}
}

func TestArchIsTheProtocolsWordOrNothing(t *testing.T) {
	for goarch, want := range map[string]string{"amd64": "x86_64", "arm64": "arm64", "riscv64": "", "386": ""} {
		if got := ArchOf(goarch); got != want {
			t.Errorf("ArchOf(%q) = %q, want %q", goarch, got, want)
		}
	}
}
