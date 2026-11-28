package lease

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func setup(t *testing.T) (*clock, *fake.Driver, *Manager) {
	t.Helper()
	c := &clock{t: time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)}
	d := fake.New()
	return c, d, NewManager("cell-1", d, c.now, nil)
}

func machine(t *testing.T, c *clock, d *fake.Driver, claim string, role driver.Role, expires, hard time.Duration) driver.MachineRef {
	t.Helper()
	ref, err := d.Create(context.Background(), driver.MachineSpec{
		CellID: "cell-1", Role: role, OrgID: "org-a", ClaimID: claim, ImageID: "img",
		ClaimGroupID: "sg", KMSKeyRef: "k", ExpiresAt: c.t.Add(expires), HardExpiresAt: c.t.Add(hard),
	})
	if err != nil {
		t.Fatal(err)
	}
	return ref
}

func TestRenewIsCappedAtTheCeiling(t *testing.T) {
	c, d, m := setup(t)
	ref := machine(t, c, d, "claim-1", driver.RoleWorkload, 5*time.Minute, 60*time.Minute)
	m.Track(Lease{ClaimID: "claim-1", Machines: []driver.MachineRef{ref}, ExpiresAt: c.t.Add(5 * time.Minute), HardExpiresAt: c.t.Add(60 * time.Minute)})
	got, err := m.Renew(context.Background(), "claim-1", c.t.Add(10*time.Hour))
	if err != nil || !got.Equal(c.t.Add(60*time.Minute)) {
		t.Fatalf("%v %v", got, err)
	}
	if d.Machines()[0].Ref.Tags[driver.TagExpires] != "2026-10-29T13:00:00Z" {
		t.Fatal("tag not moved")
	}
	c.t = c.t.Add(61 * time.Minute)
	if _, err := m.Renew(context.Background(), "claim-1", c.t.Add(time.Minute)); !errors.Is(err, ErrExpired) {
		t.Fatalf("renewed past the ceiling: %v", err)
	}
	if _, err := m.Renew(context.Background(), "nope", c.t); !errors.Is(err, ErrUnknownClaim) {
		t.Fatal(err)
	}
}

func TestSweepDestroysWhatNobodyOwns(t *testing.T) {
	c, d, m := setup(t)
	owned := machine(t, c, d, "claim-1", driver.RoleWorkload, 5*time.Minute, time.Hour)
	m.Track(Lease{ClaimID: "claim-1", Machines: []driver.MachineRef{owned}, ExpiresAt: c.t.Add(5 * time.Minute), HardExpiresAt: c.t.Add(time.Hour)})
	orphan := machine(t, c, d, "claim-gone", driver.RoleWorkload, 5*time.Minute, time.Hour)
	pool := machine(t, c, d, "pool-1", driver.RolePool, 7*24*time.Hour, 7*24*time.Hour)
	n, err := m.Sweep(context.Background())
	if err != nil || n != 1 || d.Destroyed[0] != orphan.MachineID {
		t.Fatalf("n=%d err=%v destroyed=%v", n, err, d.Destroyed)
	}
	c.t = c.t.Add(6 * time.Minute)
	if n, _ := m.Sweep(context.Background()); n != 1 || d.Destroyed[1] != owned.MachineID {
		t.Fatalf("expired machine kept: %v", d.Destroyed)
	}
	if len(d.Machines()) != 1 || d.Machines()[0].Ref.MachineID != pool.MachineID {
		t.Fatal("pool machine swept")
	}
}

func TestDeadMan(t *testing.T) {
	c, d, m := setup(t)
	dm := NewDeadMan(m, c.now, nil)
	expiring := machine(t, c, d, "claim-1", driver.RoleWorkload, 2*time.Minute, time.Hour)
	lasting := machine(t, c, d, "claim-2", driver.RoleWorkload, 30*time.Minute, time.Hour)
	m.Track(Lease{ClaimID: "claim-1", Machines: []driver.MachineRef{expiring}, ExpiresAt: c.t.Add(2 * time.Minute), HardExpiresAt: c.t.Add(time.Hour)})
	m.Track(Lease{ClaimID: "claim-2", Machines: []driver.MachineRef{lasting}, ExpiresAt: c.t.Add(30 * time.Minute), HardExpiresAt: c.t.Add(time.Hour)})

	c.t = c.t.Add(4 * time.Minute)
	if dm.Tick(context.Background()) != Healthy || !dm.Accepting() || len(d.Destroyed) != 0 {
		t.Fatal("acted before 5 min")
	}
	c.t = c.t.Add(time.Minute)
	if dm.Tick(context.Background()) != Lost || dm.Accepting() {
		t.Fatal("still accepting after 5 min without hub")
	}
	if len(d.Destroyed) != 1 || d.Destroyed[0] != expiring.MachineID {
		t.Fatalf("5 min: destroyed %v, want only the expired one", d.Destroyed)
	}
	c.t = c.t.Add(10 * time.Minute)
	if dm.Tick(context.Background()) != Abandoned || len(d.Machines()) != 0 {
		t.Fatal("15 min: machines left")
	}
	dm.Contact()
	if !dm.Accepting() {
		t.Fatal("hub back, still refusing")
	}
}

func TestRevokedCellStopsAtOnce(t *testing.T) {
	c, _, m := setup(t)
	dm := NewDeadMan(m, c.now, nil)
	dm.Revoke()
	if dm.Accepting() {
		t.Fatal("revoked cell accepts work")
	}
	dm.Contact()
	if dm.Accepting() {
		t.Fatal("revoked cell came back by talking")
	}
	c.t = c.t.Add(10 * time.Minute)
	if dm.State() != Abandoned {
		t.Fatal("revocation did not start the dead-man clock")
	}
}

// M9: a renewal whose tag write fails is not a renewal: the lease keeps the
// end the tags (and so the sweep) still have.
func TestRenewKeepsTheLeaseWhenATagDoesNotMove(t *testing.T) {
	c, d, m := setup(t)
	ref := machine(t, c, d, "claim-1", driver.RoleWorkload, 5*time.Minute, time.Hour)
	end := c.t.Add(5 * time.Minute)
	m.Track(Lease{ClaimID: "claim-1", Machines: []driver.MachineRef{ref}, ExpiresAt: end, HardExpiresAt: c.t.Add(time.Hour)})
	d.FailSetExpiry = errors.New("RequestLimitExceeded")
	if _, err := m.Renew(context.Background(), "claim-1", c.t.Add(30*time.Minute)); !errors.Is(err, ErrTagsBehind) {
		t.Fatalf("want ErrTagsBehind, got %v", err)
	}
	if l, _ := m.Get("claim-1"); !l.ExpiresAt.Equal(end) {
		t.Fatalf("lease moved to %s although the tag did not", l.ExpiresAt)
	}
}

// Track never rewinds a renewal, and the stored lease shares no slice with
// the caller's.
func TestTrackKeepsRenewalsAndCopiesMachines(t *testing.T) {
	c, d, m := setup(t)
	ref := machine(t, c, d, "claim-1", driver.RoleWorkload, 5*time.Minute, time.Hour)
	l := Lease{ClaimID: "claim-1", Machines: make([]driver.MachineRef, 1, 4), ExpiresAt: c.t.Add(5 * time.Minute), HardExpiresAt: c.t.Add(time.Hour)}
	l.Machines[0] = ref
	m.Track(l)
	if _, err := m.Renew(context.Background(), "claim-1", c.t.Add(30*time.Minute)); err != nil {
		t.Fatal(err)
	}
	m.Track(l) // prepare tracks again with its first lease end
	if got, _ := m.Get("claim-1"); !got.ExpiresAt.Equal(c.t.Add(30 * time.Minute)) {
		t.Fatalf("Track rewound the renewal to %s", got.ExpiresAt)
	}
	l.Machines[0].MachineID = "mutated"
	if got, _ := m.Get("claim-1"); got.Machines[0].MachineID != ref.MachineID {
		t.Fatal("the stored lease aliases the caller's slice")
	}
}

// The dead-man acts when its state changes and then once per ActEvery, not
// on every tick: each action is a cloud List.
func TestDeadManActsOnChangeThenAtItsCadence(t *testing.T) {
	c, d, m := setup(t)
	dm := NewDeadMan(m, c.now, nil)
	c.t = c.t.Add(StopAfter)
	for i := 0; i < 10; i++ {
		dm.Tick(context.Background())
		c.t = c.t.Add(5 * time.Second)
	}
	if n := d.ListCalls(); n != 1 {
		t.Fatalf("10 ticks within a minute listed %d times, want 1", n)
	}
	c.t = c.t.Add(ActEvery)
	dm.Tick(context.Background())
	if n := d.ListCalls(); n != 2 {
		t.Fatalf("after ActEvery: %d lists, want 2", n)
	}
}

// slowDestroy holds the first destroy of a machine open until the test lets
// it go, so a sweep can run in the middle of a release.
type slowDestroy struct {
	*fake.Driver
	once    chan struct{} // closed when the first destroy has started
	proceed chan struct{}
	mu      sync.Mutex
	started bool
}

func (s *slowDestroy) Destroy(ctx context.Context, ref driver.MachineRef) error {
	s.mu.Lock()
	first := !s.started
	s.started = true
	s.mu.Unlock()
	if first {
		close(s.once)
		<-s.proceed
	}
	return s.Driver.Destroy(ctx, ref)
}

// Release dropped the lease and then destroyed the machines one by one: a
// sweep in between found the rest with no live lease and destroyed them
// too, and the release's own docker rm failed on a removal already in
// progress (dev cell, 2026-11-19). A sweep during a release leaves the
// claim's machines to the release.
func TestSweepLeavesTheMachinesOfAClaimBeingReleased(t *testing.T) {
	c, d, _ := setup(t)
	workload := machine(t, c, d, "claim-1", driver.RoleWorkload, 5*time.Minute, time.Hour)
	observer := machine(t, c, d, "claim-1", driver.RoleObserver, 5*time.Minute, time.Hour)
	slow := &slowDestroy{Driver: d, once: make(chan struct{}), proceed: make(chan struct{})}
	m := NewManager("cell-1", slow, c.now, nil)
	m.Track(Lease{ClaimID: "claim-1", Machines: []driver.MachineRef{workload, observer}, ExpiresAt: c.t.Add(5 * time.Minute), HardExpiresAt: c.t.Add(time.Hour)})

	released := make(chan error, 1)
	go func() { released <- m.Release(context.Background(), "claim-1") }()
	<-slow.once // the release is destroying the workload
	n, err := m.Sweep(context.Background())
	close(slow.proceed)
	if err := <-released; err != nil {
		t.Fatalf("release: %v", err)
	}
	if err != nil || n != 0 {
		t.Fatalf("the sweep destroyed %d machine(s) of a claim being released (err %v)", n, err)
	}
	if len(d.Machines()) != 0 {
		t.Fatalf("release left %v", d.Machines())
	}
	// Once the release returned, the claim is no one's: a later machine of
	// it (a leftover) is swept again.
	machine(t, c, d, "claim-1", driver.RoleWorkload, 5*time.Minute, time.Hour)
	if n, _ := m.Sweep(context.Background()); n != 1 {
		t.Fatalf("a leftover of a released claim was not swept: %d", n)
	}
}
