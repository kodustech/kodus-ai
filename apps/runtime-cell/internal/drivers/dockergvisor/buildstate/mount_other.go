//go:build !linux

package buildstate

// No overlay outside Linux: every non-seeding build keeps its own state.
func DefaultMounter() Mounter { return nil }

func FreeBytes(string) (int64, error) { return 1 << 62, nil }
