package composecmd

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// LogRunner runs the two commands ServiceLogs needs (Ps and LogsWindow)
// and returns what each printed. dockercli.CLI is one; microvm runs them
// through the guest agent.
type LogRunner interface {
	ComposePs(ctx context.Context, project string) ([]byte, error)
	ComposeLogsWindow(ctx context.Context, project, service string, since, until time.Time, lines int) ([]byte, error)
}

// ServiceLogs is what every service of project logged in [since, until] by
// the daemon's timestamps, oldest first, at most maxLines in all (the
// newest kept). A service whose logs fail is skipped; when none gave a
// line, the error joins each service's failure, so errors.Is sees them.
func ServiceLogs(ctx context.Context, r LogRunner, project string, since, until time.Time, maxLines int) ([]driver.ServiceLogLine, error) {
	if maxLines <= 0 {
		return nil, nil
	}
	raw, err := r.ComposePs(ctx, project)
	if err != nil {
		return nil, fmt.Errorf("service logs: ps: %w", err)
	}
	states, err := ParseComposePs(raw)
	if err != nil {
		return nil, fmt.Errorf("service logs: ps: %w", err)
	}
	var out []driver.ServiceLogLine
	var errs []error
	for _, s := range states {
		b, err := r.ComposeLogsWindow(ctx, project, s.Service, since, until, maxLines)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", s.Service, err))
			continue
		}
		for _, l := range ParseTimestampedLogs(b) {
			out = append(out, driver.ServiceLogLine{Service: s.Service, At: l.At, Text: l.Text})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	if len(out) > maxLines {
		out = out[len(out)-maxLines:]
	}
	if len(errs) > 0 && len(out) == 0 {
		return nil, fmt.Errorf("service logs: %w", errors.Join(errs...))
	}
	return out, nil
}
