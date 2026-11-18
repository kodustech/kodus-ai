package admission

import "testing"

func TestMemoryLedger(t *testing.T) {
	m := New(10)
	if ok, fresh, _ := m.Admit("a", 6, true); !ok || !fresh {
		t.Fatal("a did not fit")
	}
	if ok, _, free := m.Admit("b", 5, true); ok || free != 4 {
		t.Fatalf("b fit past the cell (free %d)", free)
	}
	if ok, fresh, _ := m.Admit("a", 9, true); !ok || fresh || m.Count("a") != 6 {
		t.Fatal("a second admit of a held claim changed it")
	}
	if over := m.Set("a", 11); !over {
		t.Fatal("going over was not reported")
	}
	if m.Set("missing", 1) || m.Count("missing") != 0 {
		t.Fatal("set counted a claim the ledger does not hold")
	}
	m.Forget("a")
	if m.Committed() != 0 {
		t.Fatal("forget left memory counted")
	}
	// Not enforced (an older hub): counted, never refused.
	if ok, fresh, _ := m.Admit("c", 50, false); !ok || !fresh || m.Committed() != 50 {
		t.Fatal("an unenforced admit refused or did not count")
	}
}

func TestMemoryLedgerAsyncHoldsShareOneBudgetAndCannotEraseANewOwner(t *testing.T) {
	m := New(10)
	if ok, _, _ := m.Admit("claim", 2, true); !ok {
		t.Fatal("admit")
	}
	first, ok := m.Retain("claim", 4)
	if !ok {
		t.Fatal("first retain")
	}
	second, ok := m.Retain("claim", 6)
	if !ok {
		t.Fatal("second retain")
	}
	if got := m.Committed(); got != 6 {
		t.Fatalf("shared tree double-counted: %d", got)
	}
	m.Set("claim", 8)
	second()
	if got := m.Committed(); got != 8 {
		t.Fatalf("hold completion removed live claim capacity: %d", got)
	}
	m.Set("claim", 2)
	m.Forget("claim")
	if got := m.Committed(); got != 4 {
		t.Fatalf("logical release removed physical hold: %d", got)
	}
	if ok, _, _ := m.Admit("claim", 1, false); ok {
		t.Fatal("same released id borrowed a still-live physical hold")
	}
	first()
	if got := m.Committed(); got != 0 {
		t.Fatalf("last hold survived completion: %d", got)
	}
	if ok, _, _ := m.Admit("claim", 3, true); !ok {
		t.Fatal("cleaned id could not be admitted")
	}
	first()
	second()
	if got := m.Committed(); got != 3 {
		t.Fatalf("stale hold callback erased new owner: %d", got)
	}
	if _, ok := m.Retain("missing", 1); ok {
		t.Fatal("retained absent claim")
	}
}

func TestRetainingAlreadyCommittedBudgetNeedsNoAdditionalCapacity(t *testing.T) {
	m := New(10)
	m.Admit("a", 8, false)
	m.Admit("b", 8, false) // legacy hub already overcommitted
	release, ok := m.Retain("a", 8)
	if !ok {
		t.Fatal("retaining the same physical budget asked for capacity again")
	}
	defer release()
	if _, ok := m.Retain("a", 9); ok {
		t.Fatal("overcommitted cell granted additional capacity")
	}
	if got := m.Committed(); got != 16 {
		t.Fatalf("retention changed committed capacity: %d", got)
	}
}
