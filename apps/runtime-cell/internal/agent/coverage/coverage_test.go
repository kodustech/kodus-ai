package coverage

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/exercised"
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
	return writeAsStarted(f.dir, "coverage-1-2-3.json", f.coverage)
}

// writeAsStarted writes name as a process the preload started does: its
// start marker, then its coverage.
func writeAsStarted(dir, name string, raw []byte) error {
	pid := strings.SplitN(strings.TrimPrefix(name, "coverage-"), "-", 2)[0]
	if err := os.WriteFile(filepath.Join(dir, exercised.StartMarkerPrefix+pid+"-0"), nil, 0o600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name), raw, 0o600)
}

func (f *writingFlusher) CoverageServices(driver.MachineRef) []string { return nil }

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
	dir, _, err := Prepare(claimDir, &FakeCap{})
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
	capped := &FakeCap{}
	dir, preload, err := Prepare(claimDir, capped)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(dir) != claimDir || filepath.Dir(preload) != claimDir {
		t.Fatalf("not in the claim's directory: %s %s", dir, preload)
	}
	if got := capped.Capped(); len(got) != 1 || got[0] != dir {
		t.Fatalf("capped %v, want the coverage directory", got)
	}
	if raw, err := os.ReadFile(preload); err != nil || string(raw) != compose.PreloadSource {
		t.Fatalf("preload %q, %v", raw, err)
	}
	if _, _, err := Prepare(claimDir, capped); err != nil {
		t.Fatalf("a second Prepare (a reset) failed: %v", err)
	}
}

// The services write the coverage directory with no other bound: a
// directory the cell cannot cap is never handed to them.
func TestPrepareRefusesADirectoryItCannotCap(t *testing.T) {
	claimDir := t.TempDir()
	_, _, err := Prepare(claimDir, &FakeCap{Err: errors.New("mount: operation not permitted")})
	if !errors.Is(err, ErrUncapped) {
		t.Fatalf("Prepare: %v, want ErrUncapped", err)
	}
}

// Release takes the cap off, so the claim's directory can be removed.
func TestReleaseTakesTheCapOff(t *testing.T) {
	claimDir := t.TempDir()
	capped := &FakeCap{}
	dir, _, err := Prepare(claimDir, capped)
	if err != nil {
		t.Fatal(err)
	}
	if err := Release(claimDir, capped); err != nil {
		t.Fatal(err)
	}
	if got := capped.Capped(); len(got) != 0 {
		t.Fatalf("still capped: %v (%s)", got, dir)
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

// sequenceFlusher writes the next of its coverages on each flush, each in a
// file of its own, as a service's flushes do.
type sequenceFlusher struct {
	dir       string
	coverages [][]byte
	asked     int
}

func (f *sequenceFlusher) FlushCoverage(_ context.Context, _ driver.MachineRef, _ []string) error {
	raw := f.coverages[min(f.asked, len(f.coverages)-1)]
	f.asked++
	return writeAsStarted(f.dir, "coverage-1-"+strconv.Itoa(f.asked)+"-0.json", raw)
}

func (f *sequenceFlusher) CoverageServices(driver.MachineRef) []string { return nil }

// A reset recreates the services: what a round ran is flushed before it,
// so the count at the end still sees lines only an earlier round ran.
func TestLinesAnEarlierRoundRanStillCountAfterAReset(t *testing.T) {
	var logs bytes.Buffer
	c := claimWith(t, &logs)
	f := &sequenceFlusher{dir: c.Dir, coverages: [][]byte{fixture(t, "coverage-plain.json"), []byte(`{"result":[]}`)}}
	k := &Counter{Flusher: f, Clock: clock.NewFake(time.Unix(0, 0))}
	k.FlushBeforeReset(context.Background(), c)
	got := k.Count(context.Background(), c, request)
	if f.asked != 2 {
		t.Fatalf("flushed %d times, want before the reset and at the count", f.asked)
	}
	js := got.Files[0]
	if js.Status != protocol.StepResultBodyExercisedFilesItemStatusMeasured || string(js.ExercisedLines) != "1" {
		t.Fatalf("plain.js %+v exercised=%s: the earlier round's lines were lost", js, js.ExercisedLines)
	}
}

// With no instrumented service, nothing is flushed before a reset.
func TestNothingIsFlushedBeforeAResetWithNoNodeService(t *testing.T) {
	var logs bytes.Buffer
	c := claimWith(t, &logs)
	c.Services = nil
	f := &sequenceFlusher{dir: c.Dir, coverages: [][]byte{fixture(t, "coverage-plain.json")}}
	(&Counter{Flusher: f, Clock: clock.NewFake(time.Unix(0, 0))}).FlushBeforeReset(context.Background(), c)
	if f.asked != 0 {
		t.Fatalf("flushed %d times", f.asked)
	}
}

// Coverage the PR's processes wrote that no V8 writes fails closed: the
// changed JS file is measured with none of its lines run, so a green Run is
// held back, and the cell raises an alarm naming the rule, not the file.
func TestForgedCoverageIsCountedAsNothingRan(t *testing.T) {
	var logs bytes.Buffer
	c := claimWith(t, &logs)
	forged := `{"result":[{"url":"file:///app/src/plain.js","functions":[{"ranges":[{"startOffset":0,"endOffset":10,"count":1},{"startOffset":0,"endOffset":132,"count":1}]}]}]}`
	f := &writingFlusher{dir: c.Dir, coverage: []byte(forged)}
	got := (&Counter{Flusher: f, Clock: clock.NewFake(time.Unix(0, 0))}).Count(context.Background(), c, request)
	js := got.Files[0]
	if js.Status != protocol.StepResultBodyExercisedFilesItemStatusMeasured || string(js.ExercisedLines) != "0" || js.ChangedLines != 3 {
		t.Fatalf("plain.js %+v exercised=%s, want measured with 0 of 3", js, js.ExercisedLines)
	}
	if !strings.Contains(logs.String(), `"msg":"claim.exercised.untrusted"`) || !strings.Contains(logs.String(), `"alarm":true`) || strings.Contains(logs.String(), "plain.js") {
		t.Fatalf("logs: %s", logs.String())
	}
}

// One count maps coverage at a time on the cell: a count whose step ends
// while another claim's mapping holds the slot answers coverage_too_large,
// never a partial count.
func TestACountWaitsForTheCellsMappingSlot(t *testing.T) {
	var logs bytes.Buffer
	c := claimWith(t, &logs)
	f := &writingFlusher{dir: c.Dir, coverage: fixture(t, "coverage-plain.json")}
	k := &Counter{Flusher: f, Clock: clock.NewFake(time.Unix(0, 0))}
	k.once.Do(func() { k.slot = make(chan struct{}, 1) })
	k.slot <- struct{}{} // another claim is mapping
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	got := k.Count(ctx, c, request)
	if r := got.Files[0].Reason; got.Files[0].Status != protocol.StepResultBodyExercisedFilesItemStatusUnknown || r == nil || *r != protocol.StepResultBodyExercisedFilesItemReasonCoverageTooLarge {
		t.Fatalf("got %+v", got.Files[0])
	}
	<-k.slot
	if got := k.Count(context.Background(), c, request); string(got.Files[0].ExercisedLines) != "1" {
		t.Fatalf("with the slot free: %+v exercised=%s", got.Files[0], got.Files[0].ExercisedLines)
	}
}
