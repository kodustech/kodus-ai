//go:build !linux && !darwin

package management

import (
	"errors"
	"net"
	"os"
)

func peerUID(*net.UnixConn) (uint32, error) {
	return 0, errors.New("injector management: unsupported peer credentials")
}
func fileUID(os.FileInfo) (uint32, bool) { return 0, false }
