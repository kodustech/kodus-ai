//go:build unix

package agent

import (
	"context"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type recSealer struct {
	mu sync.Mutex
	n  int
}

func (r *recSealer) Seal(context.Context) error { r.mu.Lock(); r.n++; r.mu.Unlock(); return nil }
func (r *recSealer) count() int                  { r.mu.Lock(); defer r.mu.Unlock(); return r.n }

// A fleet cell with no claim live acks cell.seal and starts the host's seal once.
func TestCellSealOnAFleetCellStartsTheHostSeal(t *testing.T) {
	s := &recSealer{}
	h := newHarness(t, func(c *Config) { c.HostSeal = s })
	if err := h.handle("", protocol.MessageTypeCellSeal, &protocol.CellSealBody{}); err != nil {
		t.Fatal(err)
	}
	h.a.Wait()
	if s.count() != 1 {
		t.Fatalf("seal started %d times", s.count())
	}
}

// A cell that is not installed in fleet mode refuses, and starts nothing.
func TestCellSealIsRefusedOnACellThatIsNotAFleetHost(t *testing.T) {
	h := newHarness(t)
	if got := nackCode(h.handle("", protocol.MessageTypeCellSeal, &protocol.CellSealBody{})); got != "not_fleet" {
		t.Fatalf("nack %q, want not_fleet", got)
	}
}

// A claim that is live holds the host: the cell refuses and the seal does not start.
func TestCellSealIsRefusedWhileAClaimIsLive(t *testing.T) {
	s := &recSealer{}
	h := newHarness(t, func(c *Config) { c.HostSeal = s })
	h.ready("claim-1")
	if got := nackCode(h.handle("", protocol.MessageTypeCellSeal, &protocol.CellSealBody{})); got != "claim_live" {
		t.Fatalf("nack %q, want claim_live", got)
	}
	h.a.Wait()
	if s.count() != 0 {
		t.Fatalf("seal started with a claim live")
	}
}
