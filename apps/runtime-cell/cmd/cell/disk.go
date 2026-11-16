package main

import (
	"golang.org/x/sys/unix"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
)

// diskWatch is the free-disk watchdog of Docker's data root, nil when
// minFreeGB is zero.
func diskWatch(dataRoot string, minFreeGB int) *agent.DiskWatch {
	if minFreeGB <= 0 || dataRoot == "" {
		return nil
	}
	return &agent.DiskWatch{Free: func() (uint64, error) { return freeBytes(dataRoot) }, MinFreeBytes: uint64(minFreeGB) << 30}
}

// freeBytes is what an unprivileged writer may still write under path.
func freeBytes(path string) (uint64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, err
	}
	return st.Bavail * uint64(st.Bsize), nil //nolint:gosec // G115: Bsize is a block size, positive
}
