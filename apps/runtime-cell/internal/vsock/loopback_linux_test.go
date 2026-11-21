//go:build linux

package vsock

import (
	"context"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// The guest side listens on a real AF_VSOCK port and serves the guest
// agent's frames there, reached over the kernel's vsock loopback (CID 1)
// instead of a VM. Needs vsock_loopback (Linux 5.6+):
//
//	KODY_E2E_VSOCK_LOOPBACK=1 go test -run TestTheGuestListenerServesOnARealVsockPort ./internal/vsock/
func TestTheGuestListenerServesOnARealVsockPort(t *testing.T) {
	if os.Getenv("KODY_E2E_VSOCK_LOOPBACK") != "1" {
		t.Skip("KODY_E2E_VSOCK_LOOPBACK=1 on a Linux kernel with vsock_loopback")
	}
	const port = 52011
	l, err := Listen(port)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	root := t.TempDir()
	fs, err := guest.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer fs.Close()
	go func() {
		c, err := l.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_ = guest.Serve(context.Background(), c, c, fs)
	}()
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.Connect(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_LOCAL, Port: port}); err != nil {
		t.Fatalf("connect over the vsock loopback: %v", err)
	}
	conn := os.NewFile(uintptr(fd), "vsock-client")
	c := guest.NewClient(conn, "cell-1", "claim-1")
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := "echo over-vsock"
	timeout := int64(5000)
	r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &cmd, TimeoutMs: &timeout})
	if err != nil || r.Exec == nil || r.Exec.Stdout != "over-vsock\n" {
		t.Fatalf("exec over vsock: %+v %v", r, err)
	}
}
