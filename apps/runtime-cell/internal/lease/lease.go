// Package lease keeps each claim's lease, sweeps machines by tag and runs the
// dead-man switch (docs §1b "Limpeza", §4 "Lease e varredura").
package lease

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

type Lease struct {
	ClaimID       string
	OrgID         string
	Network       driver.ClaimNetwork
	Machines      []driver.MachineRef
	ExpiresAt     time.Time
	HardExpiresAt time.Time
}

var (
	ErrUnknownClaim = errors.New("lease: unknown claim")
	ErrExpired      = errors.New("lease: claim expired")
	// ErrTagsBehind: the renewal did not reach every machine's
	// kodus:expires; the lease kept its old end, the one the sweep reads.
	ErrTagsBehind = errors.New("lease: kodus:expires not moved on every machine")
)

// entry is a lease plus the lock that keeps its renewals in order: two
// renewals never write the tags out of order.
type entry struct {
	Lease
	renewMu sync.Mutex
}

type Manager struct {
	mu     sync.Mutex
	cellID string
	drv    driver.MachineDriver
	now    func() time.Time
	log    *slog.Logger
	leases map[string]*entry
}

func NewManager(cellID string, drv driver.MachineDriver, now func() time.Time, log *slog.Logger) *Manager {
	if now == nil {
		now = time.Now
	}
	if log == nil {
		log = slog.Default()
	}
	return &Manager{cellID: cellID, drv: drv, now: now, log: log, leases: map[string]*entry{}}
}

func cloneLease(l Lease) Lease {
	l.Machines = slices.Clone(l.Machines)
	return l
}

// Track records the lease, or updates the one the claim has. A renewal that
// already moved the lease further is kept: Track never moves ExpiresAt back.
func (m *Manager) Track(l Lease) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := cloneLease(l)
	if e, ok := m.leases[l.ClaimID]; ok {
		if e.ExpiresAt.After(c.ExpiresAt) {
			c.ExpiresAt = e.ExpiresAt
		}
		e.Lease = c
		return
	}
	m.leases[l.ClaimID] = &entry{Lease: c}
}

func (m *Manager) Get(claimID string) (Lease, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.leases[claimID]
	if !ok {
		return Lease{}, false
	}
	return cloneLease(e.Lease), true
}

// HasLiveLease reports whether the claim has a lease that has not expired.
func (m *Manager) HasLiveLease(claimID string) bool {
	l, ok := m.Get(claimID)
	return ok && m.now().Before(l.ExpiresAt)
}

func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.leases)
}

// Renew moves the kodus:expires tag of the claim's machines, capped at the
// claim's ceiling, and only then the lease: the lease never says live while
// a tag says expired, so the sweep never destroys a machine the hub renewed.
// A tag that did not move is ErrTagsBehind and the lease keeps its end.
func (m *Manager) Renew(ctx context.Context, claimID string, until time.Time) (time.Time, error) {
	m.mu.Lock()
	e, ok := m.leases[claimID]
	m.mu.Unlock()
	if !ok {
		return time.Time{}, ErrUnknownClaim
	}
	e.renewMu.Lock()
	defer e.renewMu.Unlock()
	m.mu.Lock()
	if m.leases[claimID] != e {
		m.mu.Unlock()
		return time.Time{}, ErrUnknownClaim
	}
	if !m.now().Before(e.ExpiresAt) {
		m.mu.Unlock()
		return time.Time{}, ErrExpired
	}
	if until.After(e.HardExpiresAt) {
		until = e.HardExpiresAt
	}
	if until.Before(e.ExpiresAt) {
		until = e.ExpiresAt
	}
	machines := slices.Clone(e.Machines)
	m.mu.Unlock()
	var errs []error
	for _, ref := range machines {
		if err := m.drv.SetExpiry(ctx, ref, until); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", ref.MachineID, err))
		}
	}
	if len(errs) > 0 {
		return time.Time{}, fmt.Errorf("%w: %w", ErrTagsBehind, errors.Join(errs...))
	}
	m.mu.Lock()
	if until.After(e.ExpiresAt) {
		e.ExpiresAt = until
	}
	m.mu.Unlock()
	return until, nil
}

// Release destroys the claim's machines and its network.
func (m *Manager) Release(ctx context.Context, claimID string) error {
	m.mu.Lock()
	e, ok := m.leases[claimID]
	delete(m.leases, claimID)
	m.mu.Unlock()
	if !ok {
		return ErrUnknownClaim
	}
	l := e.Lease
	var errs []error
	for _, ref := range l.Machines {
		if err := m.drv.Destroy(ctx, ref); err != nil {
			errs = append(errs, err)
		}
	}
	if err := m.drv.ReleaseClaim(ctx, l.Network); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// Sweep destroys every machine of this cell that has no live lease, whose
// kodus:expires passed, or whose kodus:hard-expires passed. Pool machines
// live by their own tags until adopted.
func (m *Manager) Sweep(ctx context.Context) (destroyed int, err error) {
	refs, err := m.drv.List(ctx, map[string]string{driver.TagCell: m.cellID})
	if err != nil {
		return 0, err
	}
	now := m.now()
	var errs []error
	for _, ref := range refs {
		reason := ""
		expires := driver.ParseExpiry(ref.Tags, driver.TagExpires)
		hard := driver.ParseExpiry(ref.Tags, driver.TagHardExpires)
		switch {
		case !now.Before(hard):
			reason = "hard-expires passed"
		case !now.Before(expires):
			reason = "expires passed"
		case ref.Tags[driver.TagRole] != string(driver.RolePool) && !m.HasLiveLease(ref.Tags[driver.TagClaim]):
			reason = "no live lease"
		}
		if reason == "" {
			continue
		}
		m.log.Info("sweep.destroy", "machine", ref.MachineID, "claim", ref.Tags[driver.TagClaim], "reason", reason)
		if err := m.drv.Destroy(ctx, ref); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", ref.MachineID, err))
			continue
		}
		destroyed++
		m.forgetMachine(ref)
	}
	return destroyed, errors.Join(errs...)
}

func (m *Manager) forgetMachine(ref driver.MachineRef) {
	m.mu.Lock()
	defer m.mu.Unlock()
	claim := ref.Tags[driver.TagClaim]
	l, ok := m.leases[claim]
	if !ok {
		return
	}
	kept := make([]driver.MachineRef, 0, len(l.Machines))
	for _, r := range l.Machines {
		if r.MachineID != ref.MachineID {
			kept = append(kept, r)
		}
	}
	l.Machines = kept
	if len(kept) == 0 && !m.now().Before(l.ExpiresAt) {
		delete(m.leases, claim)
	}
}

// DestroyAll is the 15-minute branch of the dead-man switch.
func (m *Manager) DestroyAll(ctx context.Context) (int, error) {
	refs, err := m.drv.List(ctx, map[string]string{driver.TagCell: m.cellID})
	if err != nil {
		return 0, err
	}
	n := 0
	var errs []error
	for _, ref := range refs {
		if err := m.drv.Destroy(ctx, ref); err != nil {
			errs = append(errs, err)
			continue
		}
		n++
	}
	m.mu.Lock()
	nets := make([]driver.ClaimNetwork, 0, len(m.leases))
	for _, l := range m.leases {
		nets = append(nets, l.Network)
	}
	m.leases = map[string]*entry{}
	m.mu.Unlock()
	for _, n := range nets {
		if err := m.drv.ReleaseClaim(ctx, n); err != nil {
			errs = append(errs, err)
		}
	}
	return n, errors.Join(errs...)
}

// DestroyExpired is the 5-minute branch: only what passed kodus:expires.
func (m *Manager) DestroyExpired(ctx context.Context) (int, error) {
	refs, err := m.drv.List(ctx, map[string]string{driver.TagCell: m.cellID})
	if err != nil {
		return 0, err
	}
	now := m.now()
	n := 0
	var errs []error
	for _, ref := range refs {
		if now.Before(driver.ParseExpiry(ref.Tags, driver.TagExpires)) && now.Before(driver.ParseExpiry(ref.Tags, driver.TagHardExpires)) {
			continue
		}
		if err := m.drv.Destroy(ctx, ref); err != nil {
			errs = append(errs, err)
			continue
		}
		n++
		m.forgetMachine(ref)
	}
	return n, errors.Join(errs...)
}
