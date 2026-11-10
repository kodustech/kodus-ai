package redact

import (
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"strings"
	"testing"
)

func TestExplorationLastBarrierRedactsClipsAndDropsSecretSelector(t *testing.T) {
	role := "ghs_private"
	name := strings.Repeat("ghs_private", 200)
	b := &protocol.StepResultBody{BrowserExploration: &protocol.BrowserExploreResult{Status: protocol.BrowserExploreStatusObserved, Snapshot: strings.Repeat("ghs_private", 1000), Candidates: []protocol.BrowserExploreCandidate{{Ref: "e1", Selector: `[id="ghs_private"]`}, {Ref: "e2", Selector: `[id="name"]`, Role: &role, Name: &name}}}}
	n := New(Known{Value: "ghs_private", Label: "download"}).StepResult(b)
	out := b.BrowserExploration
	if n == 0 || strings.Contains(out.Snapshot, "ghs_private") || len(out.Snapshot) > 8000 || len(out.Candidates) != 1 || out.Candidates[0].Ref != "e2" || !out.Truncated {
		t.Fatalf("result %+v", out)
	}
	if len(*out.Candidates[0].Role) > 64 || len(*out.Candidates[0].Name) > 256 {
		t.Fatal("redaction escaped metadata caps")
	}
	if b.Redactions == nil || *b.Redactions != int64(n) {
		t.Fatal("missing count")
	}
}
func TestExplorationPreservesLocallyRecordedRedactionsAndCanaryData(t *testing.T) {
	prior := int64(5)
	b := &protocol.StepResultBody{Redactions: &prior, BrowserExploration: &protocol.BrowserExploreResult{Snapshot: "unique-canary-data", Candidates: []protocol.BrowserExploreCandidate{}}}
	New().StepResult(b)
	if b.Redactions == nil || *b.Redactions != 5 || b.BrowserExploration.Snapshot != "unique-canary-data" {
		t.Fatalf("result %+v", b)
	}
}
