// Package fake is an in-memory MachineDriver for tests and the local
// integration run. It enforces the same invariants as the real drivers:
// validated specs, immutable kodus:hard-expires, per-claim groups. It
// isolates nothing, and says so: its isolation is "none" unless a test sets
// another, so a cell runs it only with the agent's insecure-isolation gate.
package fake

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

type Machine struct {
	Ref       driver.MachineRef
	Spec      driver.MachineSpec
	State     string // running | stopped | hibernated
	Resets    []driver.SnapshotRef
	Destroyed bool
}

type Driver struct {
	// CellID, when set, is the cell the fake belongs to: it refuses
	// another cell's machines and networks as a real driver does
	// (NewForCell). Empty keeps the fake cell-blind, for tests that build
	// specs for any cell.
	CellID   string
	mu       sync.Mutex
	seq      int
	machines map[string]*Machine
	groups   map[string]driver.ClaimNetwork
	// owners is the cell of each claim network, by workload group.
	owners map[string]string
	// Address is the private address every fake machine reports.
	Address string
	// FailCreate makes Create fail with this error (quota, capacity).
	FailCreate error
	// FailSetExpiry makes SetExpiry fail with this error (a tag API outage).
	FailSetExpiry error
	lists         int
	// Destroyed lists machine ids in the order they were destroyed.
	Destroyed []string
	// Isolation overrides the reported isolation (default none).
	Isolation driver.Isolation
	// Bakes lists every bake asked of the driver.
	Bakes []driver.BakeSpec
	// CannotBake makes the fake a driver that builds no image, as every real
	// driver is today.
	CannotBake bool
	// Diagnostics is what Diagnose answers (nil: an error).
	Diagnostics *driver.Diagnostics
	// MaxClaimSize is the largest claim size the fake grants (default none).
	MaxClaimSize driver.ClaimSize
	// FailPool makes PoolCreate fail; Adoptions lists "claim=machine".
	FailPool  error
	Adoptions []string
}

func New() *Driver {
	return &Driver{machines: map[string]*Machine{}, groups: map[string]driver.ClaimNetwork{}, owners: map[string]string{}, Address: "127.0.0.1"}
}

// NewForCell is a fake that keeps the ownership half of the contract for
// cellID.
func NewForCell(cellID string) *Driver {
	d := New()
	d.CellID = cellID
	return d
}

// owns reports whether a machine or network of cell is this fake's.
func (d *Driver) owns(cell string) bool { return d.CellID == "" || cell == d.CellID }

func (d *Driver) Kind() string { return "fake" }

func (d *Driver) Capabilities() driver.Capabilities {
	iso := d.Isolation
	if iso == "" {
		iso = driver.IsolationNone
	}
	return driver.Capabilities{Isolation: iso, NestedContainers: true, Suspend: "hibernate", Arch: []string{"x86_64", "arm64"}, Bake: !d.CannotBake, MaxClaimSize: d.MaxClaimSize}
}

func (d *Driver) Bake(_ context.Context, spec driver.BakeSpec) (driver.ImageRef, error) {
	if d.CannotBake {
		return driver.ImageRef{}, fmt.Errorf("%w: fake set to build no image", driver.ErrUnsupported)
	}
	if spec.KMSKeyRef == "" {
		return driver.ImageRef{}, fmt.Errorf("fake: bake needs the org key")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.seq++
	d.Bakes = append(d.Bakes, spec)
	return driver.ImageRef{ImageID: fmt.Sprintf("img-%s-%d", spec.EnvironmentID, d.seq), DriverRef: fmt.Sprintf("fake-ami-%d", d.seq)}, nil
}

// BakesSnapshot copies Bakes under the driver's lock (tests read it while
// the agent bakes).
func (d *Driver) BakesSnapshot() []driver.BakeSpec {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]driver.BakeSpec(nil), d.Bakes...)
}

// Diagnose answers the canned Diagnostics for a machine that still exists.
func (d *Driver) Diagnose(_ context.Context, _ string, ref driver.MachineRef, _ []driver.ExposePort) (driver.Diagnostics, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, err := d.get(ref.MachineID); err != nil {
		return driver.Diagnostics{}, err
	}
	if d.Diagnostics == nil {
		return driver.Diagnostics{}, fmt.Errorf("fake: no diagnostics")
	}
	return *d.Diagnostics, nil
}

func (d *Driver) PrepareClaim(_ context.Context, spec driver.ClaimNetworkSpec) (driver.ClaimNetwork, error) {
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.ClaimNetwork{}, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	n := driver.ClaimNetwork{WorkloadGroupID: "sg-w-" + spec.ClaimID, ObserverGroupID: "sg-o-" + spec.ClaimID}
	d.groups[spec.ClaimID] = n
	d.owners[n.WorkloadGroupID] = spec.CellID
	return n, nil
}

// PlantNetwork puts a claim network of another cell in the fake, as a
// shared account would hold it.
func (d *Driver) PlantNetwork(cellID, claimID string) driver.ClaimNetwork {
	d.mu.Lock()
	defer d.mu.Unlock()
	n := driver.ClaimNetwork{WorkloadGroupID: "sg-w-" + cellID + "-" + claimID, ObserverGroupID: "sg-o-" + cellID + "-" + claimID}
	d.owners[n.WorkloadGroupID] = cellID
	return n
}

func (d *Driver) ReleaseClaim(_ context.Context, n driver.ClaimNetwork) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if cell, ok := d.owners[n.WorkloadGroupID]; ok && !d.owns(cell) {
		return fmt.Errorf("%w: network %s", driver.ErrNotOwned, n.WorkloadGroupID)
	}
	delete(d.owners, n.WorkloadGroupID)
	for k, v := range d.groups {
		if v.WorkloadGroupID == n.WorkloadGroupID {
			delete(d.groups, k)
		}
	}
	return nil
}

func (d *Driver) Create(_ context.Context, spec driver.MachineSpec) (driver.MachineRef, error) {
	if err := spec.ValidateFor(d.Capabilities()); err != nil {
		return driver.MachineRef{}, err
	}
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.MachineRef{}, err
	}
	if !d.owns(spec.CellID) {
		return driver.MachineRef{}, fmt.Errorf("%w: spec for cell %s", driver.ErrNotOwned, spec.CellID)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.FailCreate != nil {
		return driver.MachineRef{}, d.FailCreate
	}
	d.seq++
	id := fmt.Sprintf("m-%d", d.seq)
	ref := driver.MachineRef{MachineID: id, DriverRef: "fake-" + id, PrivateAddress: d.Address, ImageID: spec.ImageID, Tags: spec.AllTags()}
	d.machines[id] = &Machine{Ref: ref, Spec: spec, State: "running"}
	return cloneRef(ref), nil
}

func (d *Driver) get(id string) (*Machine, error) {
	m, ok := d.machines[id]
	if !ok {
		return nil, fmt.Errorf("fake: machine %s not found", id)
	}
	return m, nil
}

func (d *Driver) Suspend(_ context.Context, ref driver.MachineRef, mode driver.SuspendMode) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	m, err := d.get(ref.MachineID)
	if err != nil {
		return err
	}
	m.State = map[driver.SuspendMode]string{driver.SuspendStop: "stopped", driver.SuspendHibernate: "hibernated"}[mode]
	return nil
}

func (d *Driver) Resume(_ context.Context, ref driver.MachineRef) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	m, err := d.get(ref.MachineID)
	if err != nil {
		return err
	}
	m.State = "running"
	return nil
}

func (d *Driver) Reset(_ context.Context, ref driver.MachineRef, snap driver.SnapshotRef) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	m, err := d.get(ref.MachineID)
	if err != nil {
		return err
	}
	m.Resets = append(m.Resets, snap)
	return nil
}

func (d *Driver) Destroy(_ context.Context, ref driver.MachineRef) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	m, ok := d.machines[ref.MachineID]
	if !ok {
		return nil // already gone: destroy is idempotent
	}
	if !d.owns(m.Ref.Tags[driver.TagCell]) {
		return fmt.Errorf("%w: machine %s", driver.ErrNotOwned, ref.MachineID)
	}
	delete(d.machines, ref.MachineID)
	d.Destroyed = append(d.Destroyed, ref.MachineID)
	return nil
}

func (d *Driver) List(_ context.Context, selector map[string]string) ([]driver.MachineRef, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.lists++
	var out []driver.MachineRef
	for _, m := range d.machines {
		if d.owns(m.Ref.Tags[driver.TagCell]) && driver.Matches(m.Ref.Tags, selector) {
			out = append(out, cloneRef(m.Ref))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MachineID < out[j].MachineID })
	return out, nil
}

func (d *Driver) SetExpiry(_ context.Context, ref driver.MachineRef, at time.Time) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.FailSetExpiry != nil {
		return d.FailSetExpiry
	}
	m, err := d.get(ref.MachineID)
	if err != nil {
		return err
	}
	if !d.owns(m.Ref.Tags[driver.TagCell]) {
		return fmt.Errorf("%w: machine %s", driver.ErrNotOwned, ref.MachineID)
	}
	if at.After(driver.ParseExpiry(m.Ref.Tags, driver.TagHardExpires)) {
		at = driver.ParseExpiry(m.Ref.Tags, driver.TagHardExpires)
	}
	m.Ref.Tags[driver.TagExpires] = driver.FormatTime(at)
	return nil
}

// Plant puts a machine of another cell in the fake, as a shared account
// would hold it, and returns its ref.
func (d *Driver) Plant(cellID, claimID string) driver.MachineRef {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.seq++
	id := fmt.Sprintf("m-%d", d.seq)
	ref := driver.MachineRef{MachineID: id, DriverRef: "fake-" + id, Tags: map[string]string{
		driver.TagCell: cellID, driver.TagClaim: claimID, driver.TagRole: string(driver.RoleWorkload)}}
	d.machines[id] = &Machine{Ref: ref, State: "running"}
	return cloneRef(ref)
}

// ListCalls counts List calls (each one is a cloud API call on a real
// driver).
func (d *Driver) ListCalls() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.lists
}

// DestroyedIDs copies Destroyed under the driver's lock.
func (d *Driver) DestroyedIDs() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.Destroyed...)
}

// SetFailCreate sets FailCreate under the driver's lock (tests that change
// it while the agent runs).
func (d *Driver) SetFailCreate(err error) {
	d.mu.Lock()
	d.FailCreate = err
	d.mu.Unlock()
}

// SetTag lets a test plant a tag (for example a wrong org on a pool machine).
func (d *Driver) SetTag(id, key, value string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if m, ok := d.machines[id]; ok {
		m.Ref.Tags[key] = value
	}
}

// Machines returns a snapshot of the live machines.
func (d *Driver) Machines() []Machine {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []Machine
	for _, m := range d.machines {
		c := *m
		c.Ref = cloneRef(m.Ref)
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ref.MachineID < out[j].Ref.MachineID })
	return out
}

func cloneRef(r driver.MachineRef) driver.MachineRef {
	tags := make(map[string]string, len(r.Tags))
	for k, v := range r.Tags {
		tags[k] = v
	}
	r.Tags = tags
	return r
}

var _ driver.MachineDriver = (*Driver)(nil)

// PoolCreate makes a pool machine on a network of its own, as a driver
// that pools does (driver.Pooler). FailPool makes it fail.
func (d *Driver) PoolCreate(ctx context.Context, spec driver.PoolSpec) (driver.PoolMachine, error) {
	d.mu.Lock()
	fail := d.FailPool
	d.seq++
	id := fmt.Sprintf("pool-%d", d.seq)
	d.mu.Unlock()
	if fail != nil {
		return driver.PoolMachine{}, fail
	}
	net, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: spec.CellID, OrgID: spec.OrgID, ClaimID: id})
	if err != nil {
		return driver.PoolMachine{}, err
	}
	ref, err := d.Create(ctx, driver.MachineSpec{CellID: spec.CellID, EnvironmentID: spec.EnvironmentID, Role: driver.RolePool, OrgID: spec.OrgID, ClaimID: id,
		ImageID: spec.ImageID, ImageRef: spec.ImageID, Size: spec.Size, ClaimSize: spec.ClaimSize, ClaimGroupID: net.WorkloadGroupID, KMSKeyRef: spec.KMSKeyRef,
		ExpiresAt: spec.ExpiresAt, HardExpiresAt: spec.HardExpiresAt})
	if err != nil {
		return driver.PoolMachine{}, err
	}
	return driver.PoolMachine{Network: net, Workload: ref, OrgID: spec.OrgID, EnvironmentID: spec.EnvironmentID, ImageID: spec.ImageID, HardExpiresAt: spec.HardExpiresAt, ClaimSize: spec.ClaimSize}, nil
}

// Adopt records the claim the pool machine went to (Adoptions).
func (d *Driver) Adopt(_ context.Context, p driver.PoolMachine, claimID string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if m := d.machines[p.Workload.MachineID]; m == nil || m.Destroyed {
		return fmt.Errorf("fake: pool machine %s is gone", p.Workload.MachineID)
	}
	d.Adoptions = append(d.Adoptions, claimID+"="+p.Workload.MachineID)
	return nil
}

// AdoptionsSnapshot copies Adoptions under the driver's lock.
func (d *Driver) AdoptionsSnapshot() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.Adoptions...)
}

// SpecOf is the spec a machine was created with (false when it was not).
func (d *Driver) SpecOf(machineID string) (driver.MachineSpec, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.machines[machineID]
	if m == nil {
		return driver.MachineSpec{}, false
	}
	return m.Spec, true
}
