package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
	"strings"
	"testing"
	"time"
)

func exploreRequest() protocol.BrowserExploreRequest {
	path := "/"
	return protocol.BrowserExploreRequest{Steps: []protocol.BrowserExploreStep{{Goto: &path}}, Viewport: protocol.BrowserProbeViewport{Width: 640, Height: 480}, TimeoutMs: 1000}
}
func explorationJSON(t *testing.T) []byte {
	t.Helper()
	raw, _ := json.Marshal(protocol.BrowserExploreResult{Status: protocol.BrowserExploreStatusObserved, Snapshot: "Name ghs_download", Candidates: []protocol.BrowserExploreCandidate{{Ref: "e1", Selector: `[id="name"]`}}, ActionsCompleted: 1, DurationMs: 10, CliCalls: 4})
	return raw
}
func TestExplorerUsesDistinctJobAndReturnsNoProbeOrArtifacts(t *testing.T) {
	r := &fakeRunner{stream: tarOf(t, entry{"exploration.json", explorationJSON(t)})}
	got, err := (Explorer{Runner: r, Redactor: redact.New(redact.Known{Value: "ghs_download", Label: "download"})}).Run(context.Background(), RunSpec{Port: 3000}, exploreRequest())
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != protocol.BrowserExploreStatusObserved || strings.Contains(got.Snapshot, "ghs_download") {
		t.Fatalf("result %+v", got)
	}
	var job map[string]any
	_ = json.Unmarshal(r.job, &job)
	if job["mode"] != "explore" || job["request"] == nil || job["steps"] != nil {
		t.Fatalf("mixed replay job %s", r.job)
	}
	if job["origin"] != "http://app.kody.internal:3000" {
		t.Fatalf("origin %v", job["origin"])
	}
}
func TestExplorerRefusesUnexpectedDuplicateOrOversizedTarOutput(t *testing.T) {
	for _, stream := range [][]byte{tarOf(t, entry{"result.json", explorationJSON(t)}), tarOf(t, entry{"exploration.json", explorationJSON(t)}, entry{"exploration.json", explorationJSON(t)}), tarOf(t, entry{"../exploration.json", explorationJSON(t)}), bytes.Repeat([]byte("x"), 600<<10)} {
		if _, err := (Explorer{Runner: &fakeRunner{stream: stream}}).Run(context.Background(), RunSpec{Port: 3000}, exploreRequest()); err == nil {
			t.Fatal("unsafe stream accepted")
		}
	}
}
func TestExplorerRejectsDuplicateJSONUnknownFieldsAndMissingMetrics(t *testing.T) {
	for _, raw := range []string{`{"status":"observed","status":"blocked","snapshot":"","candidates":[],"actionsCompleted":0,"durationMs":1,"cliCalls":1,"truncated":false}`, `{"status":"observed","snapshot":"","candidates":[],"actionsCompleted":0,"durationMs":1,"cliCalls":1,"truncated":false,"probe":{}}`, `{"status":"observed","snapshot":"","candidates":[]}`} {
		if _, err := (Explorer{Runner: &fakeRunner{stream: tarOf(t, entry{"exploration.json", []byte(raw)})}}).Run(context.Background(), RunSpec{Port: 3000}, exploreRequest()); err == nil {
			t.Fatal("invalid JSON result accepted")
		}
	}
}
func TestExplorerDropsCandidateWhoseSelectorContainsASecret(t *testing.T) {
	var result protocol.BrowserExploreResult
	_ = json.Unmarshal(explorationJSON(t), &result)
	result.Candidates[0].Selector = `[id="ghs_download"]`
	raw, _ := json.Marshal(result)
	got, err := (Explorer{Runner: &fakeRunner{stream: tarOf(t, entry{"exploration.json", raw})}, Redactor: redact.New(redact.Known{Value: "ghs_download", Label: "download"})}).Run(context.Background(), RunSpec{Port: 3000}, exploreRequest())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Candidates) != 0 || !got.Truncated {
		t.Fatalf("selector changed or leaked: %+v", got)
	}
}
func TestExplorerChecksPrefixBeforeStartingRunner(t *testing.T) {
	r := &fakeRunner{}
	request := exploreRequest()
	bad := "@e1"
	request.Steps = append(request.Steps, protocol.BrowserExploreStep{Click: &bad})
	if _, err := (Explorer{Runner: r}).Run(context.Background(), RunSpec{Port: 3000}, request); err == nil || r.job != nil {
		t.Fatal("bad prefix reached runner")
	}
}

func TestExplorerPinsActionAndCleanupDeadline(t *testing.T) {
	r := &fakeRunner{stream: tarOf(t, entry{"exploration.json", explorationJSON(t)})}
	request := exploreRequest()
	request.TimeoutMs = 30000
	if _, err := (Explorer{Runner: r}).Run(context.Background(), RunSpec{Port: 3000}, request); err != nil {
		t.Fatal(err)
	}
	if r.spec.Deadline != 40*time.Second {
		t.Fatalf("deadline %v", r.spec.Deadline)
	}
}

func TestExplorerCanonicalizesHTTPDefaultPort(t *testing.T) {
	r := &fakeRunner{stream: tarOf(t, entry{"exploration.json", explorationJSON(t)})}
	if _, err := (Explorer{Runner: r}).Run(context.Background(), RunSpec{Port: 80}, exploreRequest()); err != nil {
		t.Fatal(err)
	}
	var job map[string]any
	_ = json.Unmarshal(r.job, &job)
	if job["origin"] != "http://app.kody.internal" {
		t.Fatalf("noncanonical origin %v", job["origin"])
	}
}
