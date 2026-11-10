package agent

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type recPinner struct {
	mu   sync.Mutex
	refs []driver.MachineRef
	err  error
}

func (p *recPinner) PinBakeSource(ref driver.MachineRef) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.refs = append(p.refs, ref)
	return p.err
}

// readySetupClaim acquires claim-1 as a setup claim and waits until it is ready.
func readySetupClaim(t *testing.T, h *harness) {
	t.Helper()
	b := h.acquireBody()
	b.Consumer, b.HardExpiresAt = protocol.ConsumerSetup, protocol.FormatTime(h.clk.Now().Add(40*time.Minute))
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
}

// A driver that bakes from the setup machine gets that machine pinned
// before image.bake is acked, so the release that follows the ack cannot
// take its output away; the bake then names it as its source.
func TestBakePinsTheSetupMachineBeforeTheAck(t *testing.T) {
	pin := &recPinner{}
	h := newHarness(t, func(c *Config) { c.BakePinner = pin })
	readySetupClaim(t, h)
	c, _ := h.a.claims.Get("claim-1")
	workload := c.Machines().Workload

	if err := h.handle("claim-1", protocol.MessageTypeImageBake, &protocol.ImageBakeBody{OrgID: "org-a", EnvironmentID: "env-1", Sha: testSHA, RecipeSha: "r"}); err != nil {
		t.Fatal(err)
	}
	pin.mu.Lock()
	pinned := append([]driver.MachineRef(nil), pin.refs...)
	pin.mu.Unlock()
	if len(pinned) != 1 || pinned[0].MachineID != workload.MachineID {
		t.Fatalf("pinned %+v before the ack, want the workload %s", pinned, workload.MachineID)
	}
	h.a.Wait()
	bakes := h.drv.BakesSnapshot()
	if len(bakes) != 1 || bakes[0].Source.MachineID != workload.MachineID {
		t.Fatalf("bakes %+v, want one from the workload", bakes)
	}
}

// What cannot be pinned is never baked.
func TestBakeIsRefusedWhenTheSetupMachineCannotBePinned(t *testing.T) {
	pin := &recPinner{err: errors.New("gone")}
	h := newHarness(t, func(c *Config) { c.BakePinner = pin })
	readySetupClaim(t, h)
	err := h.handle("claim-1", protocol.MessageTypeImageBake, &protocol.ImageBakeBody{OrgID: "org-a", EnvironmentID: "env-1", Sha: testSHA, RecipeSha: "r"})
	if code := nackCode(err); code != "bake_source" {
		t.Fatalf("image.bake = %v (code %q), want bake_source", err, code)
	}
	// Without a claim there is no machine to bake from either.
	err = h.handle("", protocol.MessageTypeImageBake, &protocol.ImageBakeBody{OrgID: "org-a", EnvironmentID: "env-1", Sha: testSHA, RecipeSha: "r"})
	if code := nackCode(err); code != "bake_source" {
		t.Fatalf("image.bake without a claim = %v (code %q), want bake_source", err, code)
	}
	h.a.Wait()
	if bakes := h.drv.BakesSnapshot(); len(bakes) != 0 {
		t.Fatalf("a bake started anyway: %+v", bakes)
	}
}
