// Package kodyexec runs setup and internal-evidence commands inside a
// machine, and on the cell host it runs the docker binary with the
// same output caps and secret masking (dockercli, RunArgv). Its output is
// evidence, never a verdict (ADR-053): the PR can be root in the VM and
// forge anything printed here.
package kodyexec

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// MaxStream is the cap on stdout and stderr in a step.result (16 KiB).
const MaxStream = 16384

// TimeoutExitCode follows coreutils timeout(1), as run-cli.tool.ts does.
const TimeoutExitCode = 124

// KillGrace bounds how long Run waits for the output pipes once the command
// exited or was killed. A process that left the group (setsid) and keeps the
// pipes open would otherwise hold Run past the timeout, without end.
const KillGrace = 2 * time.Second

type Request struct {
	Command   string   `json:"command"`
	Cwd       string   `json:"cwd,omitempty"`
	TimeoutMs int64    `json:"timeoutMs"`
	Env       []string `json:"env,omitempty"`
	Secrets   []string `json:"secrets,omitempty"`
	Limits    Limits   `json:"limits,omitempty"`
	// Repository is the alias of another repository of a claim of several
	// repositories whose code the command runs on (exec.repository): a
	// driver that lays workspaces out runs it where that code was built.
	// Empty: the claim's own repository.
	Repository string `json:"repository,omitempty"`
	// Service is the compose service whose container the command runs in
	// (exec.service, hello feature execService). Empty: the recipe's public
	// service. A driver that does not run the project's containers refuses
	// it (ErrServiceUnsupported); one that has no such service fails, and
	// never runs the command in another container.
	Service string `json:"service,omitempty"`
}

// ErrServiceUnsupported is a driver's refusal of Request.Service: it runs
// commands in the machine, not in one of the project's service containers.
var ErrServiceUnsupported = errors.New("exec service: this driver runs commands in the machine, not in a compose service")

// Limits are per-command rlimits, a second lock under the VM's own pids,
// memory and disk limits (S-09). Zero means unset.
type Limits struct {
	MaxProcs     int   `json:"maxProcs,omitempty"`
	MaxFileBytes int64 `json:"maxFileBytes,omitempty"`
	MaxMemoryKB  int64 `json:"maxMemoryKb,omitempty"`
}

func (l Limits) prefix() string {
	var b strings.Builder
	if l.MaxProcs > 0 {
		fmt.Fprintf(&b, "ulimit -u %d || exit 125; ", l.MaxProcs)
	}
	if l.MaxFileBytes > 0 {
		blocks := (l.MaxFileBytes + 511) / 512
		fmt.Fprintf(&b, "ulimit -f %d || exit 125; ", blocks)
	}
	if l.MaxMemoryKB > 0 {
		fmt.Fprintf(&b, "ulimit -v %d 2>/dev/null; ", l.MaxMemoryKB)
	}
	return b.String()
}

type Result struct {
	ExitCode   int    `json:"exitCode"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	Truncated  bool   `json:"truncated"`
	DurationMs int64  `json:"durationMs"`
	TimedOut   bool   `json:"timedOut,omitempty"`
}

// capped keeps the first max bytes and counts the rest.
type capped struct {
	buf     bytes.Buffer
	max     int
	dropped int
}

func (c *capped) Write(p []byte) (int, error) {
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

// Run executes the command with sh -c in its own process group. At the
// timeout it kills the group and every process descended from the command,
// even one that left the group with setsid (killTree), and returns within
// KillGrace of the timeout whatever is still holding the pipes.
func Run(ctx context.Context, req Request) Result {
	if req.TimeoutMs <= 0 {
		req.TimeoutMs = 60_000
	}
	cmd := exec.Command("/bin/sh", "-c", req.Limits.prefix()+req.Command) //nolint:gosec,noctx // G204: running the claim's command inside the sandbox is this package's job; run, not CommandContext, kills the whole tree on ctx or timeout
	cmd.Dir = req.Cwd
	cmd.Env = append([]string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + os.TempDir(), "LANG=C.UTF-8"}, req.Env...)
	return run(ctx, req, cmd)
}

// ShellLine is what a command runs as under sh -c: the request's limits,
// then its command.
func (r Request) ShellLine() string { return r.Limits.prefix() + r.Command }

// RunArgv runs a fixed argv (no shell on this host) with env, under the
// request's timeout, output caps and secret masking: a client that carries
// the command somewhere else (docker exec into a sandbox) and must not
// outlive the deadline.
func RunArgv(ctx context.Context, req Request, env []string, argv ...string) Result {
	if req.TimeoutMs <= 0 {
		req.TimeoutMs = 60_000
	}
	cmd := exec.Command(argv[0], argv[1:]...) //nolint:gosec,noctx // G204: the caller's fixed argv, run without a shell; run, not CommandContext, kills the whole tree on ctx or timeout
	cmd.Env = env
	return run(ctx, req, cmd)
}

func run(ctx context.Context, req Request, cmd *exec.Cmd) Result {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(req.TimeoutMs)*time.Millisecond)
	defer cancel()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = KillGrace
	stdout := &capped{max: MaxStream}
	stderr := &capped{max: MaxStream}
	cmd.Stdout, cmd.Stderr = stdout, stderr

	start := time.Now()
	res := Result{}
	if err := cmd.Start(); err != nil {
		res.ExitCode = 127
		res.Stderr = MaskSecrets(err.Error(), req.Secrets)
		return res
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var err error
	select {
	case err = <-done:
	case <-ctx.Done():
		killTree(cmd.Process.Pid)
		err = <-done
		res.TimedOut = true
	}
	res.DurationMs = time.Since(start).Milliseconds()
	var exitErr *exec.ExitError
	switch {
	case res.TimedOut:
		res.ExitCode = TimeoutExitCode
	case err == nil:
		res.ExitCode = 0
	case errors.Is(err, exec.ErrWaitDelay):
		// The command exited; something it started still holds the pipes.
		res.ExitCode = cmd.ProcessState.ExitCode()
	case errors.As(err, &exitErr):
		res.ExitCode = exitErr.ExitCode()
		if res.ExitCode < 0 {
			res.ExitCode = 128 + int(syscall.SIGKILL)
		}
	default:
		res.ExitCode = 1
	}
	res.Stdout = MaskSecrets(stdout.buf.String(), req.Secrets)
	res.Stderr = MaskSecrets(stderr.buf.String(), req.Secrets)
	res.Truncated = stdout.dropped > 0 || stderr.dropped > 0
	// Masking can grow the text (*** is longer than a 2-char variant).
	res.Stdout, res.Truncated = clip(res.Stdout, res.Truncated)
	res.Stderr, res.Truncated = clip(res.Stderr, res.Truncated)
	if res.TimedOut {
		res.Stderr = strings.TrimRight(res.Stderr, "\n") + "\nkody-exec: timed out"
		res.Stderr, res.Truncated = clip(res.Stderr, res.Truncated)
	}
	return res
}

// subreaper is set when this process adopts the orphans of what it runs
// (BecomeSubreaper): then every process it did not start itself is the
// command's, and killTree kills them all.
var subreaper atomic.Bool

// BecomeSubreaper makes orphans of the command reparent to this process
// instead of init (Linux PR_SET_CHILD_SUBREAPER), so a double fork cannot
// hide from the timeout. kody-exec calls it: the process exists for one
// command. A process that runs other children (the cell agent) must not.
func BecomeSubreaper() error {
	if err := setSubreaper(); err != nil {
		return err
	}
	subreaper.Store(true)
	return nil
}

func clip(s string, truncated bool) (string, bool) {
	if len(s) <= MaxStream {
		return s, truncated
	}
	// Cut on a rune boundary so the JSON stays valid UTF-8.
	cut := MaxStream
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut], true
}
