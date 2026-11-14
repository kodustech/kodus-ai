package agent

import (
	"context"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// claim.progress: where a claim's preparation is, so the product shows a
// long setup as it runs instead of a silent "setting up". Best effort: one
// try, never waited on, never failing the claim.
const (
	progressLines    = 40
	progressInterval = 3 * time.Second
	progressTimeout  = 5 * time.Second
)

func (a *Agent) progress(c *claims.Claim, phase string, state protocol.ClaimProgressBodyState, ms *int64, lines []string) {
	conn := a.currentConn()
	if conn == nil {
		return
	}
	body := &protocol.ClaimProgressBody{Phase: phase, State: state, At: protocol.FormatTime(a.clock.Now()), Ms: ms}
	if len(lines) > 0 {
		r := a.claimRedactor(c)
		body.Lines = make([]string, 0, len(lines))
		for _, l := range lines {
			out, _ := r.String(l)
			out, _ = redact.Clip(out, redact.MaxBundleLine)
			body.Lines = append(body.Lines, out)
		}
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), progressTimeout)
		defer cancel()
		_ = conn.Request(ctx, protocol.Header{ID: a.cfg.NewID(), ClaimID: c.ID}, body)
	}()
}

// progressTail keeps the last lines a boot step printed and sends them at
// most every progressInterval while the step runs (driver.WithOutput).
type progressTail struct {
	mu    sync.Mutex
	lines []string
	last  time.Time
	send  func(lines []string)
	now   func() time.Time
}

func (p *progressTail) line(l string) {
	p.mu.Lock()
	p.lines = append(p.lines, l)
	if len(p.lines) > progressLines {
		p.lines = p.lines[len(p.lines)-progressLines:]
	}
	if p.now().Sub(p.last) < progressInterval {
		p.mu.Unlock()
		return
	}
	p.last = p.now()
	out := append([]string(nil), p.lines...)
	p.mu.Unlock()
	p.send(out)
}

func (p *progressTail) snapshot() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.lines...)
}
