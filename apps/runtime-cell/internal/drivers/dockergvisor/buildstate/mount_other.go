//go:build !linux

package buildstate

// DefaultMounter returns no overlay outside Linux: every non-seeding build keeps its own state.
func DefaultMounter() Mounter { return nil }

// MounterFor returns no overlay and no clone outside Linux.
func MounterFor(string) (Mounter, string) { return nil, "none" }

func FreeBytes(string) (int64, error) { return 1 << 62, nil }
