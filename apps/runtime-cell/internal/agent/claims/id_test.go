package claims

import "testing"

func TestClaimIDIsAPlainPathSegment(t *testing.T) {
	for _, ok := range []string{"claim-0123456789abcdef01234567", "Claim_1", "c1"} {
		if !ValidID(ok) {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", ".", "..", "../../..", "a/b", `a\b`, "/abs", "-x", "a.b", string(make([]byte, 129))} {
		if ValidID(bad) {
			t.Errorf("%q accepted: it would name a directory outside the claims dir", bad)
		}
	}
	if _, err := WorkDir("/work", "../.."); err == nil {
		t.Fatal("WorkDir built a path from ../..")
	}
	if d, err := WorkDir("/work", "claim-1"); err != nil || d != "/work/claims/claim-1" {
		t.Fatalf("%q %v", d, err)
	}
}
