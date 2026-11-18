//go:build unix

package dockergvisor

import (
	"io/fs"
	"os"
	"syscall"
)

// defaultHostDirs changes ownership with lchown (never through a link) and
// reads it from stat; the cell runs as root, so it may give a directory to
// the builder.
func defaultHostDirs() hostDirs {
	return hostDirs{uid: builderUser, gid: builderUser, self: os.Geteuid(), chown: os.Lchown, owner: statOwner}
}

func statOwner(info fs.FileInfo) (int, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return int(st.Uid), true
}
