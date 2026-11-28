package sandbox

import (
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

// MaxStopGrace is the longest stop_grace_period a service keeps: the cell's
// downs and stops wait no longer (composecmd.StopTimeoutSec), and a longer
// one held every down of the claim past its ceiling (F3-02).
const MaxStopGrace = 10 * time.Second

// stopGrace reads a stop_grace_period as compose writes it ("10s", "1m30s").
func stopGrace(v any) (time.Duration, bool) {
	s, ok := v.(string)
	if !ok {
		return 0, false
	}
	d, err := time.ParseDuration(strings.TrimSpace(s))
	return d, err == nil && d >= 0
}

func (c *checker) checkStopGrace(v any, path string) {
	if v == nil {
		return
	}
	if _, ok := stopGrace(v); !ok {
		c.add(path, "not a duration such as 10s")
	}
}

// clampStopGrace keeps the file's stop_grace_period up to MaxStopGrace.
func clampStopGrace(svc map[string]any) {
	if d, ok := stopGrace(svc["stop_grace_period"]); ok && d > MaxStopGrace {
		svc["stop_grace_period"] = MaxStopGrace.String()
	}
}

// cellTarget says why a mount target is the cell's, or "" when it is not:
// name resolution, the decoy, the coverage directory and the trust
// directory are mounted by the cell, and nothing of the file may cover them.
func cellTarget(t string) string {
	switch {
	case t == ResolvTarget || t == "/etc/hosts":
		return "name resolution is the cell's: " + t + " cannot be mounted"
	case t == DecoyTarget || coverageTarget(t) || t == machinetrust.Dir || strings.HasPrefix(t, machinetrust.Dir+"/"):
		return t + " is the cell's"
	}
	return ""
}

// tmpfsTargets reads a service's tmpfs key (one "target[:options]" or a list
// of them) as its targets; false when it is neither.
func tmpfsTargets(v any) ([]string, bool) {
	var entries []any
	switch x := v.(type) {
	case nil:
		return nil, true
	case string:
		entries = []any{x}
	case []any:
		entries = x
	default:
		return nil, false
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		s, ok := e.(string)
		if !ok || s == "" {
			return nil, false
		}
		target, _, _ := strings.Cut(s, ":")
		out = append(out, path.Clean(target))
	}
	return out, true
}

// checkTmpfs refuses a service tmpfs over a target of the cell's (F3-03): a
// tmpfs over the coverage directory emptied a Run's coverage evidence.
func (c *checker) checkTmpfs(v any, p string) {
	targets, ok := tmpfsTargets(v)
	if !ok {
		c.add(p, "neither a path nor a list of paths")
		return
	}
	for i, t := range targets {
		if why := cellTarget(t); why != "" {
			c.add(fmt.Sprintf("%s[%d]", p, i), why)
		}
	}
}
