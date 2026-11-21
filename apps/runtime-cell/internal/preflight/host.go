package preflight

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// FreeBytes is what an unprivileged writer may still write under path, read
// on its nearest directory that exists: before an install the cell's
// directories may not be there yet, and they will be made on that disk.
func FreeBytes(path string) (uint64, error) {
	p := filepath.Clean(path)
	for {
		var st unix.Statfs_t
		err := unix.Statfs(p, &st)
		if err == nil {
			return st.Bavail * uint64(st.Bsize), nil //nolint:gosec // G115: Bsize is a block size, positive
		}
		if !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
		parent := filepath.Dir(p)
		if parent == p {
			return 0, err
		}
		p = parent
	}
}
