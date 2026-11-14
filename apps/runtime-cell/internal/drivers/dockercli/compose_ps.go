package dockercli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"sort"
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
