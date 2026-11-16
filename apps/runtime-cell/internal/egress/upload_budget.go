package egress

import (
	"log/slog"
	"sync"
	"sync/atomic"
)

// uploadBudget is D8 (docs/runtime/egress-allowlist.md §11) in observe-only
// mode: the bytes each claim sends out, over every connection it let
// through, against one budget per claim. Installs download; what leaves is
// headers and the odd request body, so a claim far past the budget is
// either an upload the app needs or an exfiltration. Crossing it is logged
// once per claim (egress.upload_budget.exceeded) and counted; nothing is
// cut until the measured numbers set the budget.
type uploadBudget struct {
	limit   int64
	log     *slog.Logger
	mu      sync.Mutex
	byClaim map[string]*claimUpload
	crossed atomic.Int64
}

type claimUpload struct {
	sent     atomic.Int64
	reported atomic.Bool
}

func newUploadBudget(limit int64, log *slog.Logger) *uploadBudget {
	return &uploadBudget{limit: limit, log: log, byClaim: map[string]*claimUpload{}}
}

// of is the claim's counter; nil when the budget is off.
func (u *uploadBudget) of(claim string) *claimUpload {
	if u == nil || u.limit <= 0 || claim == "" {
		return nil
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	c := u.byClaim[claim]
	if c == nil {
		c = &claimUpload{}
		u.byClaim[claim] = c
	}
	return c
}

// add counts n bytes the claim sent; the first time the claim's total
// passes the budget it is logged and counted.
func (u *uploadBudget) add(claim, host string, c *claimUpload, n int64) {
	if c == nil {
		return
	}
	if total := c.sent.Add(n); total > u.limit && c.reported.CompareAndSwap(false, true) {
		u.crossed.Add(1)
		u.log.Warn("egress.upload_budget.exceeded", "claim", claim, "host", host, "bytesUp", total, "budget", u.limit, "mode", "observe")
	}
}

// forget drops a claim's counter (its policy is gone).
func (u *uploadBudget) forget(claim string) {
	if u == nil {
		return
	}
	u.mu.Lock()
	delete(u.byClaim, claim)
	u.mu.Unlock()
}

// Sent is how many bytes the claim sent out so far (tests, logs); zero with
// the budget off.
func (u *uploadBudget) Sent(claim string) int64 {
	if c := u.of(claim); c != nil {
		return c.sent.Load()
	}
	return 0
}
