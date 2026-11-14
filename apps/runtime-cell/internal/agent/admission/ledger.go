// Package admission is the cell's memory admission (ADR-070).
//
// On a driver whose claims share the cell's own
// memory (driver.MemoryBudget, docker-gvisor), the cell takes a claim only
// when what it is counted for fits in what the cell may commit
// (the ledger's allocatable): a booting claim at its build size, a ready
// one at its ready size. A claim that does not fit is refused with
// no_capacity before anything is made; the worker waits and asks again.
// The ledger is the cell's truth: the heartbeat tells the hub what it
// holds (heartbeat memory), so the hub stops sending what would not fit.
//
// The ledger counts megabytes per claim id and nothing else: it knows no
// driver, claim or hub. The agent decides what each claim is counted for.
package admission

import "sync"

// Ledger is what each claim the cell holds is counted for, in MB.
type Ledger struct {
	mu          sync.Mutex
	allocatable int
	byClaim     map[string]int
	// Holds share the active claim's physical budget. They may outlive its
	// logical release while a pinned bake still runs in the same parent.
	holds map[string]map[*hold]int
}

type hold struct{ mb int }

// New is a ledger of a cell that may commit allocatableMB to its claims.
func New(allocatableMB int) *Ledger {
	return &Ledger{allocatable: allocatableMB, byClaim: map[string]int{}, holds: map[string]map[*hold]int{}}
}

// Admit counts mb for a claim the ledger does not hold yet when it fits,
// or whatever is free when enforce is false (a hub that would read the
// refusal as a failure, not a wait). fresh is false for a claim it already
// holds (left as it is); free is what was left before.
func (m *Ledger) Admit(id string, mb int, enforce bool) (ok, fresh bool, free int) {
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

// Set counts the claim at mb from now on (its builds are over, or it is
// about to build after all), whether or not that fits: the claim is
// already the cell's. It returns whether the cell is now over what it may
// commit.
func (m *Ledger) Set(id string, mb int) (over bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, held := m.byClaim[id]; !held {
		return false
	}
	m.byClaim[id] = mb
	return m.committedLocked() > m.allocatable
}

// Count is what the claim is counted for, 0 when the ledger does not hold it.
func (m *Ledger) Count(id string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.byClaim[id]
}

func (m *Ledger) Forget(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.byClaim, id)
}

// Retain reserves at least mb for asynchronous work sharing a live claim's
// physical tree. It is acquired before a bake is pinned/acked and remains
// counted after forget. The returned release is idempotent and must run only
// when the actual driver operation returns, not merely when it is cancelled.
func (m *Ledger) Retain(id string, mb int) (release func(), ok bool) {
	m.mu.Lock()
	active, live := m.byClaim[id]
	current := max(active, m.heldLocked(id))
	if !live || mb <= 0 || max(current, mb)-current > max(m.allocatable-m.committedLocked(), 0) {
		m.mu.Unlock()
		return nil, false
	}
	token := &hold{mb: mb}
	if m.holds[id] == nil {
		m.holds[id] = map[*hold]int{}
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

func (m *Ledger) Committed() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.committedLocked()
}

func (m *Ledger) committedLocked() int {
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

func (m *Ledger) heldLocked(id string) int {
	mb := 0
	for _, held := range m.holds[id] {
		mb = max(mb, held)
	}
	return mb
}

// Allocatable is what the cell may commit to claims, in MB.
func (m *Ledger) Allocatable() int { return m.allocatable }

// Holds is how many claims have asynchronous work holding their budget.
func (m *Ledger) Holds() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.holds)
}
