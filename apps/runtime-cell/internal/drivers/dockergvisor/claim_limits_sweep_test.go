package dockergvisor

import (
	"context"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"testing"
	"time"
)

func TestClaimLimitsExpiredClaimAfterRestartRemovesParent(t *testing.T) {
	d, docker, limits := limitedDriver(t)
	ctx := context.Background()
	s := spec()
	if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: s.OrgID, ClaimID: s.ClaimID}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Create(ctx, s); err != nil {
		t.Fatal(err)
	}
	d2, err := New(ctx, docker, Config{CellID: s.CellID, HolderImage: "holder", WorkDir: t.TempDir(), ClaimLimits: limits})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = d2.Sweep(ctx, s.HardExpiresAt.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if len(limits.groups) != 0 {
		t.Fatalf("empty parent leaked after expiry: %+v", limits.groups)
	}
}
