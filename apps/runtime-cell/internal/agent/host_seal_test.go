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
func (r *recSealer) count() int                 { r.mu.Lock(); defer r.mu.Unlock(); return r.n }

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

// dev, 2026-11-26: the setup claim was released once its bake was acked and the
// template's seal came 4 minutes later, while the bake still exported its images.
// The seal stopped the cell, the bake died and the template was saved with an
// empty catalog: every host made from it built cold. A bake in progress holds
// the host as a live claim does.
func TestCellSealIsRefusedWhileABakeIsInProgress(t *testing.T) {
	s := &recSealer{}
	h := newHarness(t, func(c *Config) { c.HostSeal = s })
	finish, ok := h.a.origin.Reserve("org-1", "env-1")
	if !ok {
		t.Fatal("no reservation")
	}
	if got := nackCode(h.handle("", protocol.MessageTypeCellSeal, &protocol.CellSealBody{})); got != "bake_running" {
		t.Fatalf("nack %q, want bake_running", got)
	}
	h.a.Wait()
	if s.count() != 0 {
		t.Fatalf("seal started with a bake in progress")
	}
	finish()
	if err := h.handle("", protocol.MessageTypeCellSeal, &protocol.CellSealBody{}); err != nil {
		t.Fatalf("seal refused once the bake ended: %v", err)
	}
	h.a.Wait()
	if s.count() != 1 {
		t.Fatalf("seal started %d times after the bake ended", s.count())
	}
}

// The seal saves the template's disk as it is, so the cell discards the unused
// blocks first (fstrim): the trim runs before the seal starts, and a trim that
// fails does not stop the seal.
func TestCellSealTrimsTheBuildStateDiskBeforeSealing(t *testing.T) {
	for _, trimErr := range []error{nil, context.DeadlineExceeded} {
		var order []string
		s := &orderSealer{order: &order}
		h := newHarness(t, func(c *Config) {
			c.HostSeal = s
			c.DiskWatch = &DiskWatch{
				Free: func() (uint64, error) { return 1 << 40, nil }, MinFreeBytes: 1 << 30,
				Trim: func(context.Context) (uint64, error) { order = append(order, "fstrim"); return 5 << 30, trimErr },
			}
		})
		if err := h.handle("", protocol.MessageTypeCellSeal, &protocol.CellSealBody{}); err != nil {
			t.Fatal(err)
		}
		h.a.Wait()
		if len(order) != 2 || order[0] != "fstrim" || order[1] != "seal" {
			t.Fatalf("trimErr=%v: order %v, want [fstrim seal]", trimErr, order)
		}
	}
}

type orderSealer struct{ order *[]string }

func (o *orderSealer) Seal(context.Context) error { *o.order = append(*o.order, "seal"); return nil }
