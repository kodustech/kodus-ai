package agent

import (
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// A claim of consumer suite (docs/runtime/e2e-suites.md section 4) is one shard of the repository's own e2e suite on
// the PR (or main) build. Its machines live the PR build's 45 min plus the suite run's 60 min total
// (HARD_EXPIRY_MINUTES.suite), where the default ceiling used to nack it ceiling_exceeded.
func TestASuiteClaimTakesItsCeilingAndNoMore(t *testing.T) {
	h := newHarness(t)
	b := h.acquireBody()
	b.Consumer = protocol.ConsumerSuite
	b.Side = protocol.SidePr
	b.HardExpiresAt = protocol.FormatTime(h.clk.Now().Add(105 * time.Minute))
	if err := h.handle("claim-s1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatalf("a suite claim of 105 min: %v", err)
	}
	b.HardExpiresAt = protocol.FormatTime(h.clk.Now().Add(110 * time.Minute))
	if code := nackCode(h.handle("claim-s2", protocol.MessageTypeClaimAcquire, b)); code != "ceiling_exceeded" {
		t.Fatalf("a suite claim past 105 min: %q", code)
	}
}

// A suite shard is a PR-side claim like a Run's: it is never a diagnostic hold and never seeds a cache.
func TestASuiteClaimCannotHoldForDiagnosisOrSeedACache(t *testing.T) {
	h := newHarness(t)
	yes := true
	b := h.acquireBody()
	b.Consumer, b.Side = protocol.ConsumerSuite, protocol.SidePr
	b.HardExpiresAt = protocol.FormatTime(h.clk.Now().Add(60 * time.Minute))
	b.DiagnosticHold = &yes
	if code := nackCode(h.handle("claim-s3", protocol.MessageTypeClaimAcquire, b)); code != "diagnostic_hold_refused" {
		t.Fatalf("diagnostic hold on a suite claim: %q", code)
	}
	b.DiagnosticHold, b.SeedsCache = nil, &yes
	if code := nackCode(h.handle("claim-s4", protocol.MessageTypeClaimAcquire, b)); code != "seeds_cache_refused" {
		t.Fatalf("seedsCache on a suite claim: %q", code)
	}
}
