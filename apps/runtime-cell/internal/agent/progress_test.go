package agent

import (
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// A claim's preparation tells the hub each phase as it goes (claim.progress),
// so a long setup is never silent: the fetch starts and ends, with its time.
func TestPreparationSendsItsPhases(t *testing.T) {
	h := newHarness(t)
	if err := h.handle("claim-p", protocol.MessageTypeClaimAcquire, h.acquireBody()); err != nil {
		t.Fatal(err)
	}
	isFetchDone := func(f any) bool {
		b, ok := f.(*protocol.ClaimProgressBody)
		return ok && b.Phase == "fetch" && b.State == protocol.ClaimProgressBodyStateDone
	}
	f := h.conn.next(t, isFetchDone).(*protocol.ClaimProgressBody)
	if f.Ms == nil || *f.Ms < 0 {
		t.Fatalf("fetch done without its time: %+v", f)
	}
}

// The tail keeps the last lines and sends at most every interval.
func TestProgressTailThrottlesAndKeepsTheLastLines(t *testing.T) {
	now := time.Date(2026, 11, 4, 17, 0, 0, 0, time.UTC)
	var sent [][]string
	p := &progressTail{now: func() time.Time { return now }, send: func(l []string) { sent = append(sent, l) }}
	for i := 0; i < 100; i++ {
		p.line("line")
	}
	if len(sent) != 1 {
		t.Fatalf("sent %d times within one interval", len(sent))
	}
	now = now.Add(progressInterval)
	p.line("last")
	if len(sent) != 2 || len(sent[1]) != progressLines || sent[1][progressLines-1] != "last" {
		t.Fatalf("second send %d lines", len(sent[len(sent)-1]))
	}
}
