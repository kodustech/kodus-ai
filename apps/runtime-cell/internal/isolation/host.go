package isolation

import (
	"os"
	"runtime"
)

// Host is what the cell's host gives the backends, as hello capabilities
// announces it.
type Host struct {
	// KVM: /dev/kvm is a character device the cell can open for reading and
	// writing (what a microVM backend needs).
	KVM bool
	// Arch is the host's architecture in the protocol's words ("x86_64",
	// "arm64"); empty for another one.
	Arch string
}

// ProbeHost reads the host the cell runs on.
func ProbeHost() Host {
	return Host{KVM: kvmAt("/dev/kvm"), Arch: ArchOf(runtime.GOARCH)}
}

// ArchOf is a Go architecture in the protocol's words; empty for one the
// protocol does not name.
func ArchOf(goarch string) string {
	switch goarch {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "arm64"
	}
	return ""
}

func kvmAt(path string) bool {
	fi, err := os.Stat(path)
	if err != nil || fi.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	f, err := os.OpenFile(path, os.O_RDWR, 0) //nolint:gosec // G304: a fixed device path, opened only to learn whether the cell may use it
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}
