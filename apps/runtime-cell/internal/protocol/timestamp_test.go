package protocol

import (
	"testing"
	"time"
)

// M3: every date-time the schema accepts parses, with the same instant.
func TestParseTimeTakesWhatTheSchemaTakes(t *testing.T) {
	all, err := schemas()
	if err != nil {
		t.Fatal(err)
	}
	pattern := all["claim.renew"].Properties["leaseExpiresAt"].Pattern
	for in, want := range map[string]time.Time{
		"2026-01-02T10:00Z":              time.Date(2026, 1, 2, 10, 0, 0, 0, time.UTC),
		"2026-01-02T10:00:05Z":           time.Date(2026, 1, 2, 10, 0, 5, 0, time.UTC),
		"2026-01-02T10:00:05.123Z":       time.Date(2026, 1, 2, 10, 0, 5, 123_000_000, time.UTC),
		"2024-02-29T23:59:59.999999999Z": time.Date(2024, 2, 29, 23, 59, 59, 999_999_999, time.UTC),
	} {
		if !pattern.MatchString(in) {
			t.Fatalf("test input %q is not schema-valid", in)
		}
		got, err := ParseTime(in)
		if err != nil || !got.Equal(want) {
			t.Fatalf("%q: %v %v", in, got, err)
		}
	}
	for _, in := range []string{"2026-01-02T10:00:05+01:00", "2026-01-02 10:00:05Z", "2026-01-02", ""} {
		if _, err := ParseTime(in); err == nil {
			t.Fatalf("%q parsed", in)
		}
	}
}
