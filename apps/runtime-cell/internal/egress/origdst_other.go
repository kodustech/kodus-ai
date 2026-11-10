//go:build !linux

package egress

import (
	"errors"
	"net"
)

// OriginalDst is Linux only; elsewhere the proxy is not transparent.
func OriginalDst(net.Conn) (net.IP, int, error) {
	return nil, 0, errors.New("SO_ORIGINAL_DST is Linux only")
}
