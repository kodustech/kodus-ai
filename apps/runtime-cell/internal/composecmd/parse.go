package composecmd

import (
	"bufio"
	"bytes"
	"encoding/json"
	"sort"
	"strings"
	"time"
)

// ServiceState is one compose service and what it is doing ("Exited (1)
// 2 seconds ago"), as the failure bundle shows it.
type ServiceState struct {
	Service string
	State   string
}

// ParseComposePs reads `compose ps --format json`: one JSON object per line or one
// array, depending on the compose version.
func ParseComposePs(raw []byte) ([]ServiceState, error) {
	type row struct{ Service, State, Status string }
	var rows []row
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, nil
	}
	if trimmed[0] == '[' {
		if err := json.Unmarshal(trimmed, &rows); err != nil {
			return nil, err
		}
	} else {
		sc := bufio.NewScanner(bytes.NewReader(trimmed))
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			var r row
			if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
				return nil, err
			}
			rows = append(rows, r)
		}
	}
	out := make([]ServiceState, 0, len(rows))
	for _, r := range rows {
		state := r.State
		if r.Status != "" {
			state = r.Status
		}
		out = append(out, ServiceState{Service: r.Service, State: state})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Service < out[j].Service })
	return out, nil
}

// ParseTimestampedLogs reads compose logs --timestamps output: one
// "<RFC 3339 time> <text>" per line, oldest first. A line without a time
// (a continuation the daemon did not stamp) takes the previous line's.
func ParseTimestampedLogs(raw []byte) []TimedLine {
	var out []TimedLine
	var last time.Time
	for _, l := range strings.Split(strings.TrimRight(string(raw), "\n"), "\n") {
		if l == "" {
			continue
		}
		stamp, text, ok := strings.Cut(l, " ")
		at, err := time.Parse(time.RFC3339Nano, stamp)
		if !ok || err != nil {
			out = append(out, TimedLine{At: last, Text: l})
			continue
		}
		last = at
		out = append(out, TimedLine{At: at, Text: text})
	}
	return out
}

// TimedLine is one log line and when the daemon stamped it.
type TimedLine struct {
	At   time.Time
	Text string
}
