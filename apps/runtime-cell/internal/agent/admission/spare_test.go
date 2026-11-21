package admission

import "testing"

// A warm spare takes only room no claim needs: it is reserved when it fits
// what is free, the heartbeat never counts it, and a claim that fits
// without it is admitted at once while the spare is evicted.
func TestASpareNeverMakesAClaimRefuseOrWait(t *testing.T) {
	m := New(10)
	if ok, _, _ := m.Admit("run-base", 4, true); !ok {
		t.Fatal("admit")
	}
	evicted := 0
	if !m.Spare("run-base", 4, func() { evicted++ }) {
		t.Fatal("a spare that fits was refused")
	}
	if m.Committed() != 4 {
		t.Fatalf("the heartbeat counts the spare: committed %d", m.Committed())
	}
	if m.Spare("run-pr", 1, func() {}) {
		t.Fatal("a spare of a claim the cell does not hold was reserved")
	}
	// 4 + 3 fits the cell, 4 + 4 spare + 3 does not: the claim is admitted
	// and the spare goes.
	if ok, _, free := m.Admit("run-pr", 3, true); !ok || free != 6 {
		t.Fatalf("a claim that fits without the spare was refused (free %d)", free)
	}
	if evicted != 1 {
		t.Fatalf("the claim that needed the spare's room did not evict it (%d)", evicted)
	}
	if m.Spare("run-pr", 4, func() {}) {
		t.Fatal("a spare past what is free was reserved")
	}
	if ok, _, free := m.Admit("other", 3, true); !ok || free != 3 {
		t.Fatalf("a claim that fits without the spare was refused (free %d)", free)
	}
	m.EndSpare("run-base") // the spare's boot ended after its eviction: nothing changes
	if m.Committed() != 10 || evicted != 1 {
		t.Fatalf("committed %d, evicted %d", m.Committed(), evicted)
	}
}

// A claim that grows (its build size again, Set) or a bake's hold on it
// (Retain) also takes the room back from a spare, never the reverse.
func TestAGrowingClaimOrAHoldEvictsASpare(t *testing.T) {
	m := New(10)
	m.Admit("a", 4, true)
	m.Admit("b", 2, true)
	evicted := map[string]int{}
	if !m.Spare("a", 4, func() { evicted["a"]++ }) {
		t.Fatal("spare a")
	}
	if over := m.Set("b", 4); over || evicted["a"] != 1 {
		t.Fatalf("over %v, evicted %v", over, evicted)
	}
	if !m.Spare("b", 2, func() { evicted["b"]++ }) {
		t.Fatal("spare b")
	}
	if _, ok := m.Retain("a", 6); !ok || evicted["b"] != 1 {
		t.Fatalf("a bake's hold did not take the spare's room: %v", evicted)
	}
	// One spare per claim; a claim's release drops its spare without
	// calling it evicted (the machine's destroy takes the spare).
	m2 := New(10)
	m2.Admit("a", 2, true)
	calls := 0
	if !m2.Spare("a", 2, func() { calls++ }) {
		t.Fatal("spare")
	}
	if m2.Spare("a", 2, func() { calls++ }) {
		t.Fatal("a second spare of one claim")
	}
	m2.EndSpare("a")
	if m2.Spares() != 0 || !m2.Spare("a", 2, func() { calls++ }) {
		t.Fatal("an ended spare still held its room")
	}
	m2.Forget("a")
	if ok, _, free := m2.Admit("c", 10, true); !ok || free != 10 || calls != 0 {
		t.Fatalf("a released claim's spare still held room (free %d, calls %d)", free, calls)
	}
}
