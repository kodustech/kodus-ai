//go:build linux

package fcregress

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

// diskCeilingGB is the cell's data disk ceiling in this test: small, so a
// VM at the ceiling fills in seconds.
const diskCeilingGB = 4

// An environment's data disk on real VMs (docs/runtime/isolation-p3-snapshots.md,
// "Disk per environment"): the bake measures the setup's peak and the
// environment's next VM boots with that disk (×1.5, whole GiB), not the
// cell's ceiling; that VM filling its disk is resources/disk_capacity and
// moves the environment to the ceiling; a VM at the ceiling filling it is
// disk_capacity naming the ceiling.
func TestFirecrackerAnEnvironmentsDataDiskIsSizedFromItsSetup(t *testing.T) {
	s := open(t, func(f *microvm.Firecracker) { f.DataGB = diskCeilingGB })
	ctx := context.Background()
	env := "env-disk-" + time.Now().Format("150405")
	spec := func(claim string, n driver.ClaimNetwork, setup bool) driver.MachineSpec {
		return machineSpec(claim, n, driver.RoleWorkload, func(m *driver.MachineSpec) {
			m.EnvironmentID, m.Setup, m.ImageID, m.ImageRef, m.ClaimSize = env, setup, "environment", "environment", driver.ClaimSize{MemoryMB: 1024, CPUs: 1}
		})
	}
	sh := func(ref driver.MachineRef, cmd string, timeoutMs int64) string {
		t.Helper()
		r, err := s.Driver.Exec(ctx, ref, kodyexec.Request{Command: cmd, TimeoutMs: timeoutMs})
		if err != nil || r.ExitCode != 0 {
			t.Fatalf("%q in %s: %+v %v", cmd, ref.MachineID, r, err)
		}
		return strings.TrimSpace(r.Stdout)
	}
	dataGiB := func(ref driver.MachineRef) float64 {
		t.Helper()
		n, err := strconv.ParseInt(sh(ref, "df -B1 --output=size /var/lib/kody-data | tail -1", 10_000), 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		return float64(n) / (1 << 30)
	}
	boot := func(claim string, setup bool) driver.MachineRef {
		t.Helper()
		n := claimNet(t, s.Driver, claim) //nolint:contextcheck // the helper makes and releases a claim network on its own context, as the other tests'.
		ref, err := s.Driver.Create(ctx, spec(claim, n, setup))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = s.Driver.Destroy(context.WithoutCancel(ctx), ref) })
		sh(ref, "for i in $(seq 120); do mountpoint -q /var/lib/kody-data && exit 0; sleep 0.5; done; exit 1", 90_000)
		return ref
	}
	// A compose project that cannot start (its image is absent, never pulled):
	// its up fails at once, as a build that ran out of disk would.
	project := t.TempDir()
	compose := []byte("services:\n  app:\n    image: kodus-fcregress-absent:1\n    pull_policy: never\n")
	if err := os.WriteFile(filepath.Join(project, "docker-compose.yml"), compose, 0o600); err != nil {
		t.Fatal(err)
	}
	upOnFullDisk := func(ref driver.MachineRef) error {
		t.Helper()
		if err := s.Driver.Upload(ctx, ref, project, "workspace/repo", nil); err != nil {
			t.Fatal(err)
		}
		// Fill the data disk but its last 128 MiB: the cell's compose file still fits.
		sh(ref, "A=$(df -B1M --output=avail /var/lib/kody-data | tail -1); dd if=/dev/zero of=/var/lib/kody-data/fill bs=1M count=$((A-128)) status=none; sync", 300_000)
		_, err := s.Driver.Up(ctx, driver.UpRequest{Ref: ref, Compose: compose, ProjectDir: project})
		return err
	}

	// The setup: no need measured yet, so it boots at the ceiling; it writes
	// 1.5 GiB on its data disk and is baked.
	src := boot("disk-setup-"+env, true)
	if got := dataGiB(src); got < diskCeilingGB-0.5 {
		t.Fatalf("the first setup's data disk is %.1f GiB, not the %d GiB ceiling", got, diskCeilingGB)
	}
	sh(src, "dd if=/dev/urandom of=/var/lib/kody-data/build bs=4M count=384 status=none; sync", 300_000)
	if err := s.Driver.PinBakeSource(t.Context(), src); err != nil {
		t.Fatal(err)
	}
	img, err := s.Driver.Bake(ctx, driver.BakeSpec{CellID: cellID, EnvironmentID: env, OrgID: "org-fc", Source: src})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Backend.Store().Remove("org-fc", img.ImageID) })

	// The next VM boots with the measured need: 1.5 GiB × 1.5, 3 GiB.
	next := boot("disk-next-"+env, false)
	if got := dataGiB(next); got < 2.5 || got > 3.1 {
		t.Fatalf("the next VM's data disk is %.1f GiB, not the measured 3 GiB", got)
	}
	t.Logf("setup peak 1.5 GiB, next VM's data disk %.2f GiB (ceiling %d GiB)", dataGiB(next), diskCeilingGB)
	err = upOnFullDisk(next)
	if !errors.Is(err, driver.ErrDiskCapacity) || !strings.Contains(err.Error(), "filled its 3 GiB data disk") {
		t.Fatalf("a full measured disk: %v", err)
	}
	t.Logf("below the ceiling: %v", err)

	// Filled below the ceiling: the environment's next VM gets the ceiling;
	// filling that one names the ceiling itself.
	last := boot("disk-last-"+env, false)
	if got := dataGiB(last); got < diskCeilingGB-0.5 {
		t.Fatalf("after a full disk the next VM's data disk is %.1f GiB, not the %d GiB ceiling", got, diskCeilingGB)
	}
	err = upOnFullDisk(last)
	if !errors.Is(err, driver.ErrDiskCapacity) || !strings.Contains(err.Error(), "needs more than the cell's 4 GiB data disk ceiling") {
		t.Fatalf("a full disk at the ceiling: %v", err)
	}
	t.Logf("at the ceiling: %v", err)
}
