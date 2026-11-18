package agent

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// ceilingBudget is a docker-gvisor cell under claim limits: a claim is
// counted at its whole 12 GB ceiling, booting or ready, until its driver
// lowers the ceiling (ReadyMemory).
type ceilingBudget struct{}

func (ceilingBudget) ClaimMemory(driver.ClaimSize) driver.ClaimMemory {
	return driver.ClaimMemory{BootMB: 12_288, ReadyMB: 12_288}
}

type settler struct {
	mu    sync.Mutex
	mb    int
	err   error
	asked []string
}

func (s *settler) SettleReady(_ context.Context, ref driver.MachineRef) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.asked = append(s.asked, ref.MachineID)
	return s.mb, s.err
}

func withCeiling(s *settler) func(*Config) {
	return func(c *Config) {
		c.Parts.Memory, c.Parts.ReadyMemory = ceilingBudget{}, s
		c.MemoryAllocatableMB = 15_000
	}
}

// The two sides of a Run on a cell with room for one build and a little
// more: the first is counted at its build ceiling while it builds; once
// ready its driver lowers what it may use, and the second side's build fits
// next to it (15 000 - 2 560 >= 12 288; unsettled, 2 712 MB were free).
func TestTheSecondSideBuildsOnceTheFirstSettlesReady(t *testing.T) {
	s := &settler{mb: 2_560}
	h := newHarness(t, withCeiling(s))
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureCellMemory}})
	h.ready("claim-base")
	if got := h.a.mem.Count("claim-base"); got != 2_560 {
		t.Fatalf("a settled ready claim is counted at %d MB", got)
	}
	if len(s.asked) != 1 || s.asked[0] == "" {
		t.Fatalf("settle asked for %v", s.asked)
	}
	h.ready("claim-pr", func(b *protocol.ClaimAcquireBody) { b.Side = protocol.SidePr })
	if got := h.a.mem.Committed(); got != 2_560+2_560 {
		t.Fatalf("committed = %d", got)
	}
}

// A ceiling the driver could not lower is not counted lower: the claim
// keeps its whole ceiling, and the next build waits.
func TestAReadyClaimTheDriverCouldNotSettleKeepsItsCeiling(t *testing.T) {
	s := &settler{err: errors.New("memory.max refused")}
	h := newHarness(t, withCeiling(s))
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureCellMemory}})
	h.ready("claim-base")
	if got := h.a.mem.Count("claim-base"); got != 12_288 {
		t.Fatalf("an unsettled ready claim is counted at %d MB", got)
	}
	b := h.acquireBody()
	b.Side = protocol.SidePr
	if code := nackCode(h.handle("claim-pr", protocol.MessageTypeClaimAcquire, b)); code != "no_capacity" {
		t.Fatalf("the second build = %q, want no_capacity", code)
	}
}

// 0 is a driver with nothing to lower (no resizable budget): ReadyMB.
func TestASettlerWithNothingToLowerLeavesTheReadySize(t *testing.T) {
	h := newHarness(t, withCeiling(&settler{}))
	h.ready("claim-base")
	if got := h.a.mem.Count("claim-base"); got != 12_288 {
		t.Fatalf("counted at %d MB", got)
	}
}
