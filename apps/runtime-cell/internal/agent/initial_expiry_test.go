package agent

import (
	"testing"
	"time"
)

func TestInitialExpiryFollowsTheHubLease(t *testing.T) {
	now := time.Date(2026, 11, 5, 13, 0, 0, 0, time.UTC)
	str := func(s string) *string { return &s }
	if got := initialExpiry(now, 5*time.Minute, str("2026-11-05T13:30:00Z")); !got.Equal(now.Add(30 * time.Minute)) {
		t.Fatalf("hub lease: %v", got)
	}
	for _, l := range []*string{nil, str("not a time"), str("2026-11-05T12:00:00Z")} {
		if got := initialExpiry(now, 5*time.Minute, l); !got.Equal(now.Add(5 * time.Minute)) {
			t.Fatalf("fallback for %v: %v", l, got)
		}
	}
}
