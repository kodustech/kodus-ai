//go:build dockersmoke

package dockercli

import (
	"context"
	"encoding/base64"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// The sandbox container and its guest agent against the host's Docker, with
// the tool image (apps/runtime-cell/sandbox-image):
//
//	docker buildx build --load -t kodus-sandbox:dev -f apps/runtime-cell/sandbox-image/Dockerfile apps/runtime-cell
//	KGR_SANDBOX_IMAGE=kodus-sandbox:dev [KGR_SANDBOX_RUNTIME=runc] go test -tags dockersmoke -run TestSmokeSandbox -v ./internal/dockercli/
//
// runsc on a cell; runc where the host has no gVisor (a laptop), which proves
// the container's lockdown and the guest agent, not the gVisor boundary.
func TestSmokeSandbox(t *testing.T) {
	image := os.Getenv("KGR_SANDBOX_IMAGE")
	if image == "" {
		t.Skip("KGR_SANDBOX_IMAGE not set")
	}
	runtime := os.Getenv("KGR_SANDBOX_RUNTIME")
	if runtime == "" {
		runtime = "runsc"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cli := CLI{}
	name := "kgr-sandbox-smoke-" + strings.ReplaceAll(guest.NewID()[:8], "-", "")
	start := time.Now()
	c, err := cli.RunSandbox(ctx, SandboxSpec{
		HolderSpec: HolderSpec{Name: name, Image: image, Network: "none", Runtime: runtime, Labels: map[string]string{"kodus.smoke": "1"}},
		User:       "1000:1000", Memory: "1g", CPUs: "1", WorkspaceSize: "64m", TmpSize: "64m",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cli.Remove(context.Background(), name) })
	rw, err := cli.ExecStream(ctx, c.ID, "1000:1000", "/usr/local/bin/kody-guest", "-stdio", "-root", "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	g := guest.NewClient(rw, "cell-smoke", "claim-smoke")
	do := func(op protocol.SandboxOp) protocol.SandboxResult {
		t.Helper()
		r, err := g.Do(ctx, guest.NewID(), op)
		if err != nil {
			t.Fatalf("%s: %v", op.Op, err)
		}
		return r
	}
	sh := func(cmd string) *protocol.SandboxExecResult {
		t.Helper()
		ms := int64(30_000)
		r := do(protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &cmd, TimeoutMs: &ms})
		if !r.Ok {
			t.Fatalf("exec %q: %+v", cmd, r.Error)
		}
		return r.Exec
	}
	if r := do(protocol.SandboxOp{Op: protocol.SandboxOpKindStat}); !r.Ok {
		t.Fatalf("the guest agent does not answer: %+v", r.Error)
	}
	t.Logf("sandbox ready (container and guest agent's first answer) in %s", time.Since(start))

	t.Run("commands run as the unprivileged user with the review's tools", func(t *testing.T) {
		if out := sh("id -u; git --version; rg --version | head -1; node --version; python3 --version; ast-grep --version").Stdout; !strings.HasPrefix(out, "1000\n") || strings.Count(out, "\n") < 6 {
			t.Fatalf("%q", out)
		}
	})
	t.Run("there is no way to become root", func(t *testing.T) {
		if e := sh("find / -xdev -type f -perm /6000 2>/dev/null | head -1; grep NoNewPrivs /proc/self/status"); e.Stdout != "NoNewPrivs:\t1\n" {
			t.Fatalf("%q", e.Stdout)
		}
	})
	t.Run("the root file system is read-only", func(t *testing.T) {
		if e := sh("touch /usr/local/bin/x"); e.ExitCode == 0 {
			t.Fatal("wrote to the image")
		}
	})
	t.Run("a file read never follows a symlink out of /workspace", func(t *testing.T) {
		sh("mkdir -p /workspace/repo && ln -s /etc/passwd /workspace/repo/passwd && ln -s /etc /workspace/repo/etc")
		for _, p := range []string{"repo/passwd", "repo/etc/passwd"} {
			r := do(protocol.SandboxOp{Op: protocol.SandboxOpKindRead, Path: &p})
			if r.Ok || r.Error.Code != protocol.SandboxErrorCodeSymlink {
				t.Fatalf("%s: %+v", p, r)
			}
		}
		content := base64.StdEncoding.EncodeToString([]byte("x"))
		p := "repo/etc/hostname"
		if r := do(protocol.SandboxOp{Op: protocol.SandboxOpKindWrite, Path: &p, Content: &content}); r.Ok {
			t.Fatal("wrote through a symlinked directory")
		}
	})
	t.Run("what the commands write is bounded by /workspace's size", func(t *testing.T) {
		if e := sh("head -c 100000000 /dev/zero > /workspace/big"); e.ExitCode == 0 {
			t.Fatal("wrote 100 MB into a 64 MB workspace")
		}
	})
	t.Run("with no network there is no way out", func(t *testing.T) {
		if e := sh("git ls-remote https://github.com/git/git HEAD"); e.ExitCode == 0 {
			t.Fatal("reached github.com")
		}
	})
	t.Run("a removed sandbox's stream ends", func(t *testing.T) {
		if err := cli.Remove(ctx, name); err != nil {
			t.Fatal(err)
		}
		select {
		case <-g.Done():
		case <-time.After(30 * time.Second):
			t.Fatal("the guest agent's stream outlived its container")
		}
		if _, err := g.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindStat}); err == nil {
			t.Fatal("an op reached a removed sandbox")
		}
	})
}
