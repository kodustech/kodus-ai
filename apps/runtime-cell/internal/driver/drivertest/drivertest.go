// Package drivertest is the MachineDriver conformance suite: the contract
// every driver keeps, whatever cloud or cluster it talks to. A driver's own
// tests call Run with its mock backend; a new driver is done when it passes.
//
// The suite has two tiers. The contract tier needs nothing from the
// backend: it checks what a driver refuses before it calls anything. The
// lifecycle tier needs a backend that keeps what the driver writes (an
// in-memory cluster, a state file), so it can create, list, renew and
// destroy; a driver whose test backend only records calls sets
// Subject.Lifecycle false and runs the contract tier alone.
//
// RunRequests is the request tier: every field of driver.UpRequest and
// driver.SandboxRequest, checked by what the driver's backend shows, so a
// driver cannot drop one and still pass.
package drivertest

import (
	"context"
	"errors"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/reaper"
)

// Subject is one driver under the suite, on a backend its test controls.
type Subject struct {
	Driver driver.MachineDriver
	// CellID is the cell the driver was built for.
	CellID string
	// Spec is a valid workload spec for the claim on the network
	// PrepareClaim returned, with whatever the backend needs (images, the
	// org key). Nil: BaseSpec.
	Spec func(claimID string, n driver.ClaimNetwork) driver.MachineSpec
	// Lifecycle says the backend keeps what the driver writes.
	Lifecycle bool
	// ForeignMachine plants, in the backend, a machine of another cell and
	// returns the ref a caller could hand the driver. Lifecycle only.
	ForeignMachine func(t *testing.T) driver.MachineRef
	// ForeignNetwork plants a claim network of another cell. Lifecycle
	// only; nil when the driver has no network of its own to release.
	ForeignNetwork func(t *testing.T) driver.ClaimNetwork
	// UndatedMachine plants, in the backend, a machine of this cell whose
	// kodus:hard-expires is ceiling ("" for none) and returns its id.
	// Lifecycle only.
	UndatedMachine func(t *testing.T, ceiling string) string
	// Parts are the driver's optional parts, as it gives them to cmd/cell
	// (its Parts method). With no Sweeper the reaper alone takes what passed
	// a ceiling, and the suite runs it.
	Parts driver.Parts
}

// Now is the suite's clock: every spec expires relative to it.
var Now = time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)

// BaseSpec is a valid workload spec for the claim on network n.
func BaseSpec(cellID, claimID string, n driver.ClaimNetwork) driver.MachineSpec {
	return driver.MachineSpec{
		CellID: cellID, EnvironmentID: "env-1", Role: driver.RoleWorkload, OrgID: "org-a", ClaimID: claimID,
		ImageID: "img-1", ImageRef: "img-ref-1", Size: driver.MachineSize{CPU: 2, MemoryGB: 4, DiskGB: 20},
		ClaimGroupID: n.WorkloadGroupID, KMSKeyRef: "kms-org-a",
		ExpiresAt: Now.Add(10 * time.Minute), HardExpiresAt: Now.Add(60 * time.Minute),
	}
}

// Run runs every check that applies to the subject, each on a fresh one.
func Run(t *testing.T, newSubject func(t *testing.T) Subject) {
	t.Helper()
	contract := map[string]func(*testing.T, Subject){
		"declares its capabilities":        declaresCapabilities,
		"refuses claim ids it cannot name": refusesBadClaimIDs,
		"refuses specs nobody could reap":  refusesBadSpecs,
	}
	lifecycle := map[string]func(*testing.T, Subject){
		"stamps the reserved tags":                          stampsReservedTags,
		"never lists another cell's machine":                listsOnlyItsCell,
		"renews without moving the ceiling":                 renewsUnderTheCeiling,
		"renews under the backend's ceiling, not the ref's": renewsUnderTheBackendsCeiling,
		"sweeps a machine nobody can date":                  sweepsUndatedMachines,
		"sweeps at the ceiling, not at the lease's end":     sweepsAtTheCeiling,
		"destroys idempotently":                             destroysIdempotently,
		"refuses to destroy another cell's machine":         refusesForeignDestroy,
		"refuses to renew another cell's machine":           refusesForeignRenew,
		"refuses to release another cell's network":         refusesForeignRelease,
	}
	for _, name := range sortedKeys(contract) {
		t.Run(name, func(t *testing.T) { contract[name](t, newSubject(t)) })
	}
	for _, name := range sortedKeys(lifecycle) {
		t.Run(name, func(t *testing.T) {
			s := newSubject(t)
			if !s.Lifecycle {
				t.Skip("the test backend does not keep state")
			}
			lifecycle[name](t, s)
		})
	}
}

func (s Subject) spec(claimID string, n driver.ClaimNetwork) driver.MachineSpec {
	if s.Spec != nil {
		return s.Spec(claimID, n)
	}
	return BaseSpec(s.CellID, claimID, n)
}

func (s Subject) prepare(t *testing.T, claimID string) driver.ClaimNetwork {
	t.Helper()
	n, err := s.Driver.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: "org-a", ClaimID: claimID, ObserverPort: 7443})
	if err != nil {
		t.Fatalf("PrepareClaim(%s): %v", claimID, err)
	}
	return n
}

func (s Subject) create(t *testing.T, claimID string) (driver.MachineSpec, driver.MachineRef) {
	t.Helper()
	spec := s.spec(claimID, s.prepare(t, claimID))
	ref, err := s.Driver.Create(context.Background(), spec)
	if err != nil {
		t.Fatalf("Create(%s): %v", claimID, err)
	}
	return spec, ref
}

func (s Subject) list(t *testing.T, selector map[string]string) []driver.MachineRef {
	t.Helper()
	refs, err := s.Driver.List(context.Background(), selector)
	if err != nil {
		t.Fatalf("List(%v): %v", selector, err)
	}
	return refs
}

func (s Subject) only(t *testing.T, claimID string) driver.MachineRef {
	t.Helper()
	refs := s.list(t, map[string]string{driver.TagCell: s.CellID, driver.TagClaim: claimID})
	if len(refs) != 1 {
		t.Fatalf("List(claim %s) = %d machines, want 1", claimID, len(refs))
	}
	return refs[0]
}

func declaresCapabilities(t *testing.T, s Subject) {
	if s.Driver.Kind() == "" {
		t.Error("Kind is empty")
	}
	c := s.Driver.Capabilities()
	switch c.Isolation {
	case driver.IsolationVM, driver.IsolationMicroVM, driver.IsolationSandboxedContainer, driver.IsolationNone:
	default:
		t.Errorf("isolation %q is not one the agent knows", c.Isolation)
	}
	if len(c.Arch) == 0 {
		t.Error("no architecture declared")
	}
}

// badClaimIDs could break out of a name: a path, a label, a shell word.
var badClaimIDs = []string{"", "../etc", "a b", "UPPER;rm", strings.Repeat("a", 49), "-leading"}

func refusesBadClaimIDs(t *testing.T, s Subject) {
	for _, id := range badClaimIDs {
		if _, err := s.Driver.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: "org-a", ClaimID: id}); err == nil {
			t.Errorf("PrepareClaim accepted claim id %q", id)
		}
	}
}

func refusesBadSpecs(t *testing.T, s Subject) {
	n := driver.ClaimNetwork{WorkloadGroupID: "group-claim-1", ObserverGroupID: "group-claim-1"}
	maxSize := s.Driver.Capabilities().MaxClaimSize
	cases := map[string]func(*driver.MachineSpec){
		"no cell":                   func(m *driver.MachineSpec) { m.CellID = "" },
		"no org":                    func(m *driver.MachineSpec) { m.OrgID = "" },
		"no ceiling":                func(m *driver.MachineSpec) { m.HardExpiresAt = time.Time{} },
		"expiry past the ceiling":   func(m *driver.MachineSpec) { m.ExpiresAt = m.HardExpiresAt.Add(time.Minute) },
		"no claim group":            func(m *driver.MachineSpec) { m.ClaimGroupID = "" },
		"no org key":                func(m *driver.MachineSpec) { m.KMSKeyRef = "" },
		"a reserved tag":            func(m *driver.MachineSpec) { m.Tags = map[string]string{driver.TagCell: "other"} },
		"a bad role":                func(m *driver.MachineSpec) { m.Role = "root" },
		"a claim id it cannot name": func(m *driver.MachineSpec) { m.ClaimID = "../etc" },
		// A claim never gets more than the cell grants, whatever it asks.
		"more memory than it grants": func(m *driver.MachineSpec) {
			m.ClaimSize = driver.ClaimSize{MemoryMB: maxSize.MemoryMB + 1, CPUs: max(maxSize.CPUs, 1)}
		},
		"more CPUs than it grants": func(m *driver.MachineSpec) {
			m.ClaimSize = driver.ClaimSize{MemoryMB: max(maxSize.MemoryMB, 512), CPUs: maxSize.CPUs + 1}
		},
	}
	for _, name := range sortedKeys(cases) {
		spec := s.spec("claim-1", n)
		cases[name](&spec)
		if _, err := s.Driver.Create(context.Background(), spec); err == nil {
			t.Errorf("Create accepted a spec with %s", name)
		}
	}
}

func stampsReservedTags(t *testing.T, s Subject) {
	spec, _ := s.create(t, "claim-1")
	got := s.only(t, "claim-1").Tags
	want := spec.AllTags()
	for _, k := range driver.ReservedTags {
		if got[k] != want[k] {
			t.Errorf("tag %s = %q, want %q", k, got[k], want[k])
		}
	}
}

func listsOnlyItsCell(t *testing.T, s Subject) {
	s.create(t, "claim-1")
	foreign := s.ForeignMachine(t)
	selectors := []map[string]string{
		nil,
		{driver.TagClaim: foreign.Tags[driver.TagClaim]},
		{driver.TagCell: foreign.Tags[driver.TagCell]},
	}
	for _, sel := range selectors {
		for _, ref := range s.list(t, sel) {
			if ref.Tags[driver.TagCell] != s.CellID {
				t.Errorf("List(%v) returned %s of cell %q", sel, ref.MachineID, ref.Tags[driver.TagCell])
			}
		}
	}
}

func renewsUnderTheCeiling(t *testing.T, s Subject) {
	spec, _ := s.create(t, "claim-1")
	ref := s.only(t, "claim-1")
	ctx := context.Background()
	later := spec.ExpiresAt.Add(20 * time.Minute)
	if err := s.Driver.SetExpiry(ctx, ref, later); err != nil {
		t.Fatal(err)
	}
	if got := s.only(t, "claim-1").Tags[driver.TagExpires]; got != driver.FormatTime(later) {
		t.Errorf("expires = %s after renew, want %s", got, driver.FormatTime(later))
	}
	if err := s.Driver.SetExpiry(ctx, ref, spec.HardExpiresAt.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	tags := s.only(t, "claim-1").Tags
	if tags[driver.TagExpires] != driver.FormatTime(spec.HardExpiresAt) {
		t.Errorf("expires = %s past the ceiling, want it held at %s", tags[driver.TagExpires], driver.FormatTime(spec.HardExpiresAt))
	}
	if tags[driver.TagHardExpires] != driver.FormatTime(spec.HardExpiresAt) {
		t.Errorf("hard-expires moved to %s", tags[driver.TagHardExpires])
	}
}

// A ref is the caller's: whatever ceiling it says (a later one, none), a
// renewal stops at the one the backend holds. local-docker used to clamp to
// the ref's ceiling, and not at all when the ref carried none.
func renewsUnderTheBackendsCeiling(t *testing.T, s Subject) {
	spec, _ := s.create(t, "claim-1")
	ctx := context.Background()
	forged := map[string]func(tags map[string]string){
		"a later ceiling": func(tags map[string]string) {
			tags[driver.TagHardExpires] = driver.FormatTime(spec.HardExpiresAt.Add(24 * time.Hour))
		},
		"no ceiling": func(tags map[string]string) { delete(tags, driver.TagHardExpires) },
	}
	for _, name := range sortedKeys(forged) {
		ref := s.only(t, "claim-1")
		ref.Tags = maps.Clone(ref.Tags)
		forged[name](ref.Tags)
		if err := s.Driver.SetExpiry(ctx, ref, spec.HardExpiresAt.Add(2*time.Hour)); err != nil {
			t.Fatalf("SetExpiry with %s on the ref: %v", name, err)
		}
		tags := s.only(t, "claim-1").Tags
		if tags[driver.TagExpires] != driver.FormatTime(spec.HardExpiresAt) {
			t.Errorf("with %s on the ref, expires = %s, want it held at the backend's ceiling %s", name, tags[driver.TagExpires], driver.FormatTime(spec.HardExpiresAt))
		}
		if tags[driver.TagHardExpires] != driver.FormatTime(spec.HardExpiresAt) {
			t.Errorf("with %s on the ref, hard-expires moved to %s", name, tags[driver.TagHardExpires])
		}
		if err := s.Driver.SetExpiry(ctx, s.only(t, "claim-1"), spec.ExpiresAt); err != nil {
			t.Fatal(err)
		}
	}
}

// A machine of this cell with no ceiling, or one that does not parse, is
// past it (driver.Expired): the sweep destroys it and keeps the dated one.
// The k8s sweep used to skip a pod whose ceiling did not parse.
func sweepsUndatedMachines(t *testing.T, s Subject) {
	if s.UndatedMachine == nil {
		t.Fatal("Subject.UndatedMachine is required on a backend that keeps state")
	}
	s.create(t, "claim-1")
	for _, ceiling := range []string{"", "not-a-time"} {
		id := s.UndatedMachine(t, ceiling)
		s.sweep(t, Now)
		for _, ref := range s.list(t, nil) {
			if ref.MachineID == id {
				t.Errorf("a machine with ceiling %q survived the sweep", ceiling)
			}
		}
	}
	if refs := s.list(t, map[string]string{driver.TagCell: s.CellID, driver.TagClaim: "claim-1"}); len(refs) != 1 {
		t.Errorf("the sweep took a machine under its ceiling: %d left, want 1", len(refs))
	}
}

// A sweep honors the ceiling alone: a machine past kodus:expires but under
// its ceiling is the lease manager's to end, since only it knows a claim
// the hub still renews. The microvm and local-docker sweeps used to take
// it at kodus:expires.
func sweepsAtTheCeiling(t *testing.T, s Subject) {
	spec, _ := s.create(t, "claim-1")
	s.sweep(t, spec.ExpiresAt.Add(time.Minute))
	if refs := s.list(t, map[string]string{driver.TagCell: s.CellID, driver.TagClaim: "claim-1"}); len(refs) != 1 {
		t.Fatalf("the sweep took a machine past its lease but under its ceiling")
	}
	s.sweep(t, spec.HardExpiresAt)
	if refs := s.list(t, map[string]string{driver.TagCell: s.CellID, driver.TagClaim: "claim-1"}); len(refs) != 0 {
		t.Errorf("a machine at its ceiling survived the sweep")
	}
}

// sweep runs the driver's own sweep at now, or the reaper when it has none.
func (s Subject) sweep(t *testing.T, now time.Time) {
	t.Helper()
	if s.Parts.Sweeper != nil {
		if _, err := s.Parts.Sweeper.Sweep(context.Background(), now); err != nil {
			t.Fatalf("Sweep: %v", err)
		}
		return
	}
	r := reaper.Reaper{CellID: s.CellID, Driver: s.Driver, Now: func() time.Time { return now }, Log: slog.New(slog.DiscardHandler)}
	if _, err := r.Run(context.Background()); err != nil {
		t.Fatalf("reaper: %v", err)
	}
}

func destroysIdempotently(t *testing.T, s Subject) {
	s.create(t, "claim-1")
	ref := s.only(t, "claim-1")
	for i := range 2 {
		if err := s.Driver.Destroy(context.Background(), ref); err != nil {
			t.Fatalf("Destroy #%d: %v", i+1, err)
		}
	}
	if refs := s.list(t, map[string]string{driver.TagCell: s.CellID, driver.TagClaim: "claim-1"}); len(refs) != 0 {
		t.Errorf("a destroyed machine is still listed: %v", refs)
	}
}

func refusesForeignDestroy(t *testing.T, s Subject) {
	foreign := s.ForeignMachine(t)
	if err := s.Driver.Destroy(context.Background(), foreign); !errors.Is(err, driver.ErrNotOwned) {
		t.Errorf("Destroy(another cell's machine) = %v, want ErrNotOwned", err)
	}
}

func refusesForeignRenew(t *testing.T, s Subject) {
	foreign := s.ForeignMachine(t)
	if err := s.Driver.SetExpiry(context.Background(), foreign, Now.Add(time.Hour)); !errors.Is(err, driver.ErrNotOwned) {
		t.Errorf("SetExpiry(another cell's machine) = %v, want ErrNotOwned", err)
	}
}

func refusesForeignRelease(t *testing.T, s Subject) {
	if s.ForeignNetwork == nil {
		t.Skip("the driver has no network of its own")
	}
	if err := s.Driver.ReleaseClaim(context.Background(), s.ForeignNetwork(t)); !errors.Is(err, driver.ErrNotOwned) {
		t.Errorf("ReleaseClaim(another cell's network) = %v, want ErrNotOwned", err)
	}
	n := s.prepare(t, "claim-1")
	for i := range 2 {
		if err := s.Driver.ReleaseClaim(context.Background(), n); err != nil {
			t.Fatalf("ReleaseClaim(own) #%d: %v", i+1, err)
		}
	}
}

func sortedKeys[V any](m map[string]V) []string { return slices.Sorted(maps.Keys(m)) }
