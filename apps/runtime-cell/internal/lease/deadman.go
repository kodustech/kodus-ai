package lease

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

const (
	StopAfter    = 5 * time.Minute
	DestroyAfter = 15 * time.Minute
	// ActEvery is how often the dead-man acts again in the same state: it
	// acts on every change of state, and then at this cadence, never on
	// every Tick (each action lists the cell's machines in the cloud).
	ActEvery = time.Minute
)

type DeadManState int

const (
	Healthy DeadManState = iota
	// Lost: 5 min without the hub. No new work; expired machines destroyed.
	Lost
	// Abandoned: 15 min without the hub. Every machine destroyed.
	Abandoned
)

// DeadMan never waits for the control plane to clean the cell's own house.
type DeadMan struct {
	mu          sync.Mutex
	leases      *Manager
	now         func() time.Time
	log         *slog.Logger
	lastContact time.Time
	revoked     bool
	// acted is the state of the last action and actedAt when it ran.
	acted   DeadManState
	actedAt time.Time
}

func NewDeadMan(leases *Manager, now func() time.Time, log *slog.Logger) *DeadMan {
	if now == nil {
		now = time.Now
	}
	if log == nil {
		log = slog.Default()
	}
	return &DeadMan{leases: leases, now: now, log: log, lastContact: now()}
}

// Contact records a frame from the hub.
func (d *DeadMan) Contact() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.revoked {
		return // a revoked cell does not come back by talking
	}
	d.lastContact = d.now()
}

// Revoke is cell.revoked: the cell enters the dead-man at once.
func (d *DeadMan) Revoke() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.revoked = true
	if lost := d.now().Add(-StopAfter); d.lastContact.After(lost) {
		d.lastContact = lost
	}
}

func (d *DeadMan) State() DeadManState {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.stateLocked()
}

func (d *DeadMan) stateLocked() DeadManState {
	since := d.now().Sub(d.lastContact)
	switch {
	case since >= DestroyAfter:
		return Abandoned
	case since >= StopAfter || d.revoked:
		return Lost
	}
	return Healthy
}

// Accepting reports whether new work may start.
func (d *DeadMan) Accepting() bool { return d.State() == Healthy }

// Revoked reports whether the hub revoked this cell (cell.revoked).
func (d *DeadMan) Revoked() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.revoked
}

func (s DeadManState) String() string {
	switch s {
	case Lost:
		return "lost"
	case Abandoned:
		return "abandoned"
	}
	return "healthy"
}

// Tick applies the state; call it every few seconds. It acts when the state
// changes and then every ActEvery while it lasts.
func (d *DeadMan) Tick(ctx context.Context) DeadManState {
	d.mu.Lock()
	state := d.stateLocked()
	now := d.now()
	act := state != Healthy && (state != d.acted || now.Sub(d.actedAt) >= ActEvery)
	changed := state != d.acted
	if act || state == Healthy {
		d.acted, d.actedAt = state, now
	}
	d.mu.Unlock()
	if !act {
		return state
	}
	switch state {
	case Lost:
		if n, err := d.leases.DestroyExpired(ctx); n > 0 || err != nil || changed {
			d.log.Warn("deadman.lost", "destroyed", n, "err", err)
		}
	case Abandoned:
		if n, err := d.leases.DestroyAll(ctx); n > 0 || err != nil || changed {
			d.log.Warn("deadman.abandoned", "destroyed", n, "err", err)
		}
	}
	return state
}
