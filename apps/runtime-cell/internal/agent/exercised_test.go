package agent

import (
	"archive/tar"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/coverage"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/exercised"
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
	// built are the services the driver says it found running Node in
	// what it built, beside the ones the Up asked for.
	built   []string
	mu      sync.Mutex
	flushed []string
}

func (f *coverageFlusher) CoverageServices(driver.MachineRef) []string {
	req := f.cp.last()
	if !req.Coverage.Set() {
		return nil
	}
	return append(slices.Clone(req.Coverage.Services), f.built...)
}

func (f *coverageFlusher) FlushCoverage(_ context.Context, _ driver.MachineRef, services []string) error {
	f.mu.Lock()
	f.flushed = append(f.flushed, services...)
	f.mu.Unlock()
	dir := f.cp.last().Coverage.Dir
	if err := os.WriteFile(filepath.Join(dir, exercised.StartMarkerPrefix+"7-0"), nil, 0o600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "coverage-7-1-0.json"), f.coverage, 0o600)
}

func exercisedFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "exercised", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

const exercisedCompose = "services:\n  api:\n    image: node:22-alpine\n  db:\n    image: postgres:16\n"

// exercisedHarness is a cell whose checkout has a Node service and a
// database, and src/plain.js; flush, when set, is its driver's flusher.
func exercisedHarness(t *testing.T, on, flush bool, edit ...func(*Config)) (*harness, *coverageComposer, *coverageFlusher) {
	t.Helper()
	return exercisedHarnessWith(t, exercisedCompose, on, flush, edit...)
}

func exercisedHarnessWith(t *testing.T, compose string, on, flush bool, edit ...func(*Config)) (*harness, *coverageComposer, *coverageFlusher) {
	t.Helper()
	plain := exercisedFixture(t, "plain.js")
	srv := repoServerWith(t, func(tw *tar.Writer) {
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
		c.CoverageCap = &coverage.FakeCap{}
		c.Repo = func(protocol.ClaimAcquireBody) (string, error) { return srv + "/tarball", nil }
		for _, f := range edit {
			f(c)
		}
	})
	return h, cp, fl
}

const exercisedStep = "8f0b8b3c-6d0e-4c43-9a53-3f1f1d6a0c01"

func askExercised(t *testing.T, h *harness, claim string, stepID ...string) *protocol.StepResultBody {
	t.Helper()
	step := exercisedStep
	if len(stepID) > 0 {
		step = stepID[0]
	}
	body := &protocol.ClaimExercisedBody{StepID: step, Exercised: protocol.ClaimExercisedBodyExercised{Files: []protocol.ClaimExercisedBodyExercisedFilesItem{
		{Path: "src/plain.js", Lines: []int64{2, 6, 7}},
	}}}
	if err := h.handle(claim, protocol.MessageTypeClaimExercised, body); err != nil {
		t.Fatalf("claim.exercised: %v", err)
	}
	return h.conn.next(t, isResult(step)).(*protocol.StepResultBody)
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

// The coverage directory is a bind outside the services' disk cap: a claim
// whose directory the cell cannot cap boots as it would with exercised
// lines off, and its answer says no coverage was written.
func TestARunClaimWhoseCoverageCannotBeCappedIsNotInstrumented(t *testing.T) {
	h, cp, fl := exercisedHarness(t, true, true, func(c *Config) {
		c.CoverageCap = &coverage.FakeCap{Err: errors.New("mount: operation not permitted")}
	})
	h.ready("claim-pr", func(b *protocol.ClaimAcquireBody) { b.Side = protocol.SidePr })
	if req := cp.last(); req.Coverage.Dir != "" || strings.Contains(string(req.Compose), "NODE_V8_COVERAGE") {
		t.Fatalf("instrumented without a cap: %+v", req.Coverage)
	}
	if !strings.Contains(h.logs.String(), "claim.coverage.uncapped") {
		t.Fatalf("no word of the missing cap: %s", h.logs.String())
	}
	f := askExercised(t, h, "claim-pr").Exercised.Files[0]
	if f.Status != protocol.StepResultBodyExercisedFilesItemStatusUnknown || f.Reason == nil || *f.Reason != protocol.StepResultBodyExercisedFilesItemReasonNoCoverageWritten {
		t.Fatalf("got %+v", f)
	}
	fl.mu.Lock()
	defer fl.mu.Unlock()
	if len(fl.flushed) != 0 {
		t.Fatalf("flushed %v", fl.flushed)
	}
}

// A released claim's cap comes off before its directory is removed.
func TestAReleasedRunClaimTakesItsCapOff(t *testing.T) {
	capped := &coverage.FakeCap{}
	h, _, _ := exercisedHarness(t, true, true, func(c *Config) { c.CoverageCap = capped })
	h.ready("claim-pr", func(b *protocol.ClaimAcquireBody) { b.Side = protocol.SidePr })
	if got := capped.Capped(); len(got) != 1 {
		t.Fatalf("capped %v, want the claim's coverage directory", got)
	}
	if err := h.handle("claim-pr", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(capped.Capped()) == 0 })
}

// A Run that takes a warm pool machine boots its project in the claim
// (the pool machine holds a network, a holder and the baked data, never a
// running project), so both sides are instrumented from their own boot
// and count only what ran in that claim.
func TestRunClaimsOnPoolMachinesAreInstrumentedFromTheirOwnBoot(t *testing.T) {
	h, cp, _ := exercisedHarness(t, true, true, func(c *Config) { c.Parts.Pooler = c.Driver.(driver.Pooler) })
	img := bakeImage(t, h)
	if err := h.handle("", protocol.MessageTypePoolTarget, &protocol.PoolTargetBody{OrgID: "org-a", EnvironmentID: "env-1", ImageID: img, Size: 2}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(h.poolMachines(img)) == 2 })
	steps := map[protocol.Side]string{protocol.SideBase: "8f0b8b3c-6d0e-4c43-9a53-3f1f1d6a0c02", protocol.SidePr: exercisedStep}
	for _, side := range []protocol.Side{protocol.SideBase, protocol.SidePr} {
		claim := "claim-" + string(side)
		h.ready(claim, func(b *protocol.ClaimAcquireBody) { b.Side, b.ImageID = side, "latest" })
		c, _ := h.a.claims.Get(claim)
		if c.Start() != string(protocol.ClaimReadyBodyStartPool) {
			t.Fatalf("%s did not take a pool machine: %s", side, c.Machines().Workload.MachineID)
		}
		if got := cp.last().Coverage.Services; len(got) != 1 || got[0] != "api" {
			t.Fatalf("%s on a pool machine instrumented %v", side, got)
		}
		f := askExercised(t, h, claim, steps[side]).Exercised.Files[0]
		if f.Status != protocol.StepResultBodyExercisedFilesItemStatusMeasured {
			t.Fatalf("%s on a pool machine: %+v", side, f)
		}
	}
}

// A Run whose Node service is built from a Dockerfile asks the Up for
// coverage even with no Node image named, and flushes and counts the
// services the driver found running Node once it built them.
func TestARunClaimCountsAServiceBuiltFromANodeImage(t *testing.T) {
	h, cp, fl := exercisedHarnessWith(t, "services:\n  web:\n    build: .\n  db:\n    image: postgres:16\n", true, true)
	fl.built = []string{"web"}
	h.ready("claim-pr", func(b *protocol.ClaimAcquireBody) { b.Side = protocol.SidePr })
	if req := cp.last(); !req.Coverage.Set() || len(req.Coverage.Services) != 0 {
		t.Fatalf("the Up did not ask for coverage on what it builds: %+v", req.Coverage)
	}
	f := askExercised(t, h, "claim-pr").Exercised.Files[0]
	if f.Status != protocol.StepResultBodyExercisedFilesItemStatusMeasured || string(f.ExercisedLines) != "1" {
		t.Fatalf("got %+v exercised=%s", f, f.ExercisedLines)
	}
	fl.mu.Lock()
	defer fl.mu.Unlock()
	if !slices.Equal(fl.flushed, []string{"web"}) {
		t.Fatalf("flushed %v, want the built Node service", fl.flushed)
	}
}

// A cell that starts takes off the caps a stopped one left: their claims
// went with it.
func TestACellStartsByTakingOffTheCapsALostOneLeft(t *testing.T) {
	capped := &coverage.FakeCap{}
	var left string
	exercisedHarness(t, true, true, func(c *Config) {
		left = filepath.Join(c.WorkDir, "claims", "claim-old", coverage.DirName)
		_ = capped.Cap(left)
		c.CoverageCap = capped
	})
	if got := capped.Capped(); len(got) != 0 {
		t.Fatalf("still capped at start: %v (left %s)", got, left)
	}
}
