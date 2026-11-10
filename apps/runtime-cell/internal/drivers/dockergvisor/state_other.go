//go:build !linux

package dockergvisor

// No overlay outside Linux: every non-seeding build keeps its own state.
func defaultMounter() stateMounter { return nil }

func statfsFree(string) (int64, error) { return 1 << 62, nil }
