package localdocker

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// BootReport is how long the last boot or reset took, per phase, in ms.
// Build is setup plus compose build and pull; Up is up -d --wait (every
// container started and passing its own healthcheck); Seed is migrate plus
// seed; Ready is the recipe's health check. Down is the reset's down -v.
// Snapshot is copying the data volumes after the first ready boot
// (data.reset: snapshot), Restore is a reset copying them back.
type BootReport struct {
	Kind    string    `json:"kind"` // boot | reset
	At      time.Time `json:"at"`
	DownMs  int64     `json:"downMs,omitempty"`
	BuildMs int64     `json:"buildMs"`
	UpMs    int64     `json:"upMs"`
	SeedMs  int64     `json:"seedMs"`
	ReadyMs int64     `json:"readyMs"`
	// SnapshotMs and RestoreMs: data.reset: snapshot only.
	SnapshotMs int64 `json:"snapshotMs,omitempty"`
	RestoreMs  int64 `json:"restoreMs,omitempty"`
	TotalMs    int64 `json:"totalMs"`
}

const (
	bootKindBoot  = "boot"
	bootKindReset = "reset"
)

// Boot phases, as they appear in logs and errors.
const (
	phaseDown  = "down"
	phaseBuild = "build"
	phaseUp    = "up"
	phaseSeed  = "seed"
	phaseReady = "ready"
	// phaseSnapshot copies the volumes after the first ready boot;
	// phaseRestore copies them back on a reset.
	phaseSnapshot = "snapshot"
	phaseRestore  = "restore"
)

// bootRun is one boot or reset in progress: it times each phase into the
// report, logs each one as it ends and names the failing one in the error,
// so a blocker says "up: ..." instead of a bare compose message.
type bootRun struct {
	log     *slog.Logger
	machine string
	report  *BootReport
	started time.Time
}

func newBootRun(log *slog.Logger, machine, kind string) *bootRun {
	return &bootRun{log: log, machine: machine, report: &BootReport{Kind: kind}, started: time.Now()}
}

func (b *bootRun) phase(name string, f func() error) error {
	t := time.Now()
	err := f()
	ms := time.Since(t).Milliseconds()
	switch name {
	case phaseDown:
		b.report.DownMs = ms
	case phaseBuild:
		b.report.BuildMs = ms
	case phaseUp:
		b.report.UpMs = ms
	case phaseSeed:
		b.report.SeedMs = ms
	case phaseReady:
		b.report.ReadyMs += ms // twice when a snapshot restarted the app
	case phaseSnapshot:
		b.report.SnapshotMs = ms
	case phaseRestore:
		b.report.RestoreMs = ms
	}
	attrs := []any{"machine", b.machine, "kind", b.report.Kind, "phase", name, "ms", ms}
	if err != nil {
		b.log.Error("localdocker.boot.phase_failed", append(attrs, "err", err)...)
		err = fmt.Errorf("%s: %w", name, err)
		// The checkout's own phases; a snapshot copy or restore is the cell's.
		if name == phaseBuild || name == phaseUp || name == phaseSeed || name == phaseReady {
			return driver.WorkloadBootFailed(err)
		}
		return err
	}
	b.log.Info("localdocker.boot.phase", attrs...)
	return nil
}

// finish stamps the report and logs the whole run.
func (b *bootRun) finish() *BootReport {
	r := b.report
	r.At, r.TotalMs = b.started.UTC(), time.Since(b.started).Milliseconds()
	b.log.Info("localdocker."+r.Kind, "machine", b.machine, "totalMs", r.TotalMs, "downMs", r.DownMs,
		"buildMs", r.BuildMs, "upMs", r.UpMs, "seedMs", r.SeedMs, "readyMs", r.ReadyMs, "snapshotMs", r.SnapshotMs, "restoreMs", r.RestoreMs)
	return r
}

// saveBootReport keeps the report with the machine, for LastBoot.
func (d *Driver) saveBootReport(name string, r *BootReport) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if m := d.st.Machines[name]; m != nil {
		m.Boot = r
	}
	return d.saveLocked()
}

// LastBoot is the timing of the claim workload's last boot or reset.
func (d *Driver) LastBoot(claimID string) (BootReport, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.st.Machines[machineName(claimID, driver.RoleWorkload)]
	if m == nil || m.Boot == nil {
		return BootReport{}, false
	}
	return *m.Boot, true
}

// BootTiming is LastBoot for the cell agent (claim.ready.timing and the
// durationMs of a machine.reset's step.result).
func (d *Driver) BootTiming(claimID string) (driver.BootTiming, bool) {
	r, ok := d.LastBoot(claimID)
	if !ok {
		return driver.BootTiming{}, false
	}
	return driver.BootTiming{Kind: r.Kind, At: r.At, TotalMs: r.TotalMs, DownMs: r.DownMs, BuildMs: r.BuildMs, UpMs: r.UpMs, SeedMs: r.SeedMs,
		ReadyMs: r.ReadyMs, SnapshotMs: r.SnapshotMs, RestoreMs: r.RestoreMs}, true
}
