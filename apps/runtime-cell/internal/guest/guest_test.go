//go:build unix

package guest

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/telemetry"
)

// A sandbox root with a secret next to it (outside the root) and the links
// a repository could commit to reach it.
func sandbox(t *testing.T) (*FS, string, string) {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "workspace")
	outside := filepath.Join(base, "secret")
	must(t, os.MkdirAll(filepath.Join(root, "repo", "src"), 0o755))
	must(t, os.MkdirAll(outside, 0o755))
	must(t, os.WriteFile(filepath.Join(outside, "token"), []byte("s3cr3t"), 0o600))
	must(t, os.WriteFile(filepath.Join(root, "repo", "src", "a.ts"), []byte("export const a = 1;\n"), 0o644))
	must(t, os.Symlink(filepath.Join(outside, "token"), filepath.Join(root, "repo", "token-link")))
	must(t, os.Symlink(outside, filepath.Join(root, "repo", "dir-link")))
	fs, err := OpenRoot(root)
	must(t, err)
	t.Cleanup(func() { _ = fs.Close() })
	return fs, root, outside
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func ptr[T any](v T) *T { return &v }

func code(t *testing.T, r protocol.SandboxResult) protocol.SandboxErrorCode {
	t.Helper()
	if r.Ok || r.Error == nil {
		t.Fatalf("expected a refusal, got %+v", r)
	}
	return r.Error.Code
}

func TestAReadNeverFollowsASymlinkOutOfTheRoot(t *testing.T) {
	fs, _, _ := sandbox(t)
	for _, p := range []string{"repo/token-link", "repo/dir-link/token"} {
		r := Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindRead, Path: ptr(p)})
		if c := code(t, r); c != protocol.SandboxErrorCodeSymlink {
			t.Fatalf("%s: code %s, want symlink", p, c)
		}
	}
}

// gVisor's openat follows a link to a directory even with
// O_DIRECTORY|O_NOFOLLOW. With an open that does the same, no read, write or
// list goes through a directory link.
func TestADirectoryLinkIsRefusedWhereTheOpenFollowsIt(t *testing.T) {
	following := openatDir
	openatDir = func(dir int, name string) (int, error) {
		return unix.Openat(dir, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	}
	t.Cleanup(func() { openatDir = following })
	fs, _, outside := sandbox(t)
	r := Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindRead, Path: ptr("repo/dir-link/token")})
	if c := code(t, r); c != protocol.SandboxErrorCodeSymlink {
		t.Fatalf("read: code %s, want symlink", c)
	}
	content := base64.StdEncoding.EncodeToString([]byte("pwned"))
	r = Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindWrite, Path: ptr("repo/dir-link/new"), Content: &content, Mkdirs: ptr(true)})
	if c := code(t, r); c != protocol.SandboxErrorCodeSymlink {
		t.Fatalf("write: code %s, want symlink", c)
	}
	if _, err := os.Stat(filepath.Join(outside, "new")); err == nil {
		t.Fatal("a file was written outside the root")
	}
	r = Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindStat, Path: ptr("repo/dir-link/token")})
	if r.Ok {
		t.Fatalf("stat through the link answered: %+v", r)
	}
	if r := Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindRead, Path: ptr("repo/src/a.ts")}); !r.Ok {
		t.Fatalf("a plain file below real directories does not read: %+v", r.Error)
	}
}

// Should the open of a file follow a final link despite O_NOFOLLOW, as
// gVisor's open of a directory does, a read or a write of a link leaf still
// never goes through it: what was opened is checked against the entry.
func TestALeafLinkIsRefusedWhereTheOpenFollowsIt(t *testing.T) {
	following := openatLeaf
	openatLeaf = func(dir int, name string, flags int, mode uint32) (int, error) {
		return unix.Openat(dir, name, flags&^unix.O_NOFOLLOW, mode)
	}
	t.Cleanup(func() { openatLeaf = following })
	fs, _, outside := sandbox(t)
	r := Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindRead, Path: ptr("repo/token-link")})
	if c := code(t, r); c != protocol.SandboxErrorCodeSymlink {
		t.Fatalf("read: code %s, want symlink", c)
	}
	content := base64.StdEncoding.EncodeToString([]byte("pwned"))
	r = Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindWrite, Path: ptr("repo/token-link"), Content: &content, Append: ptr(true)})
	if c := code(t, r); c != protocol.SandboxErrorCodeSymlink {
		t.Fatalf("write: code %s, want symlink", c)
	}
	if b, _ := os.ReadFile(filepath.Join(outside, "token")); string(b) != "s3cr3t" {
		t.Fatalf("the file outside the root changed: %q", b)
	}
	if r := Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindRead, Path: ptr("repo/src/a.ts")}); !r.Ok {
		t.Fatalf("a plain file does not read: %+v", r.Error)
	}
}

// N9: where the open follows a final link, a write with O_CREAT to a
// dangling link made an empty file at its target, outside the root, before
// the check refused it. Nothing is created through a link; a new file of
// the root is still made.
func TestAWriteToADanglingLinkCreatesNothingWhereTheOpenFollowsIt(t *testing.T) {
	following := openatLeaf
	openatLeaf = func(dir int, name string, flags int, mode uint32) (int, error) {
		return unix.Openat(dir, name, flags&^unix.O_NOFOLLOW, mode)
	}
	t.Cleanup(func() { openatLeaf = following })
	fs, root, outside := sandbox(t)
	must(t, os.Symlink(filepath.Join(outside, "planted"), filepath.Join(root, "repo", "dangling")))
	content := base64.StdEncoding.EncodeToString([]byte("pwned"))
	r := Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindWrite, Path: ptr("repo/dangling"), Content: &content})
	if c := code(t, r); c != protocol.SandboxErrorCodeSymlink {
		t.Fatalf("write: code %s, want symlink", c)
	}
	if _, err := os.Lstat(filepath.Join(outside, "planted")); err == nil {
		t.Fatal("a file was created outside the root through a dangling link")
	}
	r = Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindWrite, Path: ptr("repo/src/new.ts"), Content: &content, Mode: ptr(int64(0o600))})
	if !r.Ok {
		t.Fatalf("a new file: %+v", r.Error)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "repo", "src", "new.ts")); string(b) != "pwned" {
		t.Fatalf("the new file holds %q", b)
	}
}

func TestAWriteNeverGoesThroughASymlink(t *testing.T) {
	fs, _, outside := sandbox(t)
	content := base64.StdEncoding.EncodeToString([]byte("pwned"))
	for _, p := range []string{"repo/token-link", "repo/dir-link/token", "repo/dir-link/new/file"} {
		r := Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindWrite, Path: ptr(p), Content: &content, Mkdirs: ptr(true)})
		if c := code(t, r); c != protocol.SandboxErrorCodeSymlink {
			t.Fatalf("%s: code %s, want symlink", p, c)
		}
	}
	got, _ := os.ReadFile(filepath.Join(outside, "token"))
	if string(got) != "s3cr3t" {
		t.Fatalf("the file outside the root changed: %q", got)
	}
	if _, err := os.Stat(filepath.Join(outside, "new")); err == nil {
		t.Fatal("a directory was made outside the root")
	}
}

func TestARemoveTakesTheLinkNotItsTarget(t *testing.T) {
	fs, root, outside := sandbox(t)
	r := Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindRemove, Path: ptr("repo/token-link")})
	if !r.Ok {
		t.Fatalf("remove: %+v", r.Error)
	}
	if _, err := os.Lstat(filepath.Join(root, "repo", "token-link")); !os.IsNotExist(err) {
		t.Fatal("the link is still there")
	}
	if _, err := os.Stat(filepath.Join(outside, "token")); err != nil {
		t.Fatal("the target was removed")
	}
	if c := code(t, Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindRemove, Path: ptr("repo/src")})); c != protocol.SandboxErrorCodeIsDirectory {
		t.Fatalf("remove of a directory: %s", c)
	}
}

func TestAListShowsALinkWithoutEnteringIt(t *testing.T) {
	fs, _, _ := sandbox(t)
	r := Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindList, Path: ptr("repo"), Depth: ptr(int64(4))})
	if !r.Ok {
		t.Fatalf("list: %+v", r.Error)
	}
	got := map[string]protocol.SandboxEntryType{}
	for _, e := range r.Entries {
		got[e.Path] = e.Type
	}
	want := map[string]protocol.SandboxEntryType{"dir-link": "symlink", "src": "dir", "src/a.ts": "file", "token-link": "symlink"}
	if len(got) != len(want) {
		t.Fatalf("entries %v, want %v", got, want)
	}
	for p, ty := range want {
		if got[p] != ty {
			t.Fatalf("entries %v, want %v", got, want)
		}
	}
}

func TestAListStopsAtMaxEntriesAndSaysSo(t *testing.T) {
	fs, root, _ := sandbox(t)
	for i := range 30 {
		must(t, os.WriteFile(filepath.Join(root, "repo", "src", "f"+strings.Repeat("x", i)), nil, 0o644))
	}
	r := Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindList, Depth: ptr(int64(3)), MaxEntries: ptr(int64(10))})
	if !r.Ok || len(r.Entries) != 10 || r.Truncated == nil || !*r.Truncated {
		t.Fatalf("entries %d truncated %v", len(r.Entries), r.Truncated)
	}
}

func TestALargeFileIsReadInBoundedChunks(t *testing.T) {
	fs, root, _ := sandbox(t)
	data := []byte(strings.Repeat("0123456789", 100_000)) // 1 MB
	must(t, os.WriteFile(filepath.Join(root, "repo", "big"), data, 0o644))
	var got []byte
	for off := int64(0); ; {
		r := Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindRead, Path: ptr("repo/big"), Offset: &off})
		if !r.Ok {
			t.Fatalf("read: %+v", r.Error)
		}
		chunk, _ := base64.StdEncoding.DecodeString(*r.Content)
		if len(chunk) > protocol.SandboxFileChunkBytes || *r.Size != int64(len(data)) {
			t.Fatalf("chunk %d size %d", len(chunk), *r.Size)
		}
		got = append(got, chunk...)
		off += int64(len(chunk))
		if *r.Eof {
			break
		}
	}
	if !bytes.Equal(got, data) {
		t.Fatal("the chunks do not make the file")
	}
}

func TestAFifoIsNeitherReadNorWaitedOn(t *testing.T) {
	fs, root, _ := sandbox(t)
	must(t, syscall.Mkfifo(filepath.Join(root, "repo", "pipe"), 0o644))
	done := make(chan protocol.SandboxResult, 1)
	go func() {
		done <- Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindRead, Path: ptr("repo/pipe")})
	}()
	select {
	case r := <-done:
		if c := code(t, r); c != protocol.SandboxErrorCodeNotRegular {
			t.Fatalf("code %s", c)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the read blocked on a fifo")
	}
}

func runCmd(t *testing.T, fs *FS, cmd string, timeoutMs int64, env map[string]string) protocol.SandboxResult {
	t.Helper()
	r := Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &cmd, TimeoutMs: &timeoutMs, Env: env, Cwd: ptr("repo")})
	if !r.Ok || r.Exec == nil {
		t.Fatalf("exec: %+v", r.Error)
	}
	return r
}

func TestACommandRunsInItsDirectoryAndReportsItsExit(t *testing.T) {
	fs, root, _ := sandbox(t)
	r := runCmd(t, fs, "pwd; echo err >&2; exit 3", 10_000, nil)
	resolved, _ := filepath.EvalSymlinks(filepath.Join(root, "repo"))
	if r.Exec.ExitCode != 3 || strings.TrimSpace(r.Exec.Stderr) != "err" {
		t.Fatalf("%+v", r.Exec)
	}
	if out := strings.TrimSpace(r.Exec.Stdout); out != filepath.Join(root, "repo") && out != resolved {
		t.Fatalf("ran in %q", out)
	}
}

func TestACommandPastItsTimeoutIsKilledWithItsChildren(t *testing.T) {
	fs, root, _ := sandbox(t)
	marker := filepath.Join(root, "late")
	start := time.Now()
	r := runCmd(t, fs, "(sleep 2; touch "+marker+") & sleep 30", 300, nil)
	if !r.Exec.TimedOut || time.Since(start) > 5*time.Second {
		t.Fatalf("timedOut %v after %s", r.Exec.TimedOut, time.Since(start))
	}
	time.Sleep(2500 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a child of the command outlived its timeout")
	}
}

func TestEnvValuesNeverComeBackInTheOutput(t *testing.T) {
	fs, _, _ := sandbox(t)
	header := "Authorization: Basic not-a-real-token"
	r := runCmd(t, fs, `echo "$GIT_AUTH_HEADER"; echo "$GIT_AUTH_HEADER" >&2`, 10_000, map[string]string{"GIT_AUTH_HEADER": header})
	if strings.Contains(r.Exec.Stdout+r.Exec.Stderr, header) {
		t.Fatalf("the env value came back: %+v", r.Exec)
	}
}

func TestOutputPastTheCapIsCutAndMarked(t *testing.T) {
	fs, _, _ := sandbox(t)
	r := runCmd(t, fs, "head -c 400000 /dev/zero | tr '\\0' a", 10_000, nil)
	if len(r.Exec.Stdout) != protocol.SandboxExecStdoutBytes || !r.Exec.Truncated {
		t.Fatalf("stdout %d truncated %v", len(r.Exec.Stdout), r.Exec.Truncated)
	}
}

func TestACwdThroughASymlinkIsRefused(t *testing.T) {
	fs, _, _ := sandbox(t)
	cmd, ms := "pwd", int64(1000)
	r := Run(context.Background(), fs, protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &cmd, TimeoutMs: &ms, Cwd: ptr("repo/dir-link")})
	if c := code(t, r); c != protocol.SandboxErrorCodeSymlink && c != protocol.SandboxErrorCodeNotDirectory {
		t.Fatalf("code %s", c)
	}
}

// The stream: a client and the server over a socket pair, as the cell and
// the guest agent are.
func stream(t *testing.T, fs *FS) *Client {
	t.Helper()
	a, b := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = Serve(ctx, b, b, fs); _ = b.Close() }()
	c := NewClient(a, "cell-1", "claim-1")
	t.Cleanup(func() { cancel(); _ = c.Close() })
	return c
}

func TestOpsTravelTheStreamConcurrently(t *testing.T) {
	fs, _, _ := sandbox(t)
	c := stream(t, fs)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	slow, fast := "sleep 1; echo slow", "echo fast"
	ms := int64(5000)
	got := make(chan string, 2)
	for _, cmd := range []string{slow, fast} {
		go func() {
			r, err := c.Do(ctx, NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &cmd, TimeoutMs: &ms})
			if err != nil || !r.Ok {
				got <- "error"
				return
			}
			got <- strings.TrimSpace(r.Exec.Stdout)
		}()
	}
	if first := <-got; first != "fast" {
		t.Fatalf("first answer %q: ops did not run side by side", first)
	}
	if second := <-got; second != "slow" {
		t.Fatalf("second answer %q", second)
	}
	r, err := c.Do(ctx, NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindRead, Path: ptr("repo/token-link")})
	if err != nil || r.Ok || r.Error.Code != protocol.SandboxErrorCodeSymlink {
		t.Fatalf("read over the stream: %+v %v", r, err)
	}
}

func TestAFrameOverTheLimitEndsTheStream(t *testing.T) {
	fs, _, _ := sandbox(t)
	a, b := net.Pipe()
	errc := make(chan error, 1)
	go func() { errc <- Serve(context.Background(), b, b, fs) }()
	go func() { _, _ = a.Write([]byte{0x7f, 0xff, 0xff, 0xff}) }()
	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("served on")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the stream stayed open")
	}
	_ = a.Close()
}

func TestAClosedStreamFailsTheCallsInFlight(t *testing.T) {
	fs, _, _ := sandbox(t)
	c := stream(t, fs)
	cmd, ms := "sleep 5", int64(10_000)
	errc := make(chan error, 1)
	go func() {
		_, err := c.Do(context.Background(), NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &cmd, TimeoutMs: &ms})
		errc <- err
	}()
	time.Sleep(100 * time.Millisecond)
	_ = c.Close()
	if err := <-errc; !errors.Is(err, ErrClosed) {
		t.Fatalf("err %v", err)
	}
	var _ io.Closer = c
}

// The step's trace goes on to the guest agent, which answers the op as any
// other: a frame with a traceparent is one the guest's decoder takes.
func TestTheGuestAgentTakesTheStepsTraceparent(t *testing.T) {
	fs, _, _ := sandbox(t)
	c := stream(t, fs)
	c.TraceContext = true
	parent := "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	ctx, cancel := context.WithTimeout(telemetry.Remote(context.Background(), &parent), 10*time.Second)
	defer cancel()
	r, err := c.Do(ctx, NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindStat})
	if err != nil || !r.Ok {
		t.Fatalf("stat with a traceparent: %+v %v", r, err)
	}
}
