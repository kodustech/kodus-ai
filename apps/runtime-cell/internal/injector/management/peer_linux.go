//go:build linux

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
		var cred *unix.Ucred
		cred, socketErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		if socketErr == nil {
			uid = cred.Uid
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
