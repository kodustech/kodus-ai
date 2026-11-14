package driver

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
)

// Outcomes of a driver call, as cell_driver_calls_total counts them.
const (
	OutcomeOK          = "ok"
	OutcomeError       = "error"
	OutcomeNotOwned    = "not_owned"
	OutcomeUnsupported = "unsupported"
)

// Outcome names what a driver call's error means: a refusal of another
// cell's machine is a security signal, an unsupported call a fact about the
// driver, anything else a fault.
func Outcome(err error) string {
	switch {
	case err == nil:
		return OutcomeOK
	case errors.Is(err, ErrNotOwned):
		return OutcomeNotOwned
	case errors.Is(err, ErrUnsupported):
		return OutcomeUnsupported
	}
	return OutcomeError
}

// observed is a MachineDriver that counts and times every call of the one
// it wraps, and logs a refusal of another cell's machine as the security
// event it is. It adds no behavior: what the driver answers is what the
// caller gets.
type observed struct {
	next     MachineDriver
	log      *slog.Logger
	calls    *metrics.Vec
	millis   *metrics.Vec
	notOwned *metrics.Vec
}

// Observed wraps d with metrics on reg and logs on log. Wrap once, where the
// cell picks its driver, so every caller is measured the same way.
func Observed(d MachineDriver, reg *metrics.Registry, log *slog.Logger) MachineDriver {
	if log == nil {
		log = slog.Default()
	}
	return &observed{
		next:     d,
		log:      log.With("driver", d.Kind()),
		calls:    reg.Counter("cell_driver_calls_total", "Driver calls, by operation and outcome (ok, error, not_owned, unsupported).", "op", "outcome"),
		millis:   reg.Counter("cell_driver_call_milliseconds_total", "Time spent in driver calls, by operation; divide by calls for the mean.", "op"),
		notOwned: reg.Counter("cell_driver_not_owned_total", "Driver calls refused because the machine or network is another cell's (alert above zero).", "op"),
	}
}

func (o *observed) record(op string, started time.Time, err error, attrs ...any) {
	outcome := Outcome(err)
	o.calls.Inc(op, outcome)
	o.millis.Add(float64(time.Since(started).Milliseconds()), op)
	switch outcome {
	case OutcomeNotOwned:
		o.notOwned.Inc(op)
		o.log.Error("driver.not_owned", append(attrs, "op", op, "err", err)...)
	case OutcomeError:
		o.log.Warn("driver.call_failed", append(attrs, "op", op, "err", err)...)
	}
}

// Unwrap is the driver it observes: optional interfaces (MemoryBudget) are
// found on it through MemoryBudgetOf, not on the wrapper.
func (o *observed) Unwrap() MachineDriver { return o.next }

func (o *observed) Kind() string               { return o.next.Kind() }
func (o *observed) Capabilities() Capabilities { return o.next.Capabilities() }

func (o *observed) Bake(ctx context.Context, spec BakeSpec) (ImageRef, error) {
	t := time.Now()
	img, err := o.next.Bake(ctx, spec)
	o.record("bake", t, err, "env", spec.EnvironmentID, "org", spec.OrgID)
	return img, err
}

func (o *observed) PrepareClaim(ctx context.Context, spec ClaimNetworkSpec) (ClaimNetwork, error) {
	t := time.Now()
	n, err := o.next.PrepareClaim(ctx, spec)
	o.record("prepare_claim", t, err, "claim", spec.ClaimID)
	return n, err
}

func (o *observed) ReleaseClaim(ctx context.Context, n ClaimNetwork) error {
	t := time.Now()
	err := o.next.ReleaseClaim(ctx, n)
	o.record("release_claim", t, err, "network", n.WorkloadGroupID)
	return err
}

func (o *observed) Create(ctx context.Context, spec MachineSpec) (MachineRef, error) {
	t := time.Now()
	ref, err := o.next.Create(ctx, spec)
	o.record("create", t, err, "claim", spec.ClaimID, "role", spec.Role)
	return ref, err
}

func (o *observed) Suspend(ctx context.Context, ref MachineRef, mode SuspendMode) error {
	t := time.Now()
	err := o.next.Suspend(ctx, ref, mode)
	o.record("suspend", t, err, "machine", ref.MachineID)
	return err
}

func (o *observed) Resume(ctx context.Context, ref MachineRef) error {
	t := time.Now()
	err := o.next.Resume(ctx, ref)
	o.record("resume", t, err, "machine", ref.MachineID)
	return err
}

func (o *observed) Reset(ctx context.Context, ref MachineRef, snap SnapshotRef) error {
	t := time.Now()
	err := o.next.Reset(ctx, ref, snap)
	o.record("reset", t, err, "machine", ref.MachineID, "snapshot", snap.Kind)
	return err
}

func (o *observed) Destroy(ctx context.Context, ref MachineRef) error {
	t := time.Now()
	err := o.next.Destroy(ctx, ref)
	o.record("destroy", t, err, "machine", ref.MachineID)
	return err
}

func (o *observed) List(ctx context.Context, selector map[string]string) ([]MachineRef, error) {
	t := time.Now()
	refs, err := o.next.List(ctx, selector)
	o.record("list", t, err)
	return refs, err
}

func (o *observed) SetExpiry(ctx context.Context, ref MachineRef, expiresAt time.Time) error {
	t := time.Now()
	err := o.next.SetExpiry(ctx, ref, expiresAt)
	o.record("set_expiry", t, err, "machine", ref.MachineID)
	return err
}
