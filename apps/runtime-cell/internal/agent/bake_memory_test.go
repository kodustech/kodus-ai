package agent

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// The bake's data helper can outlive claim.release, which used to erase
// the whole reservation and admit a new build alongside the still-live helper.
type asyncBakeMemoryDriver struct {
	*fake.Driver
	started         chan struct{}
	proceed         <-chan struct{}
	fail            error
	bootMB, readyMB int
}

func (d *asyncBakeMemoryDriver) ClaimMemory(driver.ClaimSize) driver.ClaimMemory {
	return driver.ClaimMemory{BootMB: d.bootMB, ReadyMB: d.readyMB}
}
func (d *asyncBakeMemoryDriver) Bake(ctx context.Context, s driver.BakeSpec) (driver.ImageRef, error) {
	close(d.started)
	select {
	case <-d.proceed:
	case <-ctx.Done():
		return driver.ImageRef{}, ctx.Err()
	}
	if d.fail != nil {
		return driver.ImageRef{}, d.fail
	}
	return d.Driver.Bake(ctx, s)
}
func bakeMemoryHarness(t *testing.T, allocatable, boot, ready int, fail error) (*harness, *asyncBakeMemoryDriver, *recPinner, func()) {
	t.Helper()
	proceed := make(chan struct{})
	allow := sync.OnceFunc(func() { close(proceed) })
	var drv *asyncBakeMemoryDriver
	pin := &recPinner{}
	h := newHarness(t, func(c *Config) {
		drv = &asyncBakeMemoryDriver{Driver: c.Driver.(*fake.Driver), started: make(chan struct{}), proceed: proceed, fail: fail, bootMB: boot, readyMB: ready}
		c.Driver = drv
		c.MemoryAllocatableMB = allocatable
		c.BakePinner = pin
	})
	t.Cleanup(allow)
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureCellMemory}})
	readySetupClaim(t, h)
	return h, drv, pin, allow
}
func startMemoryBake(t *testing.T, h *harness) error {
	t.Helper()
	return h.handle("claim-1", protocol.MessageTypeImageBake, &protocol.ImageBakeBody{OrgID: "org-a", EnvironmentID: "env-1", Sha: testSHA, RecipeSha: "r"})
}

func TestAsyncBakeRetainsPhysicalMemoryAfterClaimReleaseUntilItActuallyReturns(t *testing.T) {
	for _, outcome := range []string{"success", "failure"} {
		t.Run(outcome, func(t *testing.T) {
			var fault error
			if outcome == "failure" {
				fault = errors.New("bake helper failed")
			}
			h, drv, _, allow := bakeMemoryHarness(t, 4096, 4096, 4096, fault)
			if err := startMemoryBake(t, h); err != nil {
				t.Fatal(err)
			}
			<-drv.started
			if got := h.a.mem.committed(); got != 4096 {
				t.Fatalf("live claim and bake double-counted or lost: %d", got)
			}
			if err := h.handle("claim-1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
				t.Fatal(err)
			}
			waitFor(t, func() bool { _, ok := h.a.claims.Get("claim-1"); return !ok })
			if hb := h.a.Heartbeat(); hb.Memory == nil || hb.Memory.CommittedMb != 4096 {
				t.Fatalf("active bake lost its physical reservation after release: %+v", hb.Memory)
			}
			if err := h.handle("claim-2", protocol.MessageTypeClaimAcquire, h.acquireBody()); nackCode(err) != "no_capacity" {
				t.Fatalf("new claim used bake's memory: %v", err)
			}
			if len(h.drv.Machines()) != 0 {
				t.Fatal("a second workload started in the retained capacity")
			}
			// Drain old heartbeat hints before completion: completion must nudge
			// capacity immediately, independently of the next heartbeat tick.
			for len(h.a.beat) > 0 {
				<-h.a.beat
			}
			allow()
			waitFor(t, func() bool { return h.a.mem.committed() == 0 })
			waitFor(t, func() bool { return len(h.a.beat) > 0 })
			<-h.a.beat
			h.ready("claim-2")
			if got := h.a.mem.committed(); got != 4096 {
				t.Fatalf("old hold released a new claim's reservation: %d", got)
			}
		})
	}
}

func TestAsyncBakeReservesFullBudgetWithoutDoubleCountingReadyClaim(t *testing.T) {
	h, drv, _, allow := bakeMemoryHarness(t, 8192, 4096, 2048, nil)
	if got := h.a.mem.committed(); got != 2048 {
		t.Fatalf("ready reservation=%d", got)
	}
	if err := startMemoryBake(t, h); err != nil {
		t.Fatal(err)
	}
	<-drv.started
	if got := h.a.mem.committed(); got != 4096 {
		t.Fatalf("bake and claim must share one full budget, got %d", got)
	}
	allow()
	h.a.Wait()
	if got := h.a.mem.committed(); got != 2048 {
		t.Fatalf("completed bake changed live claim budget: %d", got)
	}
}

func TestAsyncBakeWithoutFullBudgetIsRefusedBeforePinOrAck(t *testing.T) {
	h, _, pin, _ := bakeMemoryHarness(t, 6144, 4096, 2048, nil)
	if ok, _, _ := h.a.mem.admit("other-held", 4096, true); !ok {
		t.Fatal("fixture reservation failed")
	}
	if err := startMemoryBake(t, h); nackCode(err) != "no_capacity" {
		t.Fatalf("bake started without full capacity: %v", err)
	}
	pin.mu.Lock()
	pins := len(pin.refs)
	pin.mu.Unlock()
	if pins != 0 {
		t.Fatal("refused bake stranded a driver pin")
	}
	if got := h.a.mem.committed(); got != 6144 {
		t.Fatalf("refused bake changed reservations: %d", got)
	}
}

func TestMemoryLedgerAsyncHoldsShareOneBudgetAndCannotEraseANewOwner(t *testing.T) {
	m := newMemoryLedger(10)
	if ok, _, _ := m.admit("claim", 2, true); !ok {
		t.Fatal("admit")
	}
	first, ok := m.retain("claim", 4)
	if !ok {
		t.Fatal("first retain")
	}
	second, ok := m.retain("claim", 6)
	if !ok {
		t.Fatal("second retain")
	}
	if got := m.committed(); got != 6 {
		t.Fatalf("shared tree double-counted: %d", got)
	}
	m.set("claim", 8)
	second()
	if got := m.committed(); got != 8 {
		t.Fatalf("hold completion removed live claim capacity: %d", got)
	}
	m.set("claim", 2)
	m.forget("claim")
	if got := m.committed(); got != 4 {
		t.Fatalf("logical release removed physical hold: %d", got)
	}
	if ok, _, _ := m.admit("claim", 1, false); ok {
		t.Fatal("same released id borrowed a still-live physical hold")
	}
	first()
	if got := m.committed(); got != 0 {
		t.Fatalf("last hold survived completion: %d", got)
	}
	if ok, _, _ := m.admit("claim", 3, true); !ok {
		t.Fatal("cleaned id could not be admitted")
	}
	first()
	second()
	if got := m.committed(); got != 3 {
		t.Fatalf("stale hold callback erased new owner: %d", got)
	}
	if _, ok := m.retain("missing", 1); ok {
		t.Fatal("retained absent claim")
	}
}

func TestAsyncBakePinRefusalReleasesOnlyItsExtraMemoryHold(t *testing.T) {
	h, _, pin, _ := bakeMemoryHarness(t, 8192, 4096, 2048, nil)
	pin.err = errors.New("setup already pinned")
	if err := startMemoryBake(t, h); nackCode(err) != "bake_source" {
		t.Fatalf("pin failure: %v", err)
	}
	if got := h.a.mem.committed(); got != 2048 {
		t.Fatalf("pin failure stranded full budget or erased live claim: %d", got)
	}
	if len(h.a.mem.holds) != 0 {
		t.Fatal("pin refusal left async hold")
	}
}

func TestRetainingAlreadyCommittedBudgetNeedsNoAdditionalCapacity(t *testing.T) {
	m := newMemoryLedger(10)
	m.admit("a", 8, false)
	m.admit("b", 8, false) // legacy hub already overcommitted
	release, ok := m.retain("a", 8)
	if !ok {
		t.Fatal("retaining the same physical budget asked for capacity again")
	}
	defer release()
	if _, ok := m.retain("a", 9); ok {
		t.Fatal("overcommitted cell granted additional capacity")
	}
	if got := m.committed(); got != 16 {
		t.Fatalf("retention changed committed capacity: %d", got)
	}
}

func TestRequiredMemoryAdmissionCannotBeBypassedByAnOlderHub(t *testing.T) {
	h := newHarness(t, withMemory(12288), func(c *Config) { c.RequireMemoryAdmission = true })
	if h.a.hubAccepts(protocol.FeatureCellMemory) {
		t.Fatal("fixture unexpectedly negotiated memory")
	}
	if ok, _, _ := h.a.mem.admit("physical-held", 12288, true); !ok {
		t.Fatal("fixture reservation failed")
	}
	if err := h.handle("claim-old-hub", protocol.MessageTypeClaimAcquire, h.acquireBody()); nackCode(err) != "no_capacity" {
		t.Fatalf("old hub bypassed required admission: %v", err)
	}
	if got := h.a.mem.committed(); got != 12288 {
		t.Fatalf("overcommitted required physical budget: %d", got)
	}
	if len(h.drv.Machines()) != 0 {
		t.Fatal("created workload despite required capacity refusal")
	}
}

type zeroMemoryDriver struct{ driver.MachineDriver }

func (zeroMemoryDriver) ClaimMemory(driver.ClaimSize) driver.ClaimMemory { return driver.ClaimMemory{} }

func TestRequiredMemoryAdmissionRefusesMissingOrUnusableBudget(t *testing.T) {
	for _, kind := range []string{"no-budget-port", "zero-allocatable", "zero-budget"} {
		t.Run(kind, func(t *testing.T) {
			h := newHarness(t, withMemory(4096))
			cfg := h.a.cfg
			cfg.RequireMemoryAdmission = true
			switch kind {
			case "no-budget-port":
				cfg.Driver = h.drv
			case "zero-allocatable":
				cfg.MemoryAllocatableMB = 0
			case "zero-budget":
				cfg.Driver = zeroMemoryDriver{h.drv}
			}
			if _, err := New(cfg); !errors.Is(err, driver.ErrResourceEnforcement) {
				t.Fatalf("required admission accepted %s: %v", kind, err)
			}
		})
	}
}

func TestAsyncBakeWithUnconfirmedPhysicalCleanupKeepsItsMemoryQuarantined(t *testing.T) {
	h, drv, _, allow := bakeMemoryHarness(t, 4096, 4096, 4096, driver.ErrResourceCleanupPending)
	if err := startMemoryBake(t, h); err != nil {
		t.Fatal(err)
	}
	<-drv.started
	if err := h.handle("claim-1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { _, ok := h.a.claims.Get("claim-1"); return !ok })
	allow()
	h.a.Wait() // Driver.Bake returned but a helper may still be alive.
	if got := h.a.mem.committed(); got != 4096 {
		t.Fatalf("unconfirmed cleanup freed physical memory: %d", got)
	}
	if err := h.handle("claim-2", protocol.MessageTypeClaimAcquire, h.acquireBody()); nackCode(err) != "no_capacity" {
		t.Fatalf("new claim borrowed quarantined capacity: %v", err)
	}
	if !strings.Contains(h.logs.String(), "bake.cleanup_pending") || !strings.Contains(h.logs.String(), "alarm=true") {
		t.Fatalf("no operator alarm: %s", h.logs.String())
	}
}
