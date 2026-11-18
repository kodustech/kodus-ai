//go:build !linux

package vsock

import (
	"errors"
	"io"
	"net"
)

// Listener is Linux only: a guest agent in a microVM runs on Linux.
type Listener struct{}

// Listen refuses off Linux.
func Listen(uint32) (*Listener, error) { return nil, errors.New("vsock: listening needs Linux") }

func (*Listener) Accept() (io.ReadWriteCloser, error) { return nil, errors.New("vsock: not on Linux") }

func (*Listener) AcceptFrom() (io.ReadWriteCloser, uint32, error) {
	return nil, 0, errors.New("vsock: not on Linux")
}
func (*Listener) Close() error { return nil }

// ListenNet refuses off Linux.
func ListenNet(uint32) (net.Listener, error) { return nil, errors.New("vsock: listening needs Linux") }
