package agent

import (
	"archive/tar"
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// coverageComposer keeps the last Up's request; coverageFlusher, as the
// claim's Node services would, writes the coverage file into the
// directory that Up named.
type coverageComposer struct {
	mu  sync.Mutex
	req driver.UpRequest
}

func (c *coverageComposer) Up(_ context.Context, req driver.UpRequest) ([]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.req = req
	return []string{"172.30.0.2"}, nil
}

func (c *coverageComposer) last() driver.UpRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.req
}

type coverageFlusher struct {
	cp       *coverageComposer
	coverage []byte
	mu       sync.Mutex
	flushed  []string
}

func (f *coverageFlusher) FlushCoverage(_ context.Context, _ driver.MachineRef, services []string) error {
	f.mu.Lock()
	f.flushed = append(f.flushed, services...)
	f.mu.Unlock()
	return os.WriteFile(filepath.Join(f.cp.last().Coverage.Dir, "coverage-7-1-0.json"), f.coverage, 0o600)
}

func exercisedFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "exercised", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// exercisedHarness is a cell whose checkout has a Node service and a
// database, and src/plain.js; flush, when set, is its driver's flusher.
func exercisedHarness(t *testing.T, on, flush bool) (*harness, *coverageComposer, *coverageFlusher) {
	t.Helper()
	plain := exercisedFixture(t, "plain.js")
	srv := repoServerWith(t, func(tw *tar.Writer) {
		const compose = "services:\n  api:\n    image: node:22-alpine\n  db:\n    image: postgres:16\n"
		_ = tw.WriteHeader(&tar.Header{Name: "o-r-0123/compose.yaml", Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(compose))})
		_, _ = tw.Write([]byte(compose))
		_ = tw.WriteHeader(&tar.Header{Name: "o-r-0123/src/plain.js", Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(plain))})
		_, _ = tw.Write(plain)
	})
	cp := &coverageComposer{}
	fl := &coverageFlusher{cp: cp, coverage: exercisedFixture(t, "coverage-plain.json")}
	h := newHarness(t, func(c *Config) {
		c.Parts.Composer = cp
		if flush {
			c.Parts.Coverage = fl
		}
		c.ExercisedLines = on
		c.Repo = func(protocol.ClaimAcquireBody) (string, error) { return srv + "/tarball", nil }
	})
	return h, cp, fl
}

const exercisedStep = "8f0b8b3c-6d0e-4c43-9a53-3f1f1d6a0c01"

func askExercised(t *testing.T, h *harness, claim string) *protocol.StepResultBody {
	t.Helper()
	body := &protocol.ClaimExercisedBody{StepID: exercisedStep, Exercised: protocol.ClaimExercisedBodyExercised{Files: []protocol.ClaimExercisedBodyExercisedFilesItem{
		{Path: "src/plain.js", Lines: []int64{2, 6, 7}},
	}}}
	if err := h.handle(claim, protocol.MessageTypeClaimExercised, body); err != nil {
		t.Fatalf("claim.exercised: %v", err)
	}
	return h.conn.next(t, isResult(exercisedStep)).(*protocol.StepResultBody)
}

// A Run's PR claim instruments its Node services at boot and answers
// claim.exercised with the count of the changed lines they ran.
func TestARunClaimCountsTheChangedLinesItsNodeServicesRan(t *testing.T) {
	h, cp, fl := exercisedHarness(t, true, true)
	h.ready("claim-pr", func(b *protocol.ClaimAcquireBody) { b.Side = protocol.SidePr })
	req := cp.last()
	if got := req.Coverage.Services; len(got) != 1 || got[0] != "api" {
		t.Fatalf("instrumented %v, want [api]", got)
	}
	if !strings.HasPrefix(req.Coverage.Dir, filepath.Join(h.a.cfg.WorkDir, "claims", "claim-pr")+string(filepath.Separator)) || strings.HasPrefix(req.Coverage.Dir, req.ProjectDir) {
		t.Fatalf("coverage dir %s is not the claim's own, beside the checkout %s", req.Coverage.Dir, req.ProjectDir)
	}
	if !strings.Contains(string(req.Compose), "NODE_V8_COVERAGE: "+sandbox.CoverageTarget) {
		t.Fatalf("api writes no coverage: %s", req.Compose)
	}
	res := askExercised(t, h, "claim-pr")
	if res.Exercised == nil || res.Executor != protocol.ExecutorVM || res.Exec != nil {
		t.Fatalf("result %+v", res)
	}
	f := res.Exercised.Files[0]
	if res.Exercised.Language != protocol.StepResultBodyExercisedLanguageNode || f.Status != protocol.StepResultBodyExercisedFilesItemStatusMeasured || f.ChangedLines != 3 || string(f.ExercisedLines) != "1" {
		t.Fatalf("got %+v exercised=%s", res.Exercised, f.ExercisedLines)
	}
	fl.mu.Lock()
	defer fl.mu.Unlock()
	if len(fl.flushed) != 1 || fl.flushed[0] != "api" {
		t.Fatalf("flushed %v", fl.flushed)
	}
	if logs := h.logs.String(); !strings.Contains(logs, "claim.exercised.counted") || strings.Contains(logs, "plain.js") {
		t.Fatalf("logs: %s", logs)
	}
}

// A setup's machine may become a bake: it is never instrumented.
func TestASetupClaimIsNeverInstrumented(t *testing.T) {
	h, cp, _ := exercisedHarness(t, true, true)
	h.ready("claim-setup", func(b *protocol.ClaimAcquireBody) {
		b.Consumer, b.Side = protocol.ConsumerSetup, protocol.SideSetup
		b.HardExpiresAt = protocol.FormatTime(h.clk.Now().Add(40 * time.Minute))
	})
	if req := cp.last(); req.Coverage.Set() || strings.Contains(string(req.Compose), "NODE_V8_COVERAGE") {
		t.Fatalf("a setup was instrumented: %+v %s", req.Coverage, req.Compose)
	}
}

// Off, or on a driver that cannot flush, the boot changes nothing and the
// answer says why every file is unknown.
func TestNoInstrumentationOffOrWithoutAFlusher(t *testing.T) {
	for _, tc := range []struct {
		name      string
		on, flush bool
		reason    protocol.StepResultBodyExercisedFilesItemReason
	}{
		{"off", false, true, protocol.StepResultBodyExercisedFilesItemReasonNoCoverageWritten},
		{"no flusher", true, false, protocol.StepResultBodyExercisedFilesItemReasonUnsupportedDriver},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, cp, fl := exercisedHarness(t, tc.on, tc.flush)
			h.ready("claim-pr", func(b *protocol.ClaimAcquireBody) { b.Side = protocol.SidePr })
			if req := cp.last(); req.Coverage.Set() || strings.Contains(string(req.Compose), "NODE_V8_COVERAGE") {
				t.Fatalf("instrumented: %+v", req.Coverage)
			}
			res := askExercised(t, h, "claim-pr")
			f := res.Exercised.Files[0]
			if f.Status != protocol.StepResultBodyExercisedFilesItemStatusUnknown || f.Reason == nil || *f.Reason != tc.reason {
				t.Fatalf("got %+v", f)
			}
			fl.mu.Lock()
			defer fl.mu.Unlock()
			if len(fl.flushed) != 0 {
				t.Fatalf("flushed %v", fl.flushed)
			}
		})
	}
}
