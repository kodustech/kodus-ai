// Package vsock is the stream between the cell and the guest agent in a
// Firecracker microVM (docs/runtime/isolation-architecture.md C4).
//
// Firecracker exposes a guest's vsock device on the host as a unix socket
// (its uds_path). A host-initiated connection connects to that socket,
// writes "CONNECT <port>\n" and reads "OK <host port>\n"; from then on the
// connection is a byte stream to whatever the guest accepted on that vsock
// port. Dial is the host side; Listen (Linux) is the guest agent's.
//
// What travels on the stream is the guest agent's framing
// (internal/guest: length-prefixed protocol frames), the same as over
// docker exec -i on gVisor.
package vsock

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// GuestPort is the vsock port the guest agent listens on in every microVM.
const GuestPort = 1024

// GuestCID is the context id every microVM's vsock device gets: the host
// side reaches it through its own unix socket, so one value serves every VM.
const GuestCID = 3

// maxAck bounds the acknowledgement line: "OK " and a 32-bit port.
const maxAck = 16

// ErrNotListening is a guest nobody answers on the port (not booted yet, or
// its guest agent died): Firecracker closes the connection instead of
// acknowledging it. A caller waiting for a boot tries again.
var ErrNotListening = errors.New("vsock: the guest does not answer on that port")

// Dial opens a stream to port in the guest whose vsock device is the unix
// socket uds. The handshake is bounded by ctx and by a second when ctx has
// no deadline; the stream itself has none.
func Dial(ctx context.Context, uds string, port uint32) (net.Conn, error) {
	var d net.Dialer
	c, err := d.DialContext(ctx, "unix", uds)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrNotListening, err)
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(time.Second)
	}
	_ = c.SetDeadline(deadline)
	if err := handshake(c, port); err != nil {
		_ = c.Close()
		return nil, err
	}
	_ = c.SetDeadline(time.Time{})
	return c, nil
}

// handshake writes the connect line and reads the acknowledgement one byte
// at a time, so nothing of the stream after it is consumed here.
func handshake(c net.Conn, port uint32) error {
	if _, err := fmt.Fprintf(c, "CONNECT %d\n", port); err != nil {
		return fmt.Errorf("%w: %w", ErrNotListening, err)
	}
	var line []byte
	b := make([]byte, 1)
	for {
		n, err := c.Read(b)
		if n == 1 {
			if b[0] == '\n' {
				break
			}
			line = append(line, b[0])
			if len(line) > maxAck {
				return fmt.Errorf("vsock: acknowledgement longer than %d bytes", maxAck)
			}
			continue
		}
		if err != nil {
			// Firecracker closes the connection when nothing listens.
			return fmt.Errorf("%w: %w", ErrNotListening, err)
		}
	}
	rest, ok := strings.CutPrefix(string(line), "OK ")
	if !ok {
		return fmt.Errorf("vsock: unexpected acknowledgement %q", line)
	}
	if _, err := strconv.ParseUint(rest, 10, 32); err != nil {
		return fmt.Errorf("vsock: unexpected acknowledgement %q", line)
	}
	return nil
}

// Addr is a vsock address (a context id and a port).
type Addr struct{ CID, Port uint32 }

func (Addr) Network() string { return "vsock" }
func (a Addr) String() string {
	return strconv.FormatUint(uint64(a.CID), 10) + ":" + strconv.FormatUint(uint64(a.Port), 10)
}
