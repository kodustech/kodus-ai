package exercised

import "testing"

func TestDecodeMappingsReadsRelativeFieldsAcrossLines(t *testing.T) {
	// AAAA: 0,0,0,0. ;: next line, column resets. SAAgB: col 9, source +0, line +0, col +16. AACA: line +1.
	got, err := decodeMappings("AAAA;SAAgB,EACA")
	if err != nil {
		t.Fatal(err)
	}
	want := []segment{{0, 0, 0, 0}, {1, 9, 0, 0}, {1, 11, 0, 1}}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("segment %d: got %v, want %v", i, got[i], want[i])
		}
	}
}

func TestDecodeMappingsRefusesBadDigits(t *testing.T) {
	for _, m := range []string{"A!AA", "g", "AAAAAAA"} {
		if _, err := decodeMappings(m); err == nil {
			t.Errorf("%q decoded", m)
		}
	}
}
