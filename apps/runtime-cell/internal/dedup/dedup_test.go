package dedup

import (
	"testing"
	"time"
)

func TestAdmit(t *testing.T) {
	now := time.Unix(0, 0)
	s := NewStore(time.Hour, func() time.Time { return now })
	if v := s.Admit("c1", "s1", []byte("ls")); v != New {
		t.Fatal(v)
	}
	if v := s.Admit("c1", "s1", []byte("ls")); v != Duplicate {
		t.Fatal(v)
	}
	// S-30: same stepId with another command.
	if v := s.Admit("c1", "s1", []byte("rm -rf /")); v != Conflict {
		t.Fatal(v)
	}
	// Same stepId under another claim.
	if v := s.Admit("c2", "s1", []byte("ls")); v != Conflict {
		t.Fatal(v)
	}
	now = now.Add(61 * time.Minute)
	if v := s.Admit("c1", "s1", []byte("ls")); v != New || s.Len() != 1 {
		t.Fatal("ttl not applied")
	}
}

func TestConditionalAdmissionKeepsRefusalsUnseenAndChecksRetriesFirst(t *testing.T) {
	s := NewStore(time.Hour, func() time.Time { return time.Unix(0, 0) })
	calls := 0
	reserve := func() bool { calls++; return false }
	if got := s.AdmitIf("c1", "s1", []byte("id"), reserve); got != Refused || s.Len() != 0 {
		t.Fatalf("refused step recorded: %s, len %d", got, s.Len())
	}
	if got := s.AdmitIf("c1", "s1", []byte("id"), func() bool { return true }); got != New {
		t.Fatal(got)
	}
	if got := s.AdmitIf("c1", "s1", []byte("id"), reserve); got != Duplicate {
		t.Fatal(got)
	}
	if got := s.AdmitIf("c1", "s1", []byte("other"), reserve); got != Conflict {
		t.Fatal(got)
	}
	if got := s.AdmitIf("c2", "s1", []byte("id"), reserve); got != Conflict {
		t.Fatal(got)
	}
	if calls != 1 {
		t.Fatalf("existing steps consumed reservations: %d", calls)
	}
	if Refused.String() != "refused" {
		t.Fatal(Refused.String())
	}
}
