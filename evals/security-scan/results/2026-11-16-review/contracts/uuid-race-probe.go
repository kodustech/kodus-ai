package uuid

import (
    "sync"
    "testing"
    "time"
)

func TestReviewV6WithTimeUniqueness(t *testing.T) {
    const calls = 6000 // Below the documented 14-bit same-time sequence limit.
    SetNodeID([]byte{2, 0, 0, 0, 0, 1})
    fixed := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
    SetClockSequence(1)
    serial := map[UUID]bool{}
    for i := 0; i < calls; i++ {
        id, err := NewV6WithTime(&fixed)
        if err != nil { t.Fatal(err) }
        if serial[id] { t.Fatal("serial control duplicated") }
        serial[id] = true
    }
    t.Logf("serial control: %d calls, %d unique", calls, len(serial))
    SetClockSequence(1)
    start := make(chan struct{})
    ids := make(chan UUID, calls)
    var group sync.WaitGroup
    for g := 0; g < 8; g++ {
        group.Add(1)
        go func() {
            defer group.Done()
            <-start
            for n := 0; n < calls/8; n++ {
                id, err := NewV6WithTime(&fixed)
                if err == nil { ids <- id }
            }
        }()
    }
    close(start)
    group.Wait()
    close(ids)
    seen := map[UUID]bool{}
    duplicates := 0
    for id := range ids {
        if seen[id] { duplicates++ }
        seen[id] = true
    }
    t.Logf("concurrent probe: %d calls, %d unique, %d duplicates", calls, len(seen), duplicates)
    if duplicates > 0 { t.Fatalf("concurrent uniqueness violated: %d duplicates", duplicates) }
}
