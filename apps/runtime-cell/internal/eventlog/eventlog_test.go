package eventlog

import (
	"context"
	"runtime"
	"testing"
	"time"
)

func TestBoundedSequencedLongPoll(t *testing.T) {
	l := New[int64](2)
	for i := 0; i < 5; i++ {
		l.Add(func(seq int64) int64 { return seq })
	}
	if got := l.After(context.Background(), 0, 0); len(got) != 2 || got[0] != 4 || got[1] != 5 {
		t.Fatalf("%v", got)
	}
	done := make(chan []int64)
	go func() { done <- l.After(context.Background(), 5, time.Second) }()
	time.Sleep(20 * time.Millisecond)
	l.Add(func(seq int64) int64 { return seq })
	if got := <-done; len(got) != 1 || got[0] != 6 {
		t.Fatalf("long poll %v", got)
	}
	if got := l.After(context.Background(), 6, 10*time.Millisecond); got != nil {
		t.Fatalf("%v", got)
	}
}

// Adding to a full log costs the same whatever its size: the oldest entry is
// overwritten, the log is never copied.
func TestAddingToAFullLogDoesNotCopyIt(t *testing.T) {
	l := New[int64](10_000)
	add := func() { l.Add(func(seq int64) int64 { return seq }) }
	for i := 0; i < 10_000; i++ {
		add()
	}
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	for i := 0; i < 1_000; i++ {
		add()
	}
	runtime.ReadMemStats(&after)
	if grew := after.TotalAlloc - before.TotalAlloc; grew > 256<<10 {
		t.Fatalf("1000 adds to a full log allocated %d bytes", grew)
	}
	got := l.After(context.Background(), 0, 0)
	if len(got) != 10_000 || got[0] != 1_001 || got[len(got)-1] != 11_000 {
		t.Fatalf("kept %d entries, %d..%d", len(got), got[0], got[len(got)-1])
	}
	if got := l.After(context.Background(), 10_998, 0); len(got) != 2 || got[0] != 10_999 {
		t.Fatalf("after 10998: %v", got)
	}
}

func BenchmarkAddToAFullLog(b *testing.B) {
	l := New[int64](10_000)
	for i := 0; i < 10_000; i++ {
		l.Add(func(seq int64) int64 { return seq })
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		l.Add(func(seq int64) int64 { return seq })
	}
}
