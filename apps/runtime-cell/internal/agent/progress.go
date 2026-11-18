package agent

import (
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildprogress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// claim.progress: where a claim's preparation is, so the product shows a
// long setup as it runs instead of a silent "setting up". Best effort: one
// try (deliverOnce), never waited on by the step, never failing the claim.
const (
	progressLines    = 40
	progressInterval = 3 * time.Second
	progressTimeout  = 5 * time.Second
)

func (a *Agent) progress(c *claims.Claim, phase string, state protocol.ClaimProgressBodyState, ms *int64, lines []string) {
	a.progressWith(c, phase, state, ms, lines, nil)
}

// progressWith is progress with where the boot spent its time so far, for
// a hub that accepts it (a boot the hub stops at its ceiling sends no
// claim.failed: this is what says where it was). Its lines and phase names
// are redacted on the way out, as every claim frame (redactOutbound).
func (a *Agent) progressWith(c *claims.Claim, phase string, state protocol.ClaimProgressBodyState, ms *int64, lines []string, phases []driver.BootPhase) {
	if a.currentConn() == nil {
		return
	}
	body := &protocol.ClaimProgressBody{Phase: phase, State: state, At: protocol.FormatTime(a.clock.Now()), Ms: ms}
	if len(phases) > 0 && a.hubAccepts(protocol.FeatureBootPhases) {
		body.Phases = bootPhasesToProtocol(phases)
	}
	if len(lines) > 0 {
		body.Lines = slices.Clone(lines)
	}
	a.deliverOnce(c, "claim.progress", body, progressTimeout)
}

// progressTail keeps the last lines a boot step printed and sends them at
// most every progressInterval while the step runs (driver.UpRequest.Output).
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

// livePhases reads a boot's output as it runs into where the time went so
// far: BuildKit's progress of each build (buildprogress), one build after
// the other. The driver ends each build's output with "kodus: <service>
// built in ...", where the next build's steps start again at #1.
type livePhases struct {
	mu   sync.Mutex
	now  func() time.Time
	done []driver.BootPhase
	cur  *buildprogress.Tracker
}

func newLivePhases(now func() time.Time) *livePhases {
	return &livePhases{now: now, cur: buildprogress.NewAt(now)}
}

func (l *livePhases) line(s string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if strings.HasPrefix(s, "kodus: ") && strings.Contains(s, " built in ") {
		l.done = driver.MergePhases(-1, l.done, bootPhasesOf(l.cur.Phases(-1)))
		l.cur = buildprogress.NewAt(l.now)
		return
	}
	l.cur.Line(s)
}

// snapshot is the phases so far, slowest first, at most driver.MaxPhases.
func (l *livePhases) snapshot() []driver.BootPhase {
	l.mu.Lock()
	defer l.mu.Unlock()
	return driver.MergePhases(driver.MaxPhases, l.done, bootPhasesOf(l.cur.Phases(-1)))
}

func bootPhasesOf(ps []buildprogress.Phase) []driver.BootPhase {
	out := make([]driver.BootPhase, 0, len(ps))
	for _, p := range ps {
		out = append(out, driver.BootPhase{Name: p.Name, Ms: p.Ms, Running: p.Running})
	}
	return out
}
