//go:build !unix

package dockergvisor

import (
	"io/fs"
	"os"
)

// No file owners to read outside Unix; docker-gvisor runs on Linux only.
func defaultHostDirs() hostDirs {
	return hostDirs{uid: builderUser, gid: builderUser, self: os.Geteuid(), chown: os.Lchown,
		owner: func(fs.FileInfo) (int, bool) { return 0, false }}
}
