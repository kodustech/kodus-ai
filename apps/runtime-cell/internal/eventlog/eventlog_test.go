package eventlog

import (
	"context"
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
