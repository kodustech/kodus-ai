package protocol

import (
	"fmt"
	"time"
)

// Layouts of the schema's date-time (zod's z.iso.datetime()): UTC with "Z",
// seconds optional, any fraction. time.RFC3339 alone requires the seconds,
// so it refused frames both decoders accept.
var timeLayouts = []string{
	"2006-01-02T15:04:05.999999999Z",
	"2006-01-02T15:04Z",
}

// ParseTime reads a date-time field of a message body (hardExpiresAt,
// leaseExpiresAt, issuedAt...) exactly as the schema writes it.
func ParseTime(s string) (time.Time, error) {
	for _, l := range timeLayouts {
		if t, err := time.Parse(l, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("protocol: %q is not a UTC date-time", s)
}

// FormatTime is how the cell writes a date-time field: UTC, seconds.
func FormatTime(t time.Time) string { return t.UTC().Format(time.RFC3339) }
