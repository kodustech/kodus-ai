package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/browser"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
)

type browserTelemetry struct {
	a    *Agent
	c    *claims.Claim
	logs *bytes.Buffer
	reg  *metrics.Registry
	clk  *clock.Fake
	conn *hubConn
}

// This fixture uses only in-memory ports: no repo HTTP server, credentials,
// browser process or real timer is needed to observe completion telemetry.
func newBrowserTelemetry(t *testing.T) *browserTelemetry {
	t.Helper()
	logs := &bytes.Buffer{}
	reg := metrics.NewRegistry()
	clk := clock.NewFake(time.Unix(1, 0))
	d := fake.New()
	d.Isolation = driver.IsolationVM
	a, err := New(Config{CellID: "cell-fixture", Driver: d, Transport: stubTransport{}, Observers: func(context.Context, ClaimInfo, []observer.Target) (observer.Client, error) {
		return nil, errors.New("unused")
	}, Repo: func(protocol.ClaimAcquireBody) (string, error) { return "unused", nil }, Extractor: tarball.InProcessExtractor{}, Revoker: nopRevoker{}, OrgKey: func(string) (string, error) { return "unused", nil }, WorkDir: t.TempDir(), Clock: clk, Metrics: reg, Log: slog.New(slog.NewJSONHandler(logs, nil))})
	if err != nil {
		t.Fatal(err)
	}
	conn := newHubConn()
	a.conn = conn
	c := claims.New("claim-fixture", protocol.ClaimAcquireBody{Expose: []protocol.Expose{{Service: "app", Port: 3000, Kind: protocol.ExposeKindHTTP}}}, a.log.With("claim", "claim-fixture", "run", "run-fixture"), clk.Now())
	return &browserTelemetry{a, c, logs, reg, clk, conn}
}
func (f *browserTelemetry) completion(t *testing.T) map[string]any {
	t.Helper()
	var found map[string]any
	for _, line := range strings.Split(strings.TrimSpace(f.logs.String()), "\n") {
		var item map[string]any
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			t.Fatal(err)
		}
		if item["msg"] == "step.result" {
			found = item
		}
	}
	if found == nil {
		t.Fatal("no completion event")
	}
	return found
}
func (f *browserTelemetry) count(outcome string) float64 {
	return f.reg.Counter("cell_browser_explorations_total", "fixture", "outcome").Value(outcome)
}
func telemetryResult(status protocol.BrowserExploreStatus) *protocol.StepResultBody {
	return &protocol.StepResultBody{StepID: step1, Executor: protocol.ExecutorObserver, ImageID: "image-fixture", VMHealth: protocol.VMHealthOk, BrowserExploration: &protocol.BrowserExploreResult{Status: status, DurationMs: 123, CliCalls: 2, ActionsCompleted: 1, Truncated: true, Snapshot: "PRIVATE_SNAPSHOT", Candidates: []protocol.BrowserExploreCandidate{{Ref: "e1", Selector: "PRIVATE_SELECTOR"}}}}
}

// Observed, blocked, timeout and unavailable used to have indistinguishable
// completion logs and only the legacy VM-health outcome=ok metric.
func TestBrowserTelemetryKeepsDistinctOutcomesCountsAndSafeIDs(t *testing.T) {
	f := newBrowserTelemetry(t)
	for _, status := range []protocol.BrowserExploreStatus{protocol.BrowserExploreStatusObserved, protocol.BrowserExploreStatusBlocked, protocol.BrowserExploreStatusTimeout, protocol.BrowserExploreStatusUnavailable, protocol.BrowserExploreStatusFailed} {
		f.a.sendStepResult(context.Background(), f.c, "browser.explore", telemetryResult(status))
		got := f.completion(t)
		for key, want := range map[string]any{"cell": "cell-fixture", "claim": "claim-fixture", "run": "run-fixture", "step": step1, "status": string(status), "durationMs": float64(123), "cliCalls": float64(2), "actionsCompleted": float64(1), "candidateCount": float64(1), "truncated": true} {
			if got[key] != want {
				t.Fatalf("%s=%v want %v", key, got[key], want)
			}
		}
		if f.count(string(status)) != 1 {
			t.Fatalf("dedicated outcome %s not counted", status)
		}
	}
	if f.a.m.steps.Value("browser.explore", "ok") != 5 {
		t.Fatal("legacy VM-health counter changed")
	}
	if strings.Contains(f.logs.String(), "PRIVATE_") {
		t.Fatal("page content reached logs")
	}
}
func TestBrowserTelemetryCannotCreateUnboundedStatusLabels(t *testing.T) {
	f := newBrowserTelemetry(t)
	f.a.sendStepResult(context.Background(), f.c, "browser.explore", telemetryResult("PRIVATE_STATUS"))
	got := f.completion(t)
	if got["status"] != "failed" || f.count("failed") != 1 {
		t.Fatalf("unknown status was not normalized: %v", got)
	}
	var scrape bytes.Buffer
	_ = f.reg.WriteText(&scrape)
	if strings.Contains(scrape.String(), "PRIVATE_STATUS") {
		t.Fatal("unbounded outcome label")
	}
}

type telemetryFailureRunner func(context.Context, browser.RunSpec, []byte, io.Writer) error

func (f telemetryFailureRunner) Run(ctx context.Context, spec browser.RunSpec, job []byte, w io.Writer) error {
	return f(ctx, spec, job, w)
}
func TestBrowserTelemetryErrorsHaveOnlyClosedReasonAndMeasuredLocalDuration(t *testing.T) {
	for _, tc := range []struct {
		name           string
		err            error
		status, reason string
	}{{"runner", errors.New("PRIVATE_ERROR_OUTPUT"), "unavailable", "runner_error"}, {"deadline", fmt.Errorf("PRIVATE_ERROR_OUTPUT: %w", context.DeadlineExceeded), "timeout", "deadline_exceeded"}, {"refused", fmt.Errorf("PRIVATE_ERROR_OUTPUT: %w", browser.ErrJobRefused), "blocked", "job_refused"}} {
		t.Run(tc.name, func(t *testing.T) {
			f := newBrowserTelemetry(t)
			f.a.cfg.BrowserExplore = telemetryFailureRunner(func(context.Context, browser.RunSpec, []byte, io.Writer) error {
				f.clk.Advance(45 * time.Millisecond)
				return tc.err
			})
			f.a.runBrowserExplore(context.Background(), f.c, explorationBody())
			got := f.completion(t)
			if got["reason"] != tc.reason || got["durationMs"] != float64(45) || got["status"] != tc.status {
				t.Fatalf("completion %v", got)
			}
			if strings.Contains(f.logs.String(), "PRIVATE_ERROR_OUTPUT") {
				t.Fatal("raw error logged")
			}
			if f.count(tc.status) != 1 {
				t.Fatal("failed execution not counted")
			}
			wire := f.conn.next(t, isResult(step1)).(*protocol.StepResultBody)
			if string(wire.BrowserExploration.Status) != tc.status || wire.BrowserExploration.DurationMs != 0 {
				t.Fatal("diagnostic changed wire result")
			}
		})
	}
}
func TestBrowserTelemetryMissingTargetHasSafeReason(t *testing.T) {
	f := newBrowserTelemetry(t)
	f.c.Acquire.Expose = nil
	f.a.runBrowserExplore(context.Background(), f.c, explorationBody())
	got := f.completion(t)
	if got["reason"] != "target_not_exposed" || got["status"] != "unavailable" {
		t.Fatalf("missing target %v", got)
	}
}

func TestBrowserTelemetryCancelledExplorerDoesNotLogItsRawErrorOrCountCompletion(t *testing.T) {
	f := newBrowserTelemetry(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.a.cfg.BrowserExplore = telemetryFailureRunner(func(context.Context, browser.RunSpec, []byte, io.Writer) error {
		cancel()
		return errors.New("PRIVATE_CANCELLED_OUTPUT")
	})
	f.a.runBrowserExplore(ctx, f.c, explorationBody())
	if strings.Contains(f.logs.String(), "PRIVATE_CANCELLED_OUTPUT") {
		t.Fatal("cancelled explorer leaked raw error")
	}
	if f.a.m.steps.Value("browser.explore", "cancelled") != 1 {
		t.Fatal("legacy cancellation not counted")
	}
	if f.conn.attempts(isResult(step1)) != 0 {
		t.Fatal("cancelled operation delivered a result")
	}
	if f.count("observed") != 0 || f.count("unavailable") != 0 {
		t.Fatal("cancelled operation counted as completion")
	}
}
func TestBrowserTelemetryReasonFieldsStayClosed(t *testing.T) {
	f := newBrowserTelemetry(t)
	f.a.sendStepResult(context.Background(), f.c, "browser.explore", telemetryResult(protocol.BrowserExploreStatusFailed), browserExploreDiagnostic{durationMs: 12, reason: "PRIVATE_REASON"})
	got := f.completion(t)
	if got["reason"] != "runner_error" || strings.Contains(f.logs.String(), "PRIVATE_REASON") {
		t.Fatalf("untrusted reason: %v", got)
	}
}
