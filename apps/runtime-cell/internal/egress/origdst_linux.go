//go:build linux

package egress

import (
	"errors"
	"net"
	"syscall"
)

const soOriginalDst = 80

// OriginalDst reads where an nftables-redirected connection was going.
func OriginalDst(c net.Conn) (net.IP, int, error) {
	tc, ok := c.(*net.TCPConn)
	if !ok {
		return nil, 0, errors.New("not tcp")
	}
	raw, err := tc.SyscallConn()
	if err != nil {
		return nil, 0, err
	}
	var ip net.IP
	var port int
	var serr error
	err = raw.Control(func(fd uintptr) {
		m, e := syscall.GetsockoptIPv6Mreq(int(fd), syscall.IPPROTO_IP, soOriginalDst)
		if e != nil {
			serr = e
			return
		}
		port = int(m.Multiaddr[2])<<8 | int(m.Multiaddr[3])
		ip = net.IPv4(m.Multiaddr[4], m.Multiaddr[5], m.Multiaddr[6], m.Multiaddr[7])
	})
	if err != nil {
		return nil, 0, err
	}
	return ip, port, serr
}
