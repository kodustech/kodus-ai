//go:build darwin

package management

import (
	"golang.org/x/sys/unix"
	"net"
	"os"
	"syscall"
)

func peerUID(c *net.UnixConn) (uint32, error) {
	raw, e := c.SyscallConn()
	if e != nil {
		return 0, e
	}
	var uid uint32
	var socketErr error
	e = raw.Control(func(fd uintptr) {
		var cred *unix.Xucred
		cred, socketErr = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if socketErr == nil {
			if cred.Version != 0 {
				socketErr = syscall.EPERM
			} else {
				uid = cred.Uid
			}
		}
	})
	if e != nil {
		return 0, e
	}
	return uid, socketErr
}
func fileUID(info os.FileInfo) (uint32, bool) {
	s, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return s.Uid, true
}
