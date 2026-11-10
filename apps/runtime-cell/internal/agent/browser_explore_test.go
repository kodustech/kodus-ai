package agent

import (
	"archive/tar"
	"context"
	"encoding/json"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/browser"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type explorationRunner struct {
	mu    sync.Mutex
	calls int
	spec  browser.RunSpec
	job   []byte
}

func (r *explorationRunner) Run(_ context.Context, spec browser.RunSpec, job []byte, out io.Writer) error {
	r.mu.Lock()
	r.calls++
	r.spec = spec
	r.job = append([]byte(nil), job...)
	r.mu.Unlock()
	result, _ := json.Marshal(protocol.BrowserExploreResult{Status: protocol.BrowserExploreStatusObserved, Snapshot: "Name ghs_download", Candidates: []protocol.BrowserExploreCandidate{}, ActionsCompleted: 1, DurationMs: 2, CliCalls: 2})
	tw := tar.NewWriter(out)
	if err := tw.WriteHeader(&tar.Header{Name: "exploration.json", Mode: 0o644, Size: int64(len(result)), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	if _, err := tw.Write(result); err != nil {
		return err
	}
	return tw.Close()
}
func explorationBody() *protocol.BrowserExploreBody {
	path := "/"
	return &protocol.BrowserExploreBody{StepID: step1, Request: protocol.BrowserExploreRequest{Steps: []protocol.BrowserExploreStep{{Goto: &path}}, Viewport: protocol.BrowserProbeViewport{Width: 640, Height: 480}, TimeoutMs: 1000}}
}
func TestBrowserExploreFeatureIsOnlyAdvertisedWithExplicitRunner(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		h := newHarness(t, func(c *Config) {
			if enabled {
				c.BrowserExplore = &explorationRunner{}
			}
		})
		if slices.Contains(h.a.Hello().Features, protocol.FeatureBrowserExplore) != enabled {
			t.Fatalf("enabled %v features %v", enabled, h.a.Hello().Features)
		}
	}
}
func TestBrowserExploreRunsOnlyAcceptedBaseRuntimeClaimAndReturnsDistinctResult(t *testing.T) {
	runner := &explorationRunner{}
	h := newHarness(t, func(c *Config) { c.BrowserExplore = runner })
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureBrowserExplore}})
	h.ready("claim-1", withApp)
	if err := h.handle("claim-1", protocol.MessageTypeBrowserExplore, explorationBody()); err != nil {
		t.Fatal(err)
	}
	result := h.conn.next(t, isResult(step1)).(*protocol.StepResultBody)
	if result.BrowserExploration == nil || result.Probe != nil || result.Exec != nil || result.Executor != protocol.ExecutorObserver || strings.Contains(result.BrowserExploration.Snapshot, "ghs_download") {
		t.Fatalf("result %+v", result)
	}
	if err := h.handle("claim-1", protocol.MessageTypeBrowserExplore, explorationBody()); err != nil {
		t.Fatal(err)
	}
	runner.mu.Lock()
	calls := runner.calls
	runner.mu.Unlock()
	if calls != 1 {
		t.Fatalf("duplicate ran %d times", calls)
	}
	conflict := explorationBody()
	path := "/different"
	conflict.Request.Steps[0].Goto = &path
	if code := nackCode(h.handle("claim-1", protocol.MessageTypeBrowserExplore, conflict)); code != "step_conflict" {
		t.Fatalf("conflict %s", code)
	}
}
func TestBrowserExploreRefusesOldHubDisabledRunnerAndWrongClaimScope(t *testing.T) {
	for _, scenario := range []string{"disabled", "old-hub", "pr", "setup"} {
		t.Run(scenario, func(t *testing.T) {
			runner := &explorationRunner{}
			h := newHarness(t, func(c *Config) {
				if scenario != "disabled" {
					c.BrowserExplore = runner
				}
			})
			if scenario != "old-hub" {
				h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureBrowserExplore}})
			}
			h.ready("claim-1", withApp, func(b *protocol.ClaimAcquireBody) {
				if scenario == "pr" {
					b.Side = protocol.SidePr
				}
				if scenario == "setup" {
					b.Consumer = protocol.ConsumerSetup
					b.HardExpiresAt = protocol.FormatTime(h.clk.Now().Add(30 * time.Minute))
				}
			})
			if err := h.handle("claim-1", protocol.MessageTypeBrowserExplore, explorationBody()); err == nil {
				t.Fatal("unsafe scope accepted")
			}
			runner.mu.Lock()
			calls := runner.calls
			runner.mu.Unlock()
			if calls != 0 {
				t.Fatal("unsafe scope reached runner")
			}
		})
	}
}

type blockedExploreRunner struct {
	entered chan struct{}
	exited  chan struct{}
}

func (r *blockedExploreRunner) Run(ctx context.Context, _ browser.RunSpec, _ []byte, _ io.Writer) error {
	close(r.entered)
	<-ctx.Done()
	close(r.exited)
	return ctx.Err()
}
func TestBrowserExploreCapacityCancellationAndRelease(t *testing.T) {
	for _, release := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "release"}[release], func(t *testing.T) {
			r := &blockedExploreRunner{make(chan struct{}), make(chan struct{})}
			h := newHarness(t, func(c *Config) { c.BrowserExplore = r; c.MaxClaimSteps = 1 })
			h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureBrowserExplore}})
			h.ready("claim-1", withApp)
			if err := h.handle("claim-1", protocol.MessageTypeBrowserExplore, explorationBody()); err != nil {
				t.Fatal(err)
			}
			select {
			case <-r.entered:
			case <-time.After(time.Second):
				t.Fatal("runner did not start")
			}
			second := explorationBody()
			second.StepID = "ed399ca5-9922-402c-af1a-e7829822c666"
			if code := nackCode(h.handle("claim-1", protocol.MessageTypeBrowserExplore, second)); code != "step_capacity" {
				t.Fatalf("capacity %s", code)
			}
			var err error
			if release {
				err = h.handle("claim-1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{})
			} else {
				err = h.handle("claim-1", protocol.MessageTypeExecCancel, &protocol.ExecCancelBody{StepID: step1})
			}
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-r.exited:
			case <-time.After(time.Second):
				t.Fatal("runner was not cancelled")
			}
			h.a.Wait()
			if got := h.conn.attempts(isResult(step1)); got != 0 {
				t.Fatalf("cancelled exploration sent %d results", got)
			}
		})
	}
}
