//go:build !linux && !darwin

package toollayer

import "io/fs"

// Without inode and ctime the fingerprint degrades to size and mtime, and
// the link count is unknown, so GC never frees a file here.
func sysOf(fs.FileInfo) (sysInfo, bool) { return sysInfo{}, false }
