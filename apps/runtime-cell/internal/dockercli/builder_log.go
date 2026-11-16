package dockercli

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/composecmd"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// buildkitd's own log. buildctl-daemonless.sh, the builder's entrypoint,
// sends it to a temporary file it removes when it exits, so a build that
// BuildKit slowed down without failing (the overlay differ falling back to
// walking the whole tree, docs/runtime/measurements-2026-11-11.md) left no
// trace. RunBuild has buildkitd started through a wrapper that keeps its
// first MaxBuilderLogBytes in Out (BuilderLog); ReadBuilderLog reads it back.

// BuilderLog is where the builder leaves buildkitd's log, inside Out.
const BuilderLog = "buildkitd.log"

// builderLogWrapper is the wrapper RunBuild writes in Out, which
// buildctl-daemonless.sh runs in place of buildkitd (its $BUILDKITD).
const builderLogWrapper = "kodus-buildkitd.sh"

// MaxBuilderLogBytes bounds the log the builder keeps: past it, the rest is
// read and dropped, so buildkitd never blocks or dies on a full log.
const MaxBuilderLogBytes = 1 << 20

// builderLogScript is the wrapper: buildkitd runs as the same process
// (exec), so buildctl-daemonless.sh still stops it by its pid, and writes
// into a FIFO that a reader copies to logPath up to the bound and drains
// after. A wrapper that cannot make its FIFO starts buildkitd with no log.
// fifoDir is where the FIFO goes (the container's /tmp).
func builderLogScript(logPath, fifoDir string) string {
	return fmt.Sprintf(`# Keeps buildkitd's log at %[1]s, at most %[2]d bytes (dockercli/builder_log.go).
f=$(mktemp -u %[3]s/kodus-buildkitd.XXXXXX) && mkfifo -m 600 "$f" || exec buildkitd "$@"
{ rm -f "$f"; head -c %[2]d >%[1]s || true; cat >/dev/null; } <"$f" &
exec buildkitd "$@" >"$f" 2>&1
`, composecmd.ShellQuote(logPath), MaxBuilderLogBytes, composecmd.ShellQuote(fifoDir))
}

// BuilderLogSummary is what buildkitd's log says of a build: how many lines
// it logged at warning and at error level, how many layers the overlay
// differ could not compute (each one exported by walking the whole tree),
// whether the log reached its bound, and its last lines, redacted.
type BuilderLogSummary struct {
	Lines, Warnings, Errors, OverlayDifferFallbacks int
	Truncated                                       bool
	Tail                                            []string
}

// builderLogTail and maxBuilderLogLine bound the lines a summary carries.
const (
	builderLogTail    = 20
	maxBuilderLogLine = 300
)

var (
	logLevel = regexp.MustCompile(`\blevel=(warning|warn|error|fatal|panic)\b`)
	// secretAssign is buildprogress's: a KEY=value whose key names a secret.
	secretAssign = regexp.MustCompile(`(?i)\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)`)
)

// ReadBuilderLog reads the log a build left in out. The builder is
// untrusted and done by now: only a regular file is read, never through a
// link, and never more than MaxBuilderLogBytes. No log is an empty summary.
func ReadBuilderLog(out string) (BuilderLogSummary, error) {
	var s BuilderLogSummary
	p := filepath.Join(out, BuilderLog)
	info, err := os.Lstat(p)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if !info.Mode().IsRegular() {
		return s, fmt.Errorf("dockercli: %s is not a regular file", BuilderLog)
	}
	f, err := OpenNoFollow(p)
	if err != nil {
		return s, err
	}
	defer func() { _ = f.Close() }()
	raw, err := io.ReadAll(io.LimitReader(f, MaxBuilderLogBytes+1))
	if err != nil {
		return s, err
	}
	if len(raw) >= MaxBuilderLogBytes {
		s.Truncated = true
		raw = raw[:min(len(raw), MaxBuilderLogBytes)]
	}
	lines := bytes.Split(bytes.TrimRight(raw, "\n"), []byte("\n"))
	if len(raw) == 0 {
		lines = nil
	}
	s.Lines = len(lines)
	for _, l := range lines {
		if m := logLevel.FindSubmatch(l); m != nil {
			if string(m[1]) == "warning" || string(m[1]) == "warn" {
				s.Warnings++
			} else {
				s.Errors++
			}
		}
		if bytes.Contains(l, []byte("overlay differ")) {
			s.OverlayDifferFallbacks++
		}
	}
	for _, l := range lines[max(0, len(lines)-builderLogTail):] {
		s.Tail = append(s.Tail, cleanLogLine(string(l)))
	}
	return s, nil
}

func cleanLogLine(l string) string {
	l = strings.ToValidUTF8(l, "?")
	l, _ = redact.Patterns(l)
	l = secretAssign.ReplaceAllString(l, "$1=[redacted]")
	clipped, _ := redact.Clip(l, maxBuilderLogLine)
	return clipped
}

// String is the summary's tail as an error's last lines, at most n of them.
func (s BuilderLogSummary) String(n int) string {
	tail := s.Tail[max(0, len(s.Tail)-n):]
	var b strings.Builder
	b.WriteString("buildkitd (" + strconv.Itoa(s.Lines) + " lines):")
	for _, l := range tail {
		b.WriteString("\n  " + l)
	}
	return b.String()
}
