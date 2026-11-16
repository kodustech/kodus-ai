//go:build linux

package fcregress

import (
	"context"
	"math"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// A machine's wall clock follows the host's through the KVM PTP clock: a
// clock set 30 s ahead inside the VM (as root, the environment's agent) is
// back on the host's within a few sync intervals, without the rebirth.
func TestFirecrackerGuestWallClockFollowsTheHost(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	claim := "fc-clock-" + time.Now().Format("150405")
	n, err := s.Driver.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cellID, OrgID: "org-fc", ClaimID: claim})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Driver.ReleaseClaim(context.Background(), n) })
	now := time.Now()
	ref, err := s.Driver.Create(ctx, driver.MachineSpec{
		CellID: cellID, EnvironmentID: "env-fc", Role: driver.RoleWorkload, OrgID: "org-fc", ClaimID: claim,
		ImageID: "environment", ImageRef: "environment", ClaimGroupID: n.WorkloadGroupID, KMSKeyRef: "kms-org-fc",
		ClaimSize: driver.ClaimSize{MemoryMB: 2048, CPUs: 2}, ExpiresAt: now.Add(10 * time.Minute), HardExpiresAt: now.Add(30 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Driver.Destroy(context.Background(), ref) })
	var c *guest.Client
	for c == nil {
		if rw, err := s.Driver.DialGuest(ctx, ref); err == nil {
			c = guest.NewClient(rw, cellID, claim)
		} else if time.Since(now) > time.Minute {
			t.Fatalf("the guest agent never answered: %v", err)
		} else {
			time.Sleep(200 * time.Millisecond)
		}
	}
	defer c.Close()
	sh := func(cmd string) string {
		timeout := int64(30_000)
		r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &cmd, TimeoutMs: &timeout})
		if err != nil || r.Exec == nil || r.Exec.ExitCode != 0 {
			t.Fatalf("%s: %+v %v", cmd, r, err)
		}
		return strings.TrimSpace(r.Exec.Stdout)
	}
	if got := sh("ls /dev/ptp0"); got != "/dev/ptp0" {
		t.Fatalf("no KVM PTP clock in the guest: %q", got)
	}
	// The guest's clock minus the host's, the host read around the exec.
	skew := func() time.Duration {
		before := time.Now()
		out := sh("date +%s.%N")
		after := time.Now()
		f, err := strconv.ParseFloat(out, 64)
		if err != nil {
			t.Fatal(err)
		}
		mid := before.Add(after.Sub(before) / 2)
		return time.Duration(f*1e9) - time.Duration(mid.UnixNano())
	}
	t.Logf("skew at boot: %v", skew())
	sh("date -s @$(( $(date +%s) + 30 )) >/dev/null")
	if d := skew(); d < 25*time.Second {
		t.Fatalf("the clock was not set ahead: %v", d)
	}
	start := time.Now()
	for {
		d := skew()
		if math.Abs(float64(d)) < float64(250*time.Millisecond) {
			t.Logf("back on the host's clock in %v (skew %v)", time.Since(start).Round(time.Millisecond), d)
			return
		}
		if time.Since(start) > 15*time.Second {
			t.Fatalf("still %v off the host's clock after %v", d, time.Since(start))
		}
		time.Sleep(500 * time.Millisecond)
	}
}
