package dockercli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The wrapper keeps buildkitd's log up to its bound, and a buildkitd that
// logs past it neither blocks nor dies: it gets its arguments, and its exit
// status is the wrapper's (buildctl-daemonless.sh waits on that pid).
func TestTheBuilderKeepsBuildkitdsLogUpToItsBound(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the wrapper runs in the builder's Linux shell")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	// A buildkitd that names its arguments, then logs three times the bound.
	fake := "#!/bin/sh\necho \"args: $*\" >&2\nyes 'level=info msg=\"a line of the log\"' | head -c " + fmt.Sprint(3*MaxBuilderLogBytes) + "\nexit 7\n"
	if err := os.WriteFile(filepath.Join(bin, "buildkitd"), []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, BuilderLog)
	script := filepath.Join(dir, builderLogWrapper)
	if err := os.WriteFile(script, []byte(builderLogScript(logPath, dir)), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/sh", script, "--oci-worker-no-process-sandbox", "--addr=unix:///run/x.sock")
	cmd.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	err := cmd.Run()
	var exit *exec.ExitError
	if ctx.Err() != nil || !errors.As(err, &exit) || exit.ExitCode() != 7 {
		t.Fatalf("wrapper ended with %v (context %v), want buildkitd's exit 7", err, ctx.Err())
	}
	// The reader may still be draining when buildkitd's exit returns.
	var got []byte
	for range 100 {
		if got, err = os.ReadFile(logPath); err == nil && len(got) == MaxBuilderLogBytes {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(got) != MaxBuilderLogBytes || !bytes.HasPrefix(got, []byte("args: --oci-worker-no-process-sandbox --addr=unix:///run/x.sock\n")) {
		t.Fatalf("log of %d bytes (want %d), starting %q", len(got), MaxBuilderLogBytes, got[:min(len(got), 80)])
	}
	fifos, _ := filepath.Glob(filepath.Join(dir, "kodus-buildkitd.??????"))
	if len(fifos) != 0 {
		t.Fatalf("the FIFO stayed: %v", fifos)
	}
}

// What the cell reads back says how many warnings and errors buildkitd
// logged and how many layers fell back from the overlay differ, with the
// last lines redacted and bounded.
func TestABuildersLogSaysWhatBuildkitdWarnedOf(t *testing.T) {
	out := t.TempDir()
	var log strings.Builder
	for i := range 30 {
		fmt.Fprintf(&log, "time=\"2026-11-12T10:00:%02dZ\" level=info msg=\"step %d\"\n", i, i)
	}
	log.WriteString(`time="2026-11-12T10:01:00Z" level=warning msg="failed to compute blob by overlay differ (ok=false): failed to retrieve trusted.overlay.redirect attr: operation not supported"` + "\n")
	log.WriteString(`time="2026-11-12T10:01:01Z" level=warning msg="failed to compute blob by overlay differ (ok=false): failed to retrieve trusted.overlay.redirect attr: operation not supported"` + "\n")
	log.WriteString(`time="2026-11-12T10:01:02Z" level=error msg="push failed" GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789` + "\n")
	log.WriteString(strings.Repeat("x", 2000) + "\n")
	writeTestFile(t, filepath.Join(out, BuilderLog), log.String())
	s, err := ReadBuilderLog(out)
	if err != nil {
		t.Fatal(err)
	}
	if s.Lines != 34 || s.Warnings != 2 || s.Errors != 1 || s.OverlayDifferFallbacks != 2 || s.Truncated {
		t.Fatalf("summary %+v", s)
	}
	if len(s.Tail) != builderLogTail {
		t.Fatalf("tail of %d lines, want %d", len(s.Tail), builderLogTail)
	}
	tail := strings.Join(s.Tail, "\n")
	if strings.Contains(tail, "ghp_abcdefghijklmnopqrstuvwxyz0123456789") || !strings.Contains(tail, "overlay differ") {
		t.Fatalf("tail not redacted, or lost the warning:\n%s", tail)
	}
	for _, l := range s.Tail {
		if len(l) > maxBuilderLogLine {
			t.Fatalf("a line of %d bytes passed the bound", len(l))
		}
	}
}

// The builder is untrusted: a link in the log's place is never followed, and
// a build that left no log has an empty summary, not an error.
func TestABuildersLogIsNeverReadThroughALink(t *testing.T) {
	out := t.TempDir()
	if s, err := ReadBuilderLog(out); err != nil || s.Lines != 0 {
		t.Fatalf("no log: %+v, %v", s, err)
	}
	secret := filepath.Join(t.TempDir(), "secret")
	writeTestFile(t, secret, "level=error msg=\"the host's file\"\n")
	if err := os.Symlink(secret, filepath.Join(out, BuilderLog)); err != nil {
		t.Fatal(err)
	}
	if s, err := ReadBuilderLog(out); err == nil || s.Lines != 0 {
		t.Fatalf("read through a link: %+v, %v", s, err)
	}
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
