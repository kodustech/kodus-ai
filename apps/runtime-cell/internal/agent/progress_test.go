package agent

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
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

func isProgress(f any) bool { _, ok := f.(*protocol.ClaimProgressBody); return ok }

func progressText(b *protocol.ClaimProgressBody) string {
	parts := append([]string(nil), b.Lines...)
	for _, p := range b.Phases {
		parts = append(parts, p.Name)
	}
	return strings.Join(parts, "\n")
}

// claim.progress leaves the cell through the redaction every claim frame
// takes (redactOutbound, the claim's own redactor), lines and phase names.
// It used to build a redactor of its own from the claim's sources, so a
// value the claim's redactor holds and those sources no longer give (a key
// forgotten at cleanup) went out in a progress line.
func TestProgressLeavesTheCellThroughTheClaimFramesRedaction(t *testing.T) {
	const kept = "kept-secret-9a7e3c51"
	h := newHarness(t)
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureBootPhases}})
	c := claims.New("claim-1", protocol.ClaimAcquireBody{ImageID: "img", Expose: []protocol.Expose{}}, h.a.log, h.clk.Now())
	c.SetRedactor(redact.New(redact.Known{Label: "test", Value: kept}))
	h.a.progressWith(c, "compose", protocol.ClaimProgressBodyStateStarted, nil, []string{"echo " + kept}, []driver.BootPhase{{Name: "curl " + kept, Ms: 1}})
	f := h.conn.next(t, isProgress).(*protocol.ClaimProgressBody)
	if len(f.Lines) != 1 || len(f.Phases) != 1 {
		t.Fatalf("progress %+v", f)
	}
	if strings.Contains(progressText(f), kept) {
		t.Fatalf("a value the claim's redactor masks left in progress: %q", progressText(f))
	}
}

// Before its redactor is set (the preparation, when progress goes out), a
// progress line is still masked with every download token of the claim.
func TestProgressDuringPreparationMasksTheDownloadTokens(t *testing.T) {
	const own, other = "tok-own-5f1c9a7e", "tok-api-77d0b2c4"
	h := newHarness(t)
	c := claims.New("claim-1", protocol.ClaimAcquireBody{
		ImageID: "img", Expose: []protocol.Expose{}, RepoToken: own,
		Repos: []protocol.ClaimAcquireBodyReposItem{{Alias: "api", Repo: protocol.RepoRef{FullName: "acme/api"}, Sha: strings.Repeat("a", 40), RepoToken: other}},
	}, h.a.log, h.clk.Now())
	h.a.progress(c, "fetch", protocol.ClaimProgressBodyStateDone, nil, []string{"git clone https://x:" + own + "@h/r", "and " + other})
	f := h.conn.next(t, isProgress).(*protocol.ClaimProgressBody)
	if got := progressText(f); strings.Contains(got, own) || strings.Contains(got, other) {
		t.Fatalf("a download token left in progress: %q", got)
	}
}

// blockingConn holds every request until release is closed or the request's
// context ends.
type blockingConn struct {
	entered chan struct{}
	release chan struct{}
}

func (b *blockingConn) Request(ctx context.Context, _ protocol.Header, _ any) error {
	b.entered <- struct{}{}
	select {
	case <-b.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Wait (the end of Run) returns only once a progress frame in flight was
// sent or dropped. It used to go out on a goroutine nobody waited for.
func TestWaitReturnsOnlyAfterInFlightProgressIsSentOrDropped(t *testing.T) {
	h := newHarness(t)
	conn := &blockingConn{entered: make(chan struct{}, 1), release: make(chan struct{})}
	h.a.mu.Lock()
	h.a.conn = conn
	h.a.mu.Unlock()
	c := claims.New("claim-1", protocol.ClaimAcquireBody{ImageID: "img", Expose: []protocol.Expose{}}, h.a.log, h.clk.Now())
	h.a.progress(c, "fetch", protocol.ClaimProgressBodyStateStarted, nil, nil)
	select {
	case <-conn.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the progress frame was never sent")
	}
	waited := make(chan struct{})
	go func() { h.a.Wait(); close(waited) }()
	select {
	case <-waited:
		t.Fatal("Wait returned while a progress frame was in flight")
	case <-time.After(50 * time.Millisecond):
	}
	close(conn.release)
	select {
	case <-waited:
	case <-time.After(5 * time.Second):
		t.Fatal("Wait did not return once the progress frame was sent")
	}
}
