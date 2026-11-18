package dockercli

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
)

// A command's exit status survives as a value: the driver tells a builder
// killed at its memory limit (137) from a failed compile without reading
// the message, and the message reads as before.
func TestACommandsExitStatusIsTyped(t *testing.T) {
	_, err := ExecCommandWith(nil)(context.Background(), nil, "sh", "-c", "echo oom >&2; exit 137")
	code, ok := ExitCode(err)
	if !ok || code != ExitKilled {
		t.Fatalf("ExitCode(%v) = %d, %v; want %d", err, code, ok, ExitKilled)
	}
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("%v does not wrap the *exec.ExitError", err)
	}
	if got := err.Error(); got != "sh -c echo oom >&2; exit 137: exit status 137: oom" {
		t.Fatalf("message %q", got)
	}

	_, err = ExecCommandWith(nil)(context.Background(), nil, "sh", "-c", "exit 1")
	if code, ok := ExitCode(err); !ok || code != 1 {
		t.Fatalf("ExitCode = %d, %v; want 1", code, ok)
	}
	// A command that never ran has no exit status.
	_, err = ExecCommandWith(nil)(context.Background(), nil, "/nonexistent/docker")
	if _, ok := ExitCode(err); ok || err == nil || !strings.Contains(err.Error(), "/nonexistent/docker") {
		t.Fatalf("a command that never ran: %v", err)
	}
}
