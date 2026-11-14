package kodyexec

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestRunExitCodeAndOutput(t *testing.T) {
	r := Run(context.Background(), Request{Command: "echo out; echo err >&2; exit 3", TimeoutMs: 5000})
	if r.ExitCode != 3 || r.Stdout != "out\n" || r.Stderr != "err\n" || r.Truncated {
		t.Fatalf("%+v", r)
	}
}

func TestRunTimeoutKillsTheGroup(t *testing.T) {
	r := Run(context.Background(), Request{Command: "sleep 30 & sleep 30", TimeoutMs: 200})
	if r.ExitCode != TimeoutExitCode || !r.TimedOut || r.DurationMs > 5000 {
		t.Fatalf("%+v", r)
	}
}

func TestRunCapsOutput(t *testing.T) {
	r := Run(context.Background(), Request{Command: "head -c 100000 /dev/zero | tr '\\0' a", TimeoutMs: 5000})
	if len(r.Stdout) != MaxStream || !r.Truncated {
		t.Fatalf("len %d truncated %v", len(r.Stdout), r.Truncated)
	}
}

func TestRunMasksSecretVariants(t *testing.T) {
	secret := "ghs_abcdefghijklmnop1234"
	cmd := "echo " + secret + "; echo " + base64.StdEncoding.EncodeToString([]byte(secret))
	r := Run(context.Background(), Request{Command: cmd, TimeoutMs: 5000, Secrets: []string{secret}})
	if strings.Contains(r.Stdout, "ghs_") || strings.Contains(r.Stdout, base64.StdEncoding.EncodeToString([]byte(secret))[:12]) {
		t.Fatalf("leaked: %q", r.Stdout)
	}
}

// S-09 (the part a unit test can reach): a runaway command ends with a
// result, never a hang or a crash of the caller.
func TestS09RunawayCommandsEndWithAResult(t *testing.T) {
	// disk: a file past the limit is cut by the kernel (SIGXFSZ).
	r := Run(context.Background(), Request{Command: "head -c 10000000 /dev/zero > big.bin", Cwd: t.TempDir(), TimeoutMs: 10000, Limits: Limits{MaxFileBytes: 1 << 20}})
	if r.ExitCode == 0 {
		t.Fatalf("wrote past the file limit: %+v", r)
	}
	// CPU: a busy loop is killed at the timeout with its children.
	r = Run(context.Background(), Request{Command: "while :; do :; done & while :; do :; done", TimeoutMs: 300})
	if r.ExitCode != TimeoutExitCode {
		t.Fatalf("busy loop: %+v", r)
	}
	// output flood: capped, flagged, and the process still ends.
	r = Run(context.Background(), Request{Command: "yes kody | head -c 50000000", TimeoutMs: 10000})
	if !r.Truncated || len(r.Stdout) != MaxStream {
		t.Fatalf("flood: truncated=%v len=%d", r.Truncated, len(r.Stdout))
	}
}

// TestHelperSetsidChild is not a test: Run starts the test binary as a
// process that leaves the group with setsid, writes its pid and holds the
// output pipes open.
func TestHelperSetsidChild(t *testing.T) {
	pidFile := os.Getenv("KODYEXEC_HELPER_PIDFILE")
	if pidFile == "" {
		t.Skip("helper process")
	}
	_, _ = syscall.Setsid()
	_ = os.WriteFile(pidFile, []byte(strconv.Itoa(os.Getpid())), 0o600)
	time.Sleep(30 * time.Second)
	os.Exit(0)
}

// H1: a child that called setsid used to hold Run (and the step) until it
// exited on its own. Run now returns at the timeout plus KillGrace, and on
// Linux the child is dead.
func TestRunTimeoutHoldsAgainstASetsidChild(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	helper := fmt.Sprintf("KODYEXEC_HELPER_PIDFILE=%s %s -test.run=^TestHelperSetsidChild$ &", pidFile, os.Args[0])
	start := time.Now()
	r := Run(context.Background(), Request{Command: helper + " sleep 30", TimeoutMs: 500})
	took := time.Since(start)
	if !r.TimedOut || r.ExitCode != TimeoutExitCode {
		t.Fatalf("%+v", r)
	}
	if took > 500*time.Millisecond+KillGrace+2*time.Second {
		t.Fatalf("Run took %s: the setsid child held it past the timeout", took)
	}
	b, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("helper never started: %v", err)
	}
	pid, _ := strconv.Atoi(string(b))
	if runtime.GOOS != "linux" {
		_ = syscall.Kill(pid, syscall.SIGKILL)
		return
	}
	deadline := time.Now().Add(2 * time.Second)
	for alive(pid) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if alive(pid) {
		_ = syscall.Kill(pid, syscall.SIGKILL)
		t.Fatal("the setsid child outlived the timeout")
	}
}

// A command that exits leaving a background process on its pipes returns
// within KillGrace with its own exit code, not when the background ends.
func TestRunReturnsWhenTheCommandExitsDespiteABackgroundJob(t *testing.T) {
	start := time.Now()
	r := Run(context.Background(), Request{Command: "sleep 20 & echo started; exit 4", TimeoutMs: 30_000})
	if time.Since(start) > KillGrace+2*time.Second || r.ExitCode != 4 || r.TimedOut || r.Stdout != "started\n" {
		t.Fatalf("%+v after %s", r, time.Since(start))
	}
}

func alive(pid int) bool {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return false
	}
	s := string(b)
	if i := strings.LastIndexByte(s, ')'); i >= 0 && len(s) > i+2 {
		return s[i+2] != 'Z'
	}
	return true
}
