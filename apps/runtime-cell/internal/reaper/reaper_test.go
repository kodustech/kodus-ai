package reaper

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
)

// S-08: a fake hub renews forever; the machine still goes at the ceiling.
func TestS08HubRenewingForeverStillDiesAtTheCeiling(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	d := fake.New()
	ref, err := d.Create(context.Background(), driver.MachineSpec{
		CellID: "cell-1", Role: driver.RoleWorkload, OrgID: "org-a", ClaimID: "claim-1", ImageID: "img",
		ClaimGroupID: "sg", KMSKeyRef: "k", ExpiresAt: now.Add(5 * time.Minute), HardExpiresAt: now.Add(60 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	other, _ := d.Create(context.Background(), driver.MachineSpec{
		CellID: "cell-2", Role: driver.RoleWorkload, OrgID: "org-a", ClaimID: "claim-9", ImageID: "img",
		ClaimGroupID: "sg", KMSKeyRef: "k", ExpiresAt: now.Add(5 * time.Minute), HardExpiresAt: now.Add(time.Minute),
	})
	leases := lease.NewManager("cell-1", d, clock, nil)
	leases.Track(lease.Lease{ClaimID: "claim-1", Machines: []driver.MachineRef{ref}, ExpiresAt: now.Add(5 * time.Minute), HardExpiresAt: now.Add(60 * time.Minute)})
	r := &Reaper{CellID: "cell-1", Driver: d, Now: clock}

	for i := 0; i < 59; i++ {
		now = now.Add(time.Minute)
		// The fake hub renews; the cell even tries to push the lease past
		// the ceiling, and the tag cannot move.
		_, _ = leases.Renew(context.Background(), "claim-1", now.Add(24*time.Hour))
		rep, err := r.Run(context.Background())
		if err != nil || len(rep.Terminated) != 0 {
			t.Fatalf("minute %d: %+v %v", i+1, rep, err)
		}
	}
	now = now.Add(time.Minute)
	rep, err := r.Run(context.Background())
	if err != nil || len(rep.Terminated) != 1 || rep.Terminated[0] != ref.MachineID {
		t.Fatalf("%+v %v", rep, err)
	}
	if r.Terminated.Load() != 1 {
		t.Fatal("metric not counted")
	}
	// Another cell's machine is not this reaper's business.
	for _, m := range d.Machines() {
		if m.Ref.MachineID != other.MachineID {
			t.Fatalf("left %s", m.Ref.MachineID)
		}
	}
}

func TestUndatedMachineIsReaped(t *testing.T) {
	now := time.Now()
	d := fake.New()
	ref, _ := d.Create(context.Background(), driver.MachineSpec{
		CellID: "cell-1", Role: driver.RoleWorkload, OrgID: "o", ClaimID: "c", ImageID: "i",
		ClaimGroupID: "sg", KMSKeyRef: "k", ExpiresAt: now.Add(time.Minute), HardExpiresAt: now.Add(time.Hour),
	})
	d.SetTag(ref.MachineID, driver.TagHardExpires, "garbage")
	rep, _ := (&Reaper{CellID: "cell-1", Driver: d}).Run(context.Background())
	if len(rep.Terminated) != 1 {
		t.Fatal("undated machine kept")
	}
}

type failingLister struct{ *fake.Driver }

func (failingLister) List(context.Context, map[string]string) ([]driver.MachineRef, error) {
	return nil, errors.New("UnauthorizedOperation")
}

// M13: a failing pass in loop mode used to be dropped without a word.
func TestLoopReportsAFailedPass(t *testing.T) {
	var logs bytes.Buffer
	reg := metrics.NewRegistry()
	r := &Reaper{CellID: "cell-1", Driver: failingLister{fake.New()}, Log: slog.New(slog.NewJSONHandler(&logs, nil)), Metrics: reg}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	r.Loop(ctx, time.Hour)
	if !strings.Contains(logs.String(), "reaper.pass.failed") {
		t.Fatalf("no log of the failed pass: %s", logs.String())
	}
}

// orphanDriver is a driver with an orphan pass (the microvm reaper's).
type orphanDriver struct {
	*fake.Driver
	reaped int
}

func (o *orphanDriver) ReapOrphans(context.Context) ([]string, error) {
	o.reaped++
	return []string{"tap kft0001", "cgroup kfc-0001"}, nil
}

// A driver that can end what no record names gets that pass on every run,
// after the hard-expiry one, and what it removed is reported and counted.
func TestTheReaperRunsTheDriversOrphanPass(t *testing.T) {
	o := &orphanDriver{Driver: fake.New()}
	reg := metrics.NewRegistry()
	r := &Reaper{CellID: "cell-1", Driver: o, Orphans: o, Metrics: reg}
	rep, err := r.Run(context.Background())
	if err != nil || o.reaped != 1 || len(rep.Orphans) != 2 {
		t.Fatalf("%+v %v (passes %d)", rep, err, o.reaped)
	}
	var b bytes.Buffer
	_ = reg.WriteText(&b)
	if !strings.Contains(b.String(), "cell_reaper_orphans_total 2") {
		t.Fatalf("metrics:\n%s", b.String())
	}
}
