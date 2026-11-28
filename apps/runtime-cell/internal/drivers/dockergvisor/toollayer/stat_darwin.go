//go:build darwin

package toollayer

import (
	"io/fs"
	"syscall"
)

func sysOf(fi fs.FileInfo) (sysInfo, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return sysInfo{}, false
	}
	return sysInfo{
		ino:     st.Ino,
		ctimeNs: int64(st.Ctimespec.Sec)*1e9 + int64(st.Ctimespec.Nsec),
		nlink:   uint64(st.Nlink),
		uid:     int(st.Uid),
	}, true
}
