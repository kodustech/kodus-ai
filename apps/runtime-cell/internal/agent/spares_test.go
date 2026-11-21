package agent

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// spareKeeper is a driver's warm spares: one spare at a time, on the
// addresses it is given.
type spareKeeper struct {
	mu      sync.Mutex
	ips     []string
	boots   int
	ready   bool
	takes   int
	drops   int
	takeErr error
	// told are the sources the egress policy had when each boot told the
	// spare's addresses, after the push.
	told [][]string
	eg   *recEgress
}

func (k *spareKeeper) BootSpare(_ context.Context, _ driver.UpRequest, before func([]string) error) error {
	if err := before(k.ips); err != nil {
		return err
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	k.boots++
	k.told = append(k.told, k.eg.lastSources())
	k.ready = true
	return nil
}

func (k *spareKeeper) TakeSpare(context.Context, driver.MachineRef) ([]string, bool, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.takes++
	if k.takeErr != nil {
		k.ready = false
		return nil, false, k.takeErr
	}
	if !k.ready {
		return nil, false, nil
	}
	k.ready = false
	return slices.Clone(k.ips), true, nil
}

func (k *spareKeeper) DropSpare(context.Context, driver.MachineRef) (bool, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.drops++
	was := k.ready
	k.ready = false
	return was, nil
}

func (k *spareKeeper) state() (boots, takes, drops int, ready bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.boots, k.takes, k.drops, k.ready
}

// flatBudget counts a claim at 2 GB booting and ready.
type flatBudget struct{}

func (flatBudget) ClaimMemory(driver.ClaimSize) driver.ClaimMemory {
	return driver.ClaimMemory{BootMB: 2_048, ReadyMB: 2_048}
}

func spareHarness(t *testing.T, allocatableMB int, k *spareKeeper, edit ...func(*Config)) (*harness, *recipeComposer) {
	t.Helper()
	rc := &recipeComposer{composer: composer{ips: [][]string{{"172.30.0.10"}, {"172.30.0.11"}}}}
	edits := append([]func(*Config){withMemory(allocatableMB), func(c *Config) { c.Parts.Composer, c.Parts.Recipes, c.Parts.Spares = rc, rc, k }}, edit...)
	h := newHarness(t, edits...)
	rc.egress, k.eg = h.egress, h.egress
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureCellMemory}})
	return h, rc
}

func (h *harness) resetStep(step string) *protocol.StepResultBody {
	h.t.Helper()
	reset := &protocol.MachineResetBody{StepID: step, Snapshot: protocol.Snapshot{Kind: protocol.SnapshotKindComposeVolumes, Ref: "v"}}
	if err := h.handle("claim-1", protocol.MessageTypeMachineReset, reset); err != nil {
		h.t.Fatal(err)
	}
	return h.conn.next(h.t, isResult(step)).(*protocol.StepResultBody)
}

func (h *harness) driverResets() int {
	n := 0
	for _, m := range h.drv.Machines() {
		n += len(m.Resets)
	}
	return n
}

// A ready Run claim with room in the memory admission boots a spare, its
// addresses in the claim's egress policy before it starts; the next reset
// swaps it in: the policy names the spare alone, nothing is reset, brought
// up or run again, and the next spare boots for the reset after.
func TestAReadySpareMakesTheResetASwap(t *testing.T) {
	k := &spareKeeper{ips: []string{"172.30.0.69"}}
	h, rc := spareHarness(t, 14_745, k)
	b := h.acquireBody()
	withRecipe(b, migrateRecipe)
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	waitFor(t, func() bool { boots, _, _, ready := k.state(); return boots == 1 && ready })
	if got := k.told[0]; !slices.Equal(got, []string{"172.30.0.10", "172.30.0.69"}) {
		t.Fatalf("the policy named %v when the spare started, want the project's and the spare's", got)
	}
	if got := h.a.mem.Spares(); got != h.a.mem.Count("claim-1") || got == 0 {
		t.Fatalf("the spare holds %d MB, the claim %d", got, h.a.mem.Count("claim-1"))
	}
	if hb := h.a.Heartbeat(); int(hb.Memory.CommittedMb) != h.a.mem.Count("claim-1") {
		t.Fatalf("the heartbeat counts the spare: %+v", hb.Memory)
	}

	if r := h.resetStep("step-1"); r.VMHealth != protocol.VMHealthOk || r.Exec != nil {
		t.Fatalf("swap result %+v", r)
	}
	if n := h.driverResets(); n != 0 {
		t.Fatalf("a swap reset the machine %d times", n)
	}
	if got := h.egress.lastSources(); !slices.Equal(got, []string{"172.30.0.69"}) {
		t.Fatalf("after the swap the policy names %v", got)
	}
	rc.mu.Lock()
	runs := len(rc.runs)
	rc.mu.Unlock()
	if runs != 1 {
		t.Fatalf("the recipe ran %d times; the spare ran its own", runs)
	}
	waitFor(t, func() bool { boots, _, _, ready := k.state(); return boots == 2 && ready })
}

// With no room for a spare, none boots and the reset is today's: the
// machine reset and its project brought up again, the recipe run again.
// A swap that fails falls back the same way.
func TestNoRoomOrAFailedSwapIsTodaysReset(t *testing.T) {
	k := &spareKeeper{ips: []string{"172.30.0.69"}}
	// Boots and is ready at 2 GB: 952 MB left, no room for a spare.
	h, rc := spareHarness(t, 3_000, k, func(c *Config) { c.Parts.Memory = flatBudget{} })
	b := h.acquireBody()
	withRecipe(b, migrateRecipe)
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	if r := h.resetStep("step-1"); r.VMHealth != protocol.VMHealthOk || r.Exec != nil {
		t.Fatalf("reset %+v", r)
	}
	if boots, _, _, _ := k.state(); boots != 0 || h.driverResets() != 1 {
		t.Fatalf("no room: %d spares booted, %d resets", boots, h.driverResets())
	}
	rc.mu.Lock()
	runs := len(rc.runs)
	rc.mu.Unlock()
	if runs != 2 {
		t.Fatalf("the recipe ran %d times", runs)
	}

	k2 := &spareKeeper{ips: []string{"172.30.0.69"}, takeErr: errors.New("the spare's app died")}
	h2, _ := spareHarness(t, 14_745, k2)
	b2 := h2.acquireBody()
	withRecipe(b2, migrateRecipe)
	if err := h2.handle("claim-1", protocol.MessageTypeClaimAcquire, b2); err != nil {
		t.Fatal(err)
	}
	h2.conn.next(t, isReady)
	waitFor(t, func() bool { boots, _, _, _ := k2.state(); return boots == 1 })
	if r := h2.resetStep("step-1"); r.VMHealth != protocol.VMHealthOk || r.Exec != nil {
		t.Fatalf("reset after a failed swap %+v", r)
	}
	if h2.driverResets() != 1 {
		t.Fatalf("a failed swap did not reset the machine (%d)", h2.driverResets())
	}
	// The fallback's project, and the next spare's addresses once it boots.
	if got := h2.egress.lastSources(); !slices.Contains(got, "172.30.0.11") || slices.Contains(got, "172.30.0.10") {
		t.Fatalf("after the fallback the policy names %v", got)
	}
}

// A claim that fits the cell without the spare is admitted while the spare
// holds the room, and the spare is dropped for it.
func TestAClaimThatNeedsTheSparesRoomIsAdmittedAndTheSpareDropped(t *testing.T) {
	k := &spareKeeper{ips: []string{"172.30.0.69"}}
	h, _ := spareHarness(t, 14_745, k)
	h.ready("claim-1")
	waitFor(t, func() bool { boots, _, _, ready := k.state(); return boots == 1 && ready })
	// 2 GB ready + 2 GB spare + a 12 GB build is past the cell's 14.4 GB;
	// the build alone is not.
	pr := func(b *protocol.ClaimAcquireBody) { b.Side = protocol.SidePr }
	h.ready("claim-2", pr)
	waitFor(t, func() bool { _, _, drops, _ := k.state(); return drops == 1 })
}
