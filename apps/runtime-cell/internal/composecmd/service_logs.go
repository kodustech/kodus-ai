package composecmd

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
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

// ExitedRunner runs the two commands ExitedServices needs: Ps and the last
// lines of one service's log. dockercli.CLI is one.
type ExitedRunner interface {
	ComposePs(ctx context.Context, project string) ([]byte, error)
	ComposeLogs(ctx context.Context, project, service string, lines int) ([]byte, error)
}

// ExitedServices is each service of project that has exited, with its exit
// code and the last tail lines of its log (raw: the caller redacts and caps
// them). A service whose log cannot be read still counts, with no lines.
func ExitedServices(ctx context.Context, r ExitedRunner, project string, tail int) ([]driver.ExitedService, error) {
	raw, err := r.ComposePs(ctx, project)
	if err != nil {
		return nil, fmt.Errorf("exited services: ps: %w", err)
	}
	states, err := ParseComposePs(raw)
	if err != nil {
		return nil, fmt.Errorf("exited services: ps: %w", err)
	}
	var out []driver.ExitedService
	for _, s := range states {
		if !s.Exited {
			continue
		}
		e := driver.ExitedService{Name: s.Service, State: s.State, ExitCode: s.ExitCode}
		if b, err := r.ComposeLogs(ctx, project, s.Service, tail); err == nil {
			if text := strings.TrimRight(string(b), "\n"); text != "" {
				e.Log = strings.Split(text, "\n")
			}
		}
		out = append(out, e)
	}
	return out, nil
}
