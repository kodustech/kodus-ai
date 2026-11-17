package coverage

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// writingFlusher stands in for the services: a flush writes the coverage
// file they would, or fails.
type writingFlusher struct {
	dir      string
	coverage []byte
	err      error
	asked    []string
}

func (f *writingFlusher) FlushCoverage(_ context.Context, _ driver.MachineRef, services []string) error {
	f.asked = append(f.asked, services...)
	if f.err != nil {
		return f.err
	}
	return os.WriteFile(filepath.Join(f.dir, "coverage-1-2-3.json"), f.coverage, 0o600)
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "exercised", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// claimWith is a claim whose checkout has src/plain.js and whose coverage
// directory is ready.
func claimWith(t *testing.T, logs *bytes.Buffer) Claim {
	t.Helper()
	claimDir := t.TempDir()
	checkout := filepath.Join(claimDir, "repo")
	if err := os.MkdirAll(filepath.Join(checkout, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(checkout, "src", "plain.js"), fixture(t, "plain.js"), 0o600); err != nil {
		t.Fatal(err)
	}
	dir, _, err := Prepare(claimDir)
	if err != nil {
		t.Fatal(err)
	}
	return Claim{Log: slog.New(slog.NewJSONHandler(logs, nil)), Workload: driver.MachineRef{MachineID: "m"}, Services: []string{"api"}, Dir: dir, Checkout: checkout}
}

var request = protocol.ClaimExercisedBodyExercised{Files: []protocol.ClaimExercisedBodyExercisedFilesItem{
	{Path: "src/plain.js", Lines: []int64{2, 6, 7}},
	{Path: "README.md", Lines: []int64{1}},
}}

func TestPrepareMakesTheDirectoryAndThePreloadOutsideTheCheckout(t *testing.T) {
	claimDir := t.TempDir()
	dir, preload, err := Prepare(claimDir)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(dir) != claimDir || filepath.Dir(preload) != claimDir {
		t.Fatalf("not in the claim's directory: %s %s", dir, preload)
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() || st.Mode().Perm()&0o003 != 0o003 {
		t.Fatalf("the services' users cannot write the directory: %v %v", st, err)
	}
	if raw, err := os.ReadFile(preload); err != nil || string(raw) != compose.PreloadSource {
		t.Fatalf("preload %q, %v", raw, err)
	}
	if _, _, err := Prepare(claimDir); err != nil {
		t.Fatalf("a second Prepare (a reset) failed: %v", err)
	}
}

func TestCountFlushesWaitsAndCountsTheChangedLinesThatRan(t *testing.T) {
	var logs bytes.Buffer
	c := claimWith(t, &logs)
	f := &writingFlusher{dir: c.Dir, coverage: fixture(t, "coverage-plain.json")}
	clk := clock.NewFake(time.Unix(0, 0))
	got := (&Counter{Flusher: f, Clock: clk}).Count(context.Background(), c, request)
	if len(f.asked) != 1 || f.asked[0] != "api" {
		t.Fatalf("flushed %v, want the instrumented services", f.asked)
	}
	if got.Language != protocol.StepResultBodyExercisedLanguageNode || len(got.Files) != 2 {
		t.Fatalf("got %+v", got)
	}
	js := got.Files[0]
	if js.Status != protocol.StepResultBodyExercisedFilesItemStatusMeasured || js.ChangedLines != 3 || string(js.ExercisedLines) != "1" || js.Reason != nil {
		t.Fatalf("plain.js %+v exercised=%s", js, js.ExercisedLines)
	}
	md := got.Files[1]
	if md.Status != protocol.StepResultBodyExercisedFilesItemStatusUnknown || string(md.ExercisedLines) != "null" || md.Reason == nil || *md.Reason != protocol.StepResultBodyExercisedFilesItemReasonUnsupportedLanguage {
		t.Fatalf("README.md %+v", md)
	}
	if waited := clk.Now().Sub(time.Unix(0, 0)); waited <= 0 || waited > MaxWait {
		t.Fatalf("waited %v, want some and at most %v", waited, MaxWait)
	}
	if !strings.Contains(logs.String(), `"msg":"claim.exercised.counted"`) || strings.Contains(logs.String(), "plain.js") {
		t.Fatalf("logs name no file, only counts: %s", logs.String())
	}
}

func TestCountWaitsAtMostMaxWaitWhenNoCoverageComes(t *testing.T) {
	var logs bytes.Buffer
	c := claimWith(t, &logs)
	f := &writingFlusher{dir: t.TempDir(), coverage: fixture(t, "coverage-plain.json")} // writes elsewhere
	clk := clock.NewFake(time.Unix(0, 0))
	got := (&Counter{Flusher: f, Clock: clk}).Count(context.Background(), c, request)
	if waited := clk.Now().Sub(time.Unix(0, 0)); waited < MaxWait || waited > MaxWait+pollEvery {
		t.Fatalf("waited %v, want %v", waited, MaxWait)
	}
	if r := got.Files[0].Reason; r == nil || *r != protocol.StepResultBodyExercisedFilesItemReasonNoCoverageWritten {
		t.Fatalf("got %+v", got.Files[0])
	}
}

func TestCountWithoutAFlusherIsUnsupportedDriver(t *testing.T) {
	var logs bytes.Buffer
	got := (&Counter{Clock: clock.NewFake(time.Unix(0, 0))}).Count(context.Background(), claimWith(t, &logs), request)
	if got.Language != protocol.StepResultBodyExercisedLanguageUnsupported {
		t.Fatalf("language %s", got.Language)
	}
	if r := got.Files[0].Reason; got.Files[0].Status != protocol.StepResultBodyExercisedFilesItemStatusUnknown || r == nil || *r != protocol.StepResultBodyExercisedFilesItemReasonUnsupportedDriver {
		t.Fatalf("got %+v", got.Files[0])
	}
}

// A flush that fails gives unknown statuses, and never a count read from
// what a service may have half written.
func TestAFailedFlushAnswersUnknown(t *testing.T) {
	var logs bytes.Buffer
	c := claimWith(t, &logs)
	if err := os.WriteFile(filepath.Join(c.Dir, "coverage-old.json"), fixture(t, "coverage-plain.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	f := &writingFlusher{dir: c.Dir, err: errors.New("docker: exit 1: secret-looking output")}
	got := (&Counter{Flusher: f, Clock: clock.NewFake(time.Unix(0, 0))}).Count(context.Background(), c, request)
	for _, file := range got.Files {
		if file.Status != protocol.StepResultBodyExercisedFilesItemStatusUnknown {
			t.Fatalf("got %+v", file)
		}
	}
	if !strings.Contains(logs.String(), "claim.exercised.flush.failed") || strings.Contains(logs.String(), "secret-looking") {
		t.Fatalf("the failure is logged without the command's output: %s", logs.String())
	}
}

// A claim with no Node service has nothing to flush.
func TestCountOfAClaimWithNoNodeServiceFlushesNothing(t *testing.T) {
	var logs bytes.Buffer
	c := claimWith(t, &logs)
	c.Services = nil
	f := &writingFlusher{dir: c.Dir, coverage: fixture(t, "coverage-plain.json")}
	got := (&Counter{Flusher: f, Clock: clock.NewFake(time.Unix(0, 0))}).Count(context.Background(), c, request)
	if len(f.asked) != 0 || got.Language != protocol.StepResultBodyExercisedLanguageUnsupported {
		t.Fatalf("flushed %v, language %s", f.asked, got.Language)
	}
	if r := got.Files[0].Reason; r == nil || *r != protocol.StepResultBodyExercisedFilesItemReasonNoCoverageWritten {
		t.Fatalf("got %+v", got.Files[0])
	}
}
