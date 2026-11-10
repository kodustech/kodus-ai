// Package reaper destroys what passed kodus:hard-expires, even while the hub
// and the cell keep renewing (docs §4 "Reaper", ADR-056, S-08). It runs
// outside the cell's VPC with its own credential, which can only describe
// and terminate this cell's machines.
package reaper

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
)

// MachineReaper is the part of MachineDriver the reaper is allowed to use:
// list and destroy, nothing else.
type MachineReaper interface {
	List(ctx context.Context, selector map[string]string) ([]driver.MachineRef, error)
	Destroy(ctx context.Context, ref driver.MachineRef) error
}

type Reaper struct {
	CellID string
	Driver MachineReaper
	Now    func() time.Time
	Log    *slog.Logger
	// Metrics, when set, gets cell_reaper_terminated_total (anything above
	// zero means the sweep and the dead-man failed: it alerts) and
	// cell_reaper_pass_failures_total.
	Metrics *metrics.Registry
	// Terminated counts what this reaper destroyed (the metric's value).
	Terminated atomic.Int64
}

type Report struct {
	Seen       int
	Terminated []string
}

func (r *Reaper) Run(ctx context.Context) (Report, error) {
	if r.CellID == "" {
		return Report{}, errors.New("reaper: cell id required")
	}
	now := time.Now
	if r.Now != nil {
		now = r.Now
	}
	log := r.Log
	if log == nil {
		log = slog.Default()
	}
	refs, err := r.Driver.List(ctx, map[string]string{driver.TagCell: r.CellID})
	if err != nil {
		return Report{}, err
	}
	rep := Report{Seen: len(refs)}
	terminated := r.Metrics.Counter("cell_reaper_terminated_total", "Machines the reaper destroyed past kodus:hard-expires (alert above zero).")
	var errs []error
	t := now()
	for _, ref := range refs {
		hard := driver.ParseExpiry(ref.Tags, driver.TagHardExpires)
		// A machine nobody can date is past its ceiling.
		if t.Before(hard) {
			continue
		}
		if err := r.Driver.Destroy(ctx, ref); err != nil {
			errs = append(errs, err)
			continue
		}
		rep.Terminated = append(rep.Terminated, ref.MachineID)
		r.Terminated.Add(1)
		terminated.Inc()
		log.Error("reaper.terminated", "machine", ref.MachineID, "claim", ref.Tags[driver.TagClaim], "hardExpires", ref.Tags[driver.TagHardExpires])
	}
	return rep, errors.Join(errs...)
}

// Loop runs every interval until ctx ends (Docker and Kubernetes; on AWS it
// is EventBridge every minute calling Run once).
func (r *Reaper) Loop(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	log := r.Log
	if log == nil {
		log = slog.Default()
	}
	failures := r.Metrics.Counter("cell_reaper_pass_failures_total", "Reaper passes that ended with an error.")
	for {
		if rep, err := r.Run(ctx); err != nil && ctx.Err() == nil {
			failures.Inc()
			log.Error("reaper.pass.failed", "alarm", true, "seen", rep.Seen, "terminated", len(rep.Terminated), "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
