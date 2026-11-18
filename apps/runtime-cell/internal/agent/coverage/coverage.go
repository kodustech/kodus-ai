// Package coverage answers claim.exercised (feature exercisedLines): it has
// a Run claim's instrumented Node services flush their V8 coverage, waits
// until the files stop growing, and counts which of the PR's changed lines
// ran (internal/exercised). Only counts leave the claim, never the
// coverage. A stateless part of the agent: it sees a claim only as Claim.
package coverage

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/checkoutfs"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/exercised"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

const (
	// DirName and PreloadName are the coverage files in the claim's
	// directory, beside its checkout and never in it: removed with the claim.
	DirName     = "coverage"
	PreloadName = "coverage-preload.cjs"
	// MaxWait is the longest a count waits after the flush for the files
	// to stop growing.
	MaxWait   = 3 * time.Second
	pollEvery = 250 * time.Millisecond
	// maxSourceBytes is the most of one checkout file read to count its lines.
	maxSourceBytes = 16 << 20
	// MaxMeasure is the longest one count maps coverage for; past it the
	// files are coverage_too_large. One count maps at a time on the cell
	// (Counter), so a claim's coverage never takes the agent's cores from
	// the others.
	MaxMeasure = 30 * time.Second
)

// Prepare makes the claim's coverage directory, capped by c (DirBytes,
// DirFiles; writable by any uid of its services), and the preload they
// read. A directory c cannot cap is ErrUncapped: the claim is then not
// instrumented. A second call (a reset's boot) keeps the directory's files.
func Prepare(claimDir string, c Capper) (dir, preload string, err error) {
	dir, preload = filepath.Join(claimDir, DirName), filepath.Join(claimDir, PreloadName)
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", "", fmt.Errorf("coverage: %w", err)
	}
	if st, err := os.Lstat(dir); err != nil || !st.IsDir() {
		return "", "", fmt.Errorf("coverage: %s is not a directory", dir)
	}
	// The services run as any user and write the cap's root (mode 1777);
	// what they write is read with no link followed (exercised.Collect).
	if err := c.Cap(dir); err != nil {
		return "", "", errors.Join(ErrUncapped, err)
	}
	tmp, err := os.CreateTemp(claimDir, ".preload-*")
	if err != nil {
		return "", "", fmt.Errorf("coverage: %w", err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }() // gone once renamed in
	_, err = tmp.WriteString(compose.PreloadSource)
	if err == nil {
		err = tmp.Chmod(0o644)
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), preload)
	}
	if err != nil {
		return "", "", fmt.Errorf("coverage: preload: %w", err)
	}
	return dir, preload, nil
}

// Release takes the cap off the claim's coverage directory, before the
// claim's directory is removed.
func Release(claimDir string, c Capper) error {
	return c.Release(filepath.Join(claimDir, DirName))
}

// Counter counts a claim's exercised lines. A nil Flusher is a driver that
// collects no coverage: every file is unknown (unsupported_driver).
type Counter struct {
	Flusher driver.CoverageFlusher
	Clock   clock.Clock

	once sync.Once
	slot chan struct{} // one mapping at a time on the cell
}

// measure maps the claim's coverage once the cell's one mapping slot is
// free, for at most MaxMeasure. Waiting ends with ctx; the coverage is then
// coverage_too_large.
func (k *Counter) measure(ctx context.Context, files []exercised.File, dir string, read exercised.Source) ([]exercised.Result, error) {
	k.once.Do(func() { k.slot = make(chan struct{}, 1) })
	select {
	case k.slot <- struct{}{}:
	case <-ctx.Done():
		return exercised.Answer(ctx, files, dir, read)
	}
	defer func() { <-k.slot }()
	ctx, cancel := context.WithTimeout(ctx, MaxMeasure)
	defer cancel()
	return exercised.Answer(ctx, files, dir, read)
}

// Claim is what the counter needs of the claim: its workload, the services
// its boot instrumented, its coverage directory and the checkout the
// request's paths are read from.
type Claim struct {
	Log      *slog.Logger
	Workload driver.MachineRef
	Services []string
	Dir      string
	Checkout string
}

// Count answers one claim.exercised. It never fails: whatever goes wrong
// leaves the files unknown.
func (k *Counter) Count(ctx context.Context, c Claim, req protocol.ClaimExercisedBodyExercised) (out protocol.StepResultBodyExercised) {
	files := make([]exercised.File, len(req.Files))
	for i, f := range req.Files {
		lines := make([]int, len(f.Lines))
		for j, l := range f.Lines {
			lines[j] = int(l)
		}
		files[i] = exercised.File{Path: f.Path, Lines: lines}
	}
	read := func(p string) ([]byte, error) {
		return checkoutfs.Read(c.Checkout, filepath.FromSlash(p), maxSourceBytes)
	}
	unknown := protocol.StepResultBodyExercisedLanguageUnsupported
	defer func() {
		if r := recover(); r != nil {
			c.Log.Error("claim.exercised.failed", "files", len(files), "alarm", true)
			out = answer(unknown, exercised.Measure(files, nil, read))
		}
	}()
	switch {
	case k.Flusher == nil:
		results := exercised.Measure(files, nil, read)
		for i := range results {
			if results[i].Reason == exercised.ReasonNoCoverageWritten {
				results[i].Reason = exercised.ReasonUnsupportedDriver
			}
		}
		return answer(unknown, results)
	case len(c.Services) == 0:
		return answer(unknown, exercised.Measure(files, nil, read))
	}
	clk := clock.Or(k.Clock)
	start := clk.Now()
	if err := k.Flusher.FlushCoverage(ctx, c.Workload, c.Services); err != nil {
		// The error may carry the command's output: only the counts go out.
		c.Log.Warn("claim.exercised.flush.failed", "services", len(c.Services), "files", len(files))
		return answer(protocol.StepResultBodyExercisedLanguageNode, exercised.Measure(files, nil, read))
	}
	n := k.settle(ctx, clk, c.Dir)
	results, err := k.measure(ctx, files, c.Dir, read)
	if errors.Is(err, exercised.ErrUntrusted) {
		// Written by the PR's own processes, and not what V8 writes: the
		// answer fails closed (exercised.Untrusted). The rule names no file.
		c.Log.Warn("claim.exercised.untrusted", "rule", err.Error(), "files", len(files), "alarm", true)
	} else if errors.Is(err, exercised.ErrCoverageTooLarge) {
		c.Log.Warn("claim.exercised.too_large", "files", len(files), "waitedMs", clk.Now().Sub(start).Milliseconds())
	}
	out = answer(protocol.StepResultBodyExercisedLanguageNode, results)
	measured, changed, ran := 0, 0, 0
	for _, r := range results {
		changed += r.Changed
		if r.Measured {
			measured++
			ran += r.Exercised
		}
	}
	c.Log.Info("claim.exercised.counted", "services", len(c.Services), "coverageFiles", n, "files", len(files),
		"measured", measured, "unknown", len(files)-measured, "changedLines", changed, "exercisedLines", ran, "waitedMs", clk.Now().Sub(start).Milliseconds())
	return out
}

// FlushBeforeReset has the claim's instrumented services write what the
// round ran before a reset takes them down: a reset recreates the services,
// and a Node process stopped without a flush writes nothing, so only the
// last round would count. It waits, at most MaxWait, for a new file per
// service (then for the files to stop growing). It never fails the reset:
// a flush that fails is logged, and that round's lines are lost.
func (k *Counter) FlushBeforeReset(ctx context.Context, c Claim) {
	if k.Flusher == nil || len(c.Services) == 0 || c.Dir == "" {
		return
	}
	clk := clock.Or(k.Clock)
	before := measureDir(c.Dir)
	if err := k.Flusher.FlushCoverage(ctx, c.Workload, c.Services); err != nil {
		c.Log.Warn("claim.coverage.reset_flush.failed", "services", len(c.Services))
		return
	}
	deadline := clk.Now().Add(MaxWait)
	prev := before
	for clk.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return
		case <-clk.After(pollEvery):
		}
		cur := measureDir(c.Dir)
		if cur.files >= before.files+len(c.Services) && cur == prev {
			return
		}
		prev = cur
	}
}

// settle waits, at most MaxWait, until the coverage files stop growing
// (the same count and bytes on two polls), and returns how many there are.
func (k *Counter) settle(ctx context.Context, clk clock.Clock, dir string) int {
	deadline := clk.Now().Add(MaxWait)
	prev := measureDir(dir)
	for clk.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return prev.files
		case <-clk.After(pollEvery):
		}
		cur := measureDir(dir)
		if cur.files > 0 && cur == prev {
			return cur.files
		}
		prev = cur
	}
	return prev.files
}

type dirSize struct {
	files int
	bytes int64
}

// measureDir is the coverage files' count and bytes, regular files only.
func measureDir(dir string) dirSize {
	var s dirSize
	entries, err := os.ReadDir(dir)
	if err != nil {
		return s
	}
	for _, e := range entries {
		if !e.Type().IsRegular() || !strings.HasPrefix(e.Name(), "coverage-") || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		if info, err := e.Info(); err == nil {
			s.files++
			s.bytes += info.Size()
		}
	}
	return s
}

// answer is the results as step.result exercised.
func answer(language protocol.StepResultBodyExercisedLanguage, results []exercised.Result) protocol.StepResultBodyExercised {
	out := protocol.StepResultBodyExercised{Language: language, Files: make([]protocol.StepResultBodyExercisedFilesItem, len(results))}
	for i, r := range results {
		item := protocol.StepResultBodyExercisedFilesItem{Path: r.Path, ChangedLines: int64(r.Changed), ExercisedLines: []byte("null"), Status: protocol.StepResultBodyExercisedFilesItemStatusUnknown}
		if r.Measured {
			item.ExercisedLines = []byte(strconv.Itoa(r.Exercised))
			item.Status = protocol.StepResultBodyExercisedFilesItemStatusMeasured
		} else {
			reason := protocol.StepResultBodyExercisedFilesItemReason(r.Reason)
			if reason == "" {
				reason = protocol.StepResultBodyExercisedFilesItemReasonNoCoverageWritten
			}
			item.Reason = &reason
		}
		out.Files[i] = item
	}
	return out
}
