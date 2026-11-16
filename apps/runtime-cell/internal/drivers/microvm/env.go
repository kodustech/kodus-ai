package microvm

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/composecmd"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// An environment's system runs inside its own microVM (docs/runtime/isolation-p3-snapshots.md,
// "Environments in a microVM"): the VM's own dockerd, on its data disk,
// builds the project with its stock BuildKit and runs its compose project
// under runc. The cell drives it only through the guest agent (root in an
// environment VM): it uploads the checkout, writes the compose file and
// runs docker compose in the VM. No Docker API leaves the VM, and nothing
// the project does reaches the host but through the VM's tap.

// uploadChunk is what one write op carries (protocol.SandboxFileChunkBytes).
const uploadChunk = 512 << 10

// execGrace is how much longer than a command's own timeout the cell waits
// for the guest agent.
const execGrace = 15 * time.Second

// guestWait bounds how long a machine's guest agent may take to answer
// its first stat: a VM just made boots for about a second first.
const guestWait = 30 * time.Second

// guestOf opens a client to the environment machine's guest agent once it
// answers (a machine Create just returned may still be booting).
func (d *Driver) guestOf(ctx context.Context, ref driver.MachineRef) (*guest.Client, error) {
	deadline := time.Now().Add(guestWait)
	for {
		c, err := d.answeringGuest(ctx, ref)
		if err == nil || ctx.Err() != nil || time.Now().After(deadline) {
			return c, err
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func (d *Driver) answeringGuest(ctx context.Context, ref driver.MachineRef) (*guest.Client, error) {
	rw, err := d.DialGuest(ctx, ref)
	if err != nil {
		return nil, err
	}
	c := guest.NewClient(rw, d.cfg.CellID, ref.Tags[driver.TagClaim])
	sctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if r, err := c.Do(sctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindStat}); err != nil || !r.Ok {
		_ = c.Close()
		return nil, errors.Join(err, fmt.Errorf("microvm: the guest agent of %s does not answer yet", ref.MachineID))
	}
	return c, nil
}

// Exec runs req in the environment machine through its guest agent (the
// Transport of a microvm cell): a shell command under the workspace, with
// the guest agent's bounds on its output.
func (d *Driver) Exec(ctx context.Context, ref driver.MachineRef, req kodyexec.Request) (kodyexec.Result, error) {
	if _, ok, err := d.find(ctx, ref.MachineID); err != nil || !ok {
		return kodyexec.Result{}, errors.Join(err, notFound(ok, ref))
	}
	op, err := execOp(req)
	if err != nil {
		return kodyexec.Result{}, err
	}
	c, err := d.guestOf(ctx, ref)
	if err != nil {
		return kodyexec.Result{}, err
	}
	defer func() { _ = c.Close() }()
	ctx, cancel := context.WithTimeout(ctx, time.Duration(*op.TimeoutMs)*time.Millisecond+execGrace)
	defer cancel()
	r, err := c.Do(ctx, guest.NewID(), op)
	if err != nil {
		return kodyexec.Result{}, err
	}
	if !r.Ok || r.Exec == nil {
		return kodyexec.Result{}, fmt.Errorf("microvm: exec in %s: %s", ref.MachineID, opError(r))
	}
	e := r.Exec
	return kodyexec.Result{ExitCode: int(e.ExitCode), Stdout: e.Stdout, Stderr: e.Stderr, Truncated: e.Truncated, DurationMs: e.DurationMs, TimedOut: e.TimedOut}, nil
}

// execOp is req as the guest agent's exec op: its cwd relative to the
// workspace (never out of it), its timeout within the protocol's bound,
// its env as a map.
func execOp(req kodyexec.Request) (protocol.SandboxOp, error) {
	timeout := req.TimeoutMs
	if timeout <= 0 || timeout > 600_000 {
		return protocol.SandboxOp{}, fmt.Errorf("microvm: a %d ms command (1 to 600000)", timeout)
	}
	cmd := req.Command
	op := protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &cmd, TimeoutMs: &timeout}
	if cwd := strings.TrimPrefix(path.Clean("/"+req.Cwd), "/"); cwd != "" {
		op.Cwd = &cwd
	}
	if len(req.Env) > 0 {
		op.Env = map[string]string{}
		for _, kv := range req.Env {
			k, v, ok := strings.Cut(kv, "=")
			if !ok {
				return protocol.SandboxOp{}, fmt.Errorf("microvm: env %q", k)
			}
			op.Env[k] = v
		}
	}
	if err := protocol.CheckSandboxOp(op); err != nil {
		return protocol.SandboxOp{}, fmt.Errorf("microvm: %w", err)
	}
	return op, nil
}

func opError(r protocol.SandboxResult) string {
	if r.Error != nil {
		return string(r.Error.Code) + ": " + r.Error.Message
	}
	return "no result"
}

// Upload copies the local directory srcDir to dst under the workspace of
// the environment machine: one tar archive written in chunks through the
// guest agent, then unpacked there. The directory's entries keep their
// modes; a link is copied as a link (inside the VM, which is the boundary).
func (d *Driver) Upload(ctx context.Context, ref driver.MachineRef, srcDir, dst string, _ func(string)) error {
	if _, ok, err := d.find(ctx, ref.MachineID); err != nil || !ok {
		return errors.Join(err, notFound(ok, ref))
	}
	rel := strings.TrimPrefix(path.Clean("/"+dst), "/")
	if rel == "" {
		return errors.New("microvm: an upload names its directory under the workspace")
	}
	archive, err := tarDir(srcDir)
	if err != nil {
		return err
	}
	c, err := d.guestOf(ctx, ref)
	if err != nil {
		return err
	}
	defer func() { _ = c.Close() }()
	staged := ".kody-upload/" + strings.ReplaceAll(rel, "/", "_") + ".tar"
	for off := 0; off < len(archive) || off == 0; off += uploadChunk {
		end := min(off+uploadChunk, len(archive))
		content := base64.StdEncoding.EncodeToString(archive[off:end])
		op := protocol.SandboxOp{Op: protocol.SandboxOpKindWrite, Path: &staged, Content: &content, Mkdirs: ptr(true), Append: ptr(off > 0)}
		r, err := c.Do(ctx, guest.NewID(), op)
		if err != nil {
			return err
		}
		if !r.Ok {
			return fmt.Errorf("microvm: upload to %s: %s", ref.MachineID, opError(r))
		}
		if end == len(archive) {
			break
		}
	}
	cmd := "set -e; mkdir -p " + composecmd.ShellQuote(rel) + "; tar -xf " + composecmd.ShellQuote(staged) + " -C " + composecmd.ShellQuote(rel) + "; rm -f " + composecmd.ShellQuote(staged)
	timeout := int64(300_000)
	r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &cmd, TimeoutMs: &timeout})
	if err != nil {
		return err
	}
	if !r.Ok || r.Exec == nil || r.Exec.ExitCode != 0 {
		return fmt.Errorf("microvm: unpack in %s: %s %s", ref.MachineID, opError(r), stderrOf(r))
	}
	d.mu.Lock()
	d.uploads[ref.MachineID] = upload{host: srcDir, guest: rel}
	d.mu.Unlock()
	return nil
}

func stderrOf(r protocol.SandboxResult) string {
	if r.Exec == nil {
		return ""
	}
	s := r.Exec.Stderr
	if len(s) > 500 {
		s = s[len(s)-500:]
	}
	return s
}

func ptr[T any](v T) *T { return &v }

// tarDir is the directory as a tar archive, paths relative to it.
func tarDir(dir string) ([]byte, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	err := filepath.WalkDir(dir, func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil || rel == "." {
			return err
		}
		info, err := e.Info()
		if err != nil {
			return err
		}
		link := ""
		if info.Mode()&fs.ModeSymlink != 0 {
			if link, err = os.Readlink(p); err != nil {
				return err
			}
		}
		h, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		h.Name, h.Uid, h.Gid, h.Uname, h.Gname = filepath.ToSlash(rel), 0, 0, "", ""
		if e.IsDir() {
			h.Name += "/"
		}
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		f, err := os.Open(p) //nolint:gosec // G304: a file the walk found under the cell's own checkout
		if err != nil {
			return err
		}
		defer func() { _ = f.Close() }()
		_, err = io.Copy(tw, f)
		return err
	})
	if err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// upload is where a machine's checkout went: its host directory and its
// directory under the workspace.
type upload struct{ host, guest string }

// guestDir is the machine's directory of the host directory dir, which must
// be under its last upload.
func (d *Driver) guestDir(machine, dir string) (string, error) {
	d.mu.Lock()
	u, ok := d.uploads[machine]
	d.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("microvm: machine %s has no upload", machine)
	}
	rel, err := filepath.Rel(u.host, dir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", fmt.Errorf("microvm: %s is not under machine %s's upload", dir, machine)
	}
	return path.Join(u.guest, filepath.ToSlash(rel)), nil
}

// composeFileName is the cell's compose file in the project directory.
const composeFileName = ".kodus-compose.yml"

// upTimeout bounds one compose up with its build (the guest agent's most).
const upTimeout = 600_000

// ComposeUpCommand is what Up runs in the VM: the project built by the VM's
// dockerd and brought up under the claim's project name, waiting for its
// healthchecks.
func ComposeUpCommand(project string) string {
	return composecmd.DockerLine(composecmd.Project{Name: project, File: composeFileName}.UpBuild(540))
}

// Up brings the claim's compose project up in its environment VM: the
// cell's compose file written into the uploaded project directory, then
// compose's build and up there. The machine's one address is the claim's
// egress source: everything the project sends leaves through the VM's tap.
//
// The compose file's host paths resolve in the VM, inside the uploaded
// workspace, never on the cell host: the VM is the boundary, so the
// workspace root bounds only where the project directory may be.
func (d *Driver) Up(ctx context.Context, req driver.UpRequest) ([]string, error) {
	ref, composeFile, projectDir := req.Ref, req.Compose, req.ProjectDir
	if req.WorkspaceRoot != "" {
		if _, err := sandbox.ResolveWithin(req.WorkspaceRoot, projectDir, "."); err != nil {
			return nil, fmt.Errorf("microvm: project %s outside its workspace: %w", projectDir, err)
		}
	}
	dir, err := d.guestDir(ref.MachineID, projectDir)
	if err != nil {
		return nil, err
	}
	c, err := d.guestOf(ctx, ref)
	if err != nil {
		return nil, err
	}
	defer func() { _ = c.Close() }()
	files, err := d.filesFor(req)
	if err != nil {
		return nil, err
	}
	// A machine holding a Run's canaries never becomes a snapshot other
	// than its claim's own round (vmsnap.Admit, S-28): recorded before the
	// first one is written into it.
	if _, ok := files.files["npmrc"]; ok {
		if err := d.cfg.Backend.Taint(ctx, ref.MachineID, isolation.TaintCanaries); err != nil {
			return nil, fmt.Errorf("microvm: taint %s: %w", ref.MachineID, err)
		}
	}
	// S-28 (c): a machine whose builds are handed the org's secrets never
	// becomes a template or a session snapshot, whatever its spec said:
	// recorded before compose builds anything in it.
	if len(req.BuildSecrets) > 0 {
		if err := d.cfg.Backend.Taint(ctx, ref.MachineID, isolation.TaintSecrets); err != nil {
			return nil, fmt.Errorf("microvm: taint %s: %w", ref.MachineID, err)
		}
	}
	pinned, err := renderForVM(composeFile, files)
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	d.initdb[ref.MachineID] = initdbBinds(composeFile)
	d.mu.Unlock()
	for name, raw := range files.files {
		p, content := path.Join(dir, cellFilesDir, name), base64.StdEncoding.EncodeToString(raw)
		mode := int64(0o644)
		if r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindWrite, Path: &p, Content: &content, Mkdirs: ptr(true), Mode: &mode}); err != nil || !r.Ok {
			return nil, errors.Join(err, fmt.Errorf("microvm: %s into %s: %s", name, ref.MachineID, opError(r)))
		}
	}
	file := path.Join(dir, composeFileName)
	content := base64.StdEncoding.EncodeToString(pinned)
	if r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindWrite, Path: &file, Content: &content}); err != nil || !r.Ok {
		return nil, errors.Join(err, fmt.Errorf("microvm: compose file in %s: %s", ref.MachineID, opError(r)))
	}
	r, err := d.Exec(ctx, ref, kodyexec.Request{Command: ComposeUpCommand(projectName(ref)), Cwd: dir, TimeoutMs: upTimeout})
	if err != nil {
		return nil, err
	}
	// The guest agent answers once compose ends: its lines reach the
	// boot's output then, not as they print.
	emitLines(req.Output, r.Stderr, r.Stdout)
	if r.ExitCode != 0 {
		tail := r.Stderr
		if len(tail) > 2000 {
			tail = tail[len(tail)-2000:]
		}
		return nil, d.diskFull(ctx, ref, fmt.Errorf("%w: compose up in %s exited %d: %s", driver.ErrWorkloadBoot, ref.MachineID, r.ExitCode, tail))
	}
	if ref.PrivateAddress == "" {
		return nil, nil
	}
	return []string{ref.PrivateAddress}, nil
}
