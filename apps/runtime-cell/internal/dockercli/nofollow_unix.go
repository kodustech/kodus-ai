//go:build unix

package dockercli

import (
	"os"
	"syscall"
)

// oNoFollow opens a file the builder wrote without following a link it made.
const oNoFollow = syscall.O_NOFOLLOW

// OpenNoFollow opens path read-only, refusing a symbolic link in its place.
func OpenNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|oNoFollow, 0) //nolint:gosec // G304: read-only open of a file the builder wrote in the cell's own build dir; O_NOFOLLOW refuses a link
}
