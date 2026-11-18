//go:build !unix

package dockercli

import "os"

// oNoFollow is zero where the system has no O_NOFOLLOW: the callers still
// refuse anything but a regular file by Lstat first.
const oNoFollow = 0

// OpenNoFollow opens path read-only.
func OpenNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY, 0)
}
