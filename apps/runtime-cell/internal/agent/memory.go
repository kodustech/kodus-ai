package agent

import (
	"sync"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Memory admission (ADR-070). On a driver whose claims share the cell's own
// memory (driver.MemoryBudget, docker-gvisor), the cell takes a claim only
// when what it is counted for fits in what the cell may commit
// (Config.MemoryAllocatableMB): a booting claim at its build size, a ready
// one at its ready size. A claim that does not fit is refused with
// no_capacity before anything is made; the worker waits and asks again.
// The ledger is the cell's truth: the heartbeat tells the hub what it
// holds (heartbeat memory), so the hub stops sending what would not fit.

// maxReportedMemoryMB is the most heartbeat memory may name (1 TiB,
// MAX_CELL_MEMORY_MB in libs/runtime/protocol/messages.ts).
const maxReportedMemoryMB = 1 << 20

// memoryLedger is what each claim the cell holds is counted for, in MB.
type memoryLedger struct {
	mu          sync.Mutex
	allocatable int
	byClaim     map[string]int
	// Holds share the active claim's physical budget. They may outlive its
	// logical release while a pinned bake still runs in the same parent.
	holds map[string]map[*memoryHold]int
}

type memoryHold struct{ mb int }

func newMemoryLedger(allocatableMB int) *memoryLedger {
	return &memoryLedger{allocatable: allocatableMB, byClaim: map[string]int{}, holds: map[string]map[*memoryHold]int{}}
}

// admit counts mb for a claim the ledger does not hold yet when it fits,
// or whatever is free when enforce is false (a hub that would read the
// refusal as a failure, not a wait). fresh is false for a claim it already
// holds (left as it is); free is what was left before.
func (m *memoryLedger) admit(id string, mb int, enforce bool) (ok, fresh bool, free int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	free = m.allocatable - m.committedLocked()
	if _, held := m.byClaim[id]; held {
		return true, false, free
	}
	if len(m.holds[id]) > 0 {
		// Reusing a released logical id cannot borrow its predecessor's
		// still-live physical budget, even for an older hub.
		return false, false, free
	}
	if enforce && mb > free {
		return false, false, free
	}
	m.byClaim[id] = mb
	return true, true, free
}

// set counts the claim at mb from now on (its builds are over, or it is
// about to build after all), whether or not that fits: the claim is
// already the cell's. It returns whether the cell is now over what it may
// commit.
func (m *memoryLedger) set(id string, mb int) (over bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, held := m.byClaim[id]; !held {
		return false
	}
	m.byClaim[id] = mb
	return m.committedLocked() > m.allocatable
}

// count is what the claim is counted for, 0 when the ledger does not hold it.
func (m *memoryLedger) count(id string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.byClaim[id]
}

func (m *memoryLedger) forget(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.byClaim, id)
}

// retain reserves at least mb for asynchronous work sharing a live claim's
// physical tree. It is acquired before a bake is pinned/acked and remains
// counted after forget. The returned release is idempotent and must run only
// when the actual driver operation returns, not merely when it is cancelled.
func (m *memoryLedger) retain(id string, mb int) (release func(), ok bool) {
	m.mu.Lock()
	active, live := m.byClaim[id]
	current := max(active, m.heldLocked(id))
	if !live || mb <= 0 || max(current, mb)-current > max(m.allocatable-m.committedLocked(), 0) {
		m.mu.Unlock()
		return nil, false
	}
	token := &memoryHold{mb: mb}
	if m.holds[id] == nil {
		m.holds[id] = map[*memoryHold]int{}
	}
	m.holds[id][token] = mb
	m.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			delete(m.holds[id], token)
			if len(m.holds[id]) == 0 {
				delete(m.holds, id)
			}
		})
	}, true
}

func (m *memoryLedger) committed() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.committedLocked()
}

func (m *memoryLedger) committedLocked() int {
	n := 0
	for id, mb := range m.byClaim {
		n += max(mb, m.heldLocked(id))
	}
	for id := range m.holds {
		if _, live := m.byClaim[id]; !live {
			n += m.heldLocked(id)
		}
	}
	return n
}

func (m *memoryLedger) heldLocked(id string) int {
	mb := 0
	for _, held := range m.holds[id] {
		mb = max(mb, held)
	}
	return mb
}

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
	a.mu.Lock()
	defer a.mu.Unlock()
	b, ok := a.baked[acq.ImageID]
	return ok && b.orgID == acq.OrgID && b.environmentID == acq.EnvironmentID && b.sha == acq.Sha
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
		AllocatableMb: clip(a.mem.allocatable),
		CommittedMb:   clip(a.mem.committed()),
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
	if a.mem.count(c.ID) != a.budget.ClaimMemory(claimSize(c.Acquire)).ReadyMB {
		a.mem.set(c.ID, a.budget.ClaimMemory(claimSize(c.Acquire)).ReadyMB)
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
	if a.mem.count(c.ID) >= boot {
		return
	}
	if a.mem.set(c.ID, boot) {
		c.Log.Warn("claim.memory_over", "bootMb", boot, "committedMb", a.mem.committed(), "allocatableMb", a.mem.allocatable)
	}
	a.nudgeHeartbeat()
}
