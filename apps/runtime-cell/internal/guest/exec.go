//go:build unix

package guest

import (
	"bytes"
	"context"
	"errors"
	"maps"
	"os/exec"
	"path"
	"slices"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// BaseEnv is what every command starts with: the image's tools, a home in
// /tmp (the root file system is read-only), nothing of the guest agent's own.
var BaseEnv = []string{
	"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	"HOME=/tmp",
	"LANG=C.UTF-8",
	"GIT_TERMINAL_PROMPT=0",
}

// maskMin is the shortest env value masked out of a command's output: the
// caller's credentials (a git auth header) never come back in a result.
const maskMin = 8

// capped keeps the first max bytes written and counts the rest.
// killGrace is how long past the WaitDelay a killed command may take to
// exit before its op answers timed out without it.
const killGrace = 3 * time.Second

type capped struct {
	mu      sync.Mutex
	buf     bytes.Buffer
	max     int
	dropped int
}

// taken is what was written so far and how much was dropped.
func (c *capped) taken() ([]byte, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return bytes.Clone(c.buf.Bytes()), c.dropped
}

func (c *capped) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	room := c.max - c.buf.Len()
	if room > 0 {
		if len(p) <= room {
			c.buf.Write(p)
		} else {
			c.buf.Write(p[:room])
			c.dropped += len(p) - room
		}
	} else {
		c.dropped += len(p)
	}
	return len(p), nil
}

// clean is out as valid UTF-8 with the secrets masked, at most max bytes,
// cut on a rune boundary.
func clean(out []byte, secrets []string, limit int) (string, bool) {
	s := strings.ToValidUTF8(string(out), "�")
	for _, v := range secrets {
		s = strings.ReplaceAll(s, v, "[redacted:env]")
	}
	if len(s) <= limit {
		return s, false
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut], true
}

// Exec runs command under /bin/sh in cwd (below the root, reached without a
// symlink), with env on top of BaseEnv, for at most timeout. The command and
// everything it starts are killed at the deadline (their process group).
func (f *FS) Exec(ctx context.Context, command, cwd string, env map[string]string, timeout time.Duration) (protocol.SandboxResult, error) {
	dir := f.dir
	if cwd != "" {
		parts, err := segments(cwd)
		if err != nil {
			return protocol.SandboxResult{}, err
		}
		fd, err := f.walk(parts, false, cwd)
		if err != nil {
			return protocol.SandboxResult{}, err
		}
		_ = syscall.Close(fd)
		dir = path.Join(f.dir, cwd)
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	vars := append([]string{}, BaseEnv...)
	if f.path != "" {
		vars[0] = "PATH=" + f.path
	}
	for _, k := range slices.Sorted(maps.Keys(f.env)) {
		vars = append(vars, k+"="+f.env[k])
	}
	var secrets []string
	for _, k := range keys {
		vars = append(vars, k+"="+env[k])
		if len(env[k]) >= maskMin {
			secrets = append(secrets, env[k])
		}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", command) //nolint:gosec // G204: running the caller's command inside the sandbox is the guest agent's job
	cmd.Dir, cmd.Env = dir, vars
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// At the deadline the whole process group goes, not only the shell: a
	// child left holding the output would keep the op open.
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	stdout := &capped{max: protocol.SandboxExecStdoutBytes}
	stderr := &capped{max: protocol.SandboxExecStderrBytes}
	cmd.Stdout, cmd.Stderr, cmd.Stdin = stdout, stderr, nil
	start := time.Now()
	if err := cmd.Start(); err != nil {
		return protocol.SandboxResult{}, refuse(protocol.SandboxErrorCodeIo, "start: %v", err)
	}
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()
	var waitErr error
	select {
	case waitErr = <-waited:
	case <-ctx.Done():
		// The group was sent SIGKILL. A process in uninterruptible I/O
		// (a write the host's disk is slow to take) dies only when that I/O
		// ends, minutes later; the op answers timed out at the deadline and
		// the grace, and the kill completes on its own.
		select {
		case waitErr = <-waited:
		case <-time.After(cmd.WaitDelay + killGrace):
			waitErr = ctx.Err()
		}
	}
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	exit := 0
	var ee *exec.ExitError
	switch {
	case timedOut:
		exit = 124
	case errors.As(waitErr, &ee):
		exit = ee.ExitCode()
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && exit < 0 {
			exit = 128 + int(ws.Signal())
		}
	case waitErr != nil:
		return protocol.SandboxResult{}, refuse(protocol.SandboxErrorCodeIo, "wait: %v", waitErr)
	}
	outRaw, outDropped := stdout.taken()
	errRaw, errDropped := stderr.taken()
	out, cutOut := clean(outRaw, secrets, protocol.SandboxExecStdoutBytes)
	errText, cutErr := clean(errRaw, secrets, protocol.SandboxExecStderrBytes)
	return protocol.SandboxResult{Ok: true, Exec: &protocol.SandboxExecResult{
		ExitCode: int64(exit), Stdout: out, Stderr: errText,
		Truncated: outDropped > 0 || errDropped > 0 || cutOut || cutErr,
		TimedOut:  timedOut, DurationMs: time.Since(start).Milliseconds(),
	}}, nil
}
