//go:build linux

package vsock

import (
	"fmt"
	"io"
	"net"
	"os"

	"golang.org/x/sys/unix"
)

// Listener accepts the host's connections on one vsock port in the guest.
type Listener struct{ fd int }

// Listen listens on port for any host connection (VMADDR_CID_ANY).
func Listen(port uint32) (*Listener, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("vsock: socket: %w", err)
	}
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: port}); err != nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("vsock: bind port %d: %w", port, err)
	}
	if err := unix.Listen(fd, 64); err != nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("vsock: listen: %w", err)
	}
	return &Listener{fd: fd}, nil
}

// Accept waits for the next connection. The net package does not know
// AF_VSOCK, so a connection is the descriptor as a file.
func (l *Listener) Accept() (io.ReadWriteCloser, error) {
	nfd, _, err := unix.Accept4(l.fd, unix.SOCK_CLOEXEC)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(nfd), "vsock"), nil
}

// AcceptFrom waits for the next connection and says which vsock address it
// came from (2 is the host).
func (l *Listener) AcceptFrom() (io.ReadWriteCloser, uint32, error) {
	nfd, sa, err := unix.Accept4(l.fd, unix.SOCK_CLOEXEC)
	if err != nil {
		return nil, 0, err
	}
	var cid uint32
	if vm, ok := sa.(*unix.SockaddrVM); ok {
		cid = vm.CID
	}
	return os.NewFile(uintptr(nfd), "vsock"), cid, nil
}

// Close stops listening; a blocked Accept returns an error.
func (l *Listener) Close() error {
	_ = unix.Shutdown(l.fd, unix.SHUT_RDWR)
	return unix.Close(l.fd)
}

// ListenNet is Listen as a net.Listener (an HTTP server's): each accepted
// connection a net.Conn on its own non-blocking descriptor, with deadlines.
func ListenNet(port uint32) (net.Listener, error) {
	l, err := Listen(port)
	if err != nil {
		return nil, err
	}
	return netListener{l: l, port: port}, nil
}

type netListener struct {
	l    *Listener
	port uint32
}

func (n netListener) Accept() (net.Conn, error) {
	nfd, sa, err := unix.Accept4(n.l.fd, unix.SOCK_CLOEXEC|unix.SOCK_NONBLOCK)
	if err != nil {
		return nil, err
	}
	var peer Addr
	if vm, ok := sa.(*unix.SockaddrVM); ok {
		peer = Addr{CID: vm.CID, Port: vm.Port}
	}
	// A non-blocking descriptor makes a pollable os.File: reads and writes
	// honour deadlines.
	return fileConn{File: os.NewFile(uintptr(nfd), "vsock"), local: Addr{CID: unix.VMADDR_CID_ANY, Port: n.port}, peer: peer}, nil
}

func (n netListener) Close() error   { return n.l.Close() }
func (n netListener) Addr() net.Addr { return Addr{CID: unix.VMADDR_CID_ANY, Port: n.port} }

type fileConn struct {
	*os.File
	local, peer Addr
}

func (c fileConn) LocalAddr() net.Addr  { return c.local }
func (c fileConn) RemoteAddr() net.Addr { return c.peer }
