//go:build unix

package vsock

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// firecracker is the host side of a vsock device as Firecracker serves it:
// a unix socket that takes "CONNECT <port>\n", answers "OK <n>\n" and hands
// the connection to whatever listens on that port, or closes it.
type firecracker struct {
	uds   string
	ports map[uint32]func(net.Conn)
	ack   string
}

func startFirecracker(t *testing.T, fc *firecracker) string {
	t.Helper()
	// A short path: a unix socket path is bounded (104 bytes on darwin).
	dir, err := os.MkdirTemp("", "vs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	fc.uds = filepath.Join(dir, "v.sock")
	l, err := net.Listen("unix", fc.uds)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				line, err := bufio.NewReader(io.LimitReader(c, 32)).ReadString('\n')
				var port uint32
				if _, perr := fmtSscanPort(line, &port); err != nil || perr != nil || fc.ports[port] == nil {
					_ = c.Close()
					return
				}
				ack := fc.ack
				if ack == "" {
					ack = "OK 1073741824\n"
				}
				if _, err := io.WriteString(c, ack); err != nil {
					_ = c.Close()
					return
				}
				fc.ports[port](c)
			}()
		}
	}()
	return fc.uds
}

func fmtSscanPort(line string, port *uint32) (int, error) {
	rest, ok := strings.CutPrefix(strings.TrimSuffix(line, "\n"), "CONNECT ")
	if !ok {
		return 0, errors.New("not a connect line")
	}
	var n uint32
	for _, r := range rest {
		if r < '0' || r > '9' {
			return 0, errors.New("not a port")
		}
		n = n*10 + uint32(r-'0')
	}
	*port = n
	return 1, nil
}

// The host reaches the guest agent on its port through Firecracker's
// handshake, and the stream then carries the guest agent's frames both ways.
func TestAHostConnectionReachesTheGuestAgentOnItsPort(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "hello.txt"), []byte("from the guest"), 0o644); err != nil {
		t.Fatal(err)
	}
	fs, err := guest.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fs.Close() })
	uds := startFirecracker(t, &firecracker{ports: map[uint32]func(net.Conn){
		GuestPort: func(c net.Conn) { defer c.Close(); _ = guest.Serve(context.Background(), c, c, fs) },
	}})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := Dial(ctx, uds, GuestPort)
	if err != nil {
		t.Fatal(err)
	}
	client := guest.NewClient(conn, "cell-1", "claim-1")
	defer client.Close()
	path := "hello.txt"
	r, err := client.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindRead, Path: &path})
	if err != nil || !r.Ok || r.Content == nil {
		t.Fatalf("read through vsock: %+v %v", r, err)
	}
	if got := decode(t, *r.Content); got != "from the guest" {
		t.Fatalf("read %q", got)
	}
}

// A port nobody listens on is ErrNotListening, so a caller waiting for a
// boot knows to try again.
func TestAPortNobodyListensOnIsNotListening(t *testing.T) {
	uds := startFirecracker(t, &firecracker{ports: map[uint32]func(net.Conn){}})
	_, err := Dial(context.Background(), uds, GuestPort)
	if !errors.Is(err, ErrNotListening) {
		t.Fatalf("err %v", err)
	}
	if _, err := Dial(context.Background(), filepath.Join(t.TempDir(), "absent.sock"), GuestPort); !errors.Is(err, ErrNotListening) {
		t.Fatalf("a socket that does not exist: %v", err)
	}
}

// An acknowledgement that is not "OK <port>" ends the connection: the other
// end is not Firecracker's vsock device.
func TestAnAcknowledgementThatIsNotOKIsRefused(t *testing.T) {
	for _, ack := range []string{"NO 5\n", "OK five\n", "OK " + strings.Repeat("9", 40) + "\n"} {
		uds := startFirecracker(t, &firecracker{ack: ack, ports: map[uint32]func(net.Conn){
			GuestPort: func(c net.Conn) { time.Sleep(time.Second); _ = c.Close() },
		}})
		if _, err := Dial(context.Background(), uds, GuestPort); err == nil || errors.Is(err, ErrNotListening) {
			t.Fatalf("ack %q: %v", ack, err)
		}
	}
}

// Bytes the guest sends right behind the acknowledgement belong to the
// stream: the handshake does not swallow them.
func TestBytesRightAfterTheAcknowledgementReachTheCaller(t *testing.T) {
	uds := startFirecracker(t, &firecracker{ack: "OK 7\nfirst frame", ports: map[uint32]func(net.Conn){
		GuestPort: func(c net.Conn) { time.Sleep(time.Second); _ = c.Close() },
	}})
	conn, err := Dial(context.Background(), uds, GuestPort)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	got := make([]byte, len("first frame"))
	if _, err := io.ReadFull(conn, got); err != nil || string(got) != "first frame" {
		t.Fatalf("read %q %v", got, err)
	}
}
