package agent

import (
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Memory admission (ADR-070): the rule is admission.Ledger. Here is what the
// agent asks of it: what a claim is counted for while it boots and once
// ready, and what the heartbeat tells the hub.

// maxReportedMemoryMB is the most heartbeat memory may name (1 TiB,
// MAX_CELL_MEMORY_MB in libs/runtime/protocol/messages.ts).
const maxReportedMemoryMB = 1 << 20

// claimMemoryNeed is what a new claim is counted for while it boots: the
// base side of a Run is counted at its ready size when it takes a warm pool
// machine or boots a bake this cell made for its environment, since its
// images are built already; every other claim at its build size. Counting a
// bake-booted base at build size made it wait the whole PR build on
// cell-dev-1 (its build took 0.7 s from the bake's cache).
func (a *Agent) claimMemoryNeed(acq protocol.ClaimAcquireBody, pooled bool) int {
	mem := a.budget.ClaimMemory(claimSize(acq))
	if acq.Side == protocol.SideBase && (pooled || a.bootsLocalBake(acq)) {
		return mem.ReadyMB
	}
	return mem.BootMB
}

// bootsLocalBake: the claim's image is a bake this cell made for the claim's
// environment at the claim's commit. "latest" before any bake here, "setup",
// a bake made on another cell, or the environment's bake of another commit
// (a PR whose base is an older default branch: kr-grafana#7 after main moved)
// all build, at build size.
func (a *Agent) bootsLocalBake(acq protocol.ClaimAcquireBody) bool {
	b, ok := a.origin.Baked(acq.ImageID)
	return ok && b.OrgID == acq.OrgID && b.EnvironmentID == acq.EnvironmentID && b.SHA == acq.Sha
}

// memoryReport is heartbeat memory, nil when the cell does no memory
// admission.
func (a *Agent) memoryReport() *protocol.HeartbeatBodyMemory {
	if a.mem == nil {
		return nil
	}
	def := a.budget.ClaimMemory(claimSize(protocol.ClaimAcquireBody{}))
	// Bounded as the protocol bounds them (MAX_CELL_MEMORY_MB).
	clip := func(mb int) int64 { return int64(min(max(mb, 0), maxReportedMemoryMB)) }
	return &protocol.HeartbeatBodyMemory{
		AllocatableMb: clip(a.mem.Allocatable()),
		CommittedMb:   clip(a.mem.Committed()),
		BootMb:        clip(def.BootMB),
		ReadyMb:       clip(def.ReadyMB),
	}
}

// nudgeHeartbeat sends a heartbeat now instead of at the next tick, so the
// hub learns at once what a claim took or gave back.
func (a *Agent) nudgeHeartbeat() {
	select {
	case a.beat <- struct{}{}:
	default:
	}
}

// countReady counts a claim whose builds are over at its ready size.
func (a *Agent) countReady(c *claims.Claim) {
	if a.mem == nil {
		return
	}
	if a.mem.Count(c.ID) != a.budget.ClaimMemory(claimSize(c.Acquire)).ReadyMB {
		a.mem.Set(c.ID, a.budget.ClaimMemory(claimSize(c.Acquire)).ReadyMB)
		a.nudgeHeartbeat()
	}
}

// countBoot counts a claim at its build size from now on: a base claim
// admitted at its ready size for the pool machine it was to take, which
// another claim took first, builds after all. The cell may then be over
// what it may commit until a claim ends; it is logged.
func (a *Agent) countBoot(c *claims.Claim) {
	if a.mem == nil {
		return
	}
	boot := a.budget.ClaimMemory(claimSize(c.Acquire)).BootMB
	if a.mem.Count(c.ID) >= boot {
		return
	}
	if a.mem.Set(c.ID, boot) {
		c.Log.Warn("claim.memory_over", "bootMb", boot, "committedMb", a.mem.Committed(), "allocatableMb", a.mem.Allocatable())
	}
	a.nudgeHeartbeat()
}
