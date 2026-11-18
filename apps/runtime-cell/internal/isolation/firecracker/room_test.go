package firecracker

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guestinit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/hostnet"
)

// An environment is admitted only when the state disk holds its disks at
// their ceiling next to what the machines already on it may still write: a
// blank data disk counts what it has not written yet, a restored one (a
// clone) and a sandbox's nothing-on-disk are counted as they are. A
// snapshot sees only the room no machine holds (S-09: one claim's VM never
// fills the host's disk under its neighbours).
func TestAnEnvironmentIsAdmittedOnlyWithRoomForItsDisksNextToTheOthers(t *testing.T) {
	b := newBackend(t, &fakeVMM{t: t, state: map[string]string{}, args: map[string][]string{}}, &fakeNet{taps: map[string]hostnet.Attachment{}})
	const gib = int64(1) << 30
	free, used := 100*gib, int64(0)
	b.checks.Free = func(string) (int64, error) { return free, nil }
	b.checks.Allocated = func(string) (int64, error) { return used, nil }
	ceiling := b.diskCeiling(isolation.ShapeEnvironment, 0)
	if ceiling < int64(b.cfg.DataGB)*gib || b.diskCeiling(isolation.ShapeSandbox, 0) != 0 {
		t.Fatalf("ceilings: environment %d, sandbox %d", ceiling, b.diskCeiling(isolation.ShapeSandbox, 0))
	}
	if err := b.diskRoom(isolation.ShapeEnvironment, 0); err != nil {
		t.Fatalf("an empty disk of %d GiB refused a %d GiB environment: %v", free/gib, ceiling/gib, err)
	}
	if err := b.writeRecord(Record{Name: "kodus-a-workload", ID: "kfc-a", Shape: isolation.ShapeEnvironment}); err != nil {
		t.Fatal(err)
	}
	if err := b.writeRecord(Record{Name: "kodus-s-workload", ID: "kfc-s", Shape: isolation.ShapeSandbox}); err != nil {
		t.Fatal(err)
	}
	free = 2*ceiling + diskMargin - 1
	if err := b.diskRoom(isolation.ShapeEnvironment, 0); !errors.Is(err, ErrNoDiskRoom) || !errors.Is(err, driver.ErrDiskCapacity) {
		t.Fatalf("one byte short of two ceilings: %v", err)
	}
	used = 10 * gib // the first machine's blank data disk already holds 10 GiB of its ceiling
	if err := b.diskRoom(isolation.ShapeEnvironment, 0); err != nil {
		t.Fatalf("what the first machine already wrote is not held twice: %v", err)
	}
	if err := b.writeRecord(Record{Name: "kodus-r-workload", ID: "kfc-r", Shape: isolation.ShapeEnvironment, Restored: "ksn-0123456789abcdef0123456789abcdef"}); err != nil {
		t.Fatal(err)
	}
	if held, _ := b.reservedDisk(); held != 2*ceiling-10*gib {
		t.Fatalf("held %d GiB, want a restored machine at its whole ceiling", held/gib)
	}
	if got, _ := b.freeForSnapshots(); got != free-(2*ceiling-10*gib) {
		t.Fatalf("snapshots see %d bytes, want the free space less what the machines hold", got)
	}
}

// A machine destroyed between the listing of the records and the read of
// its own is not listed, and the listing does not fail: a List while many
// claims are released at once used to (S-49).
func TestAMachineDestroyedWhileTheMachinesAreListedIsLeftOut(t *testing.T) {
	b := newBackend(t, &fakeVMM{t: t, state: map[string]string{}, args: map[string][]string{}}, &fakeNet{taps: map[string]hostnet.Attachment{}})
	if err := b.writeRecord(Record{Name: "kodus-a-workload", ID: "kfc-a", Shape: isolation.ShapeSandbox}); err != nil {
		t.Fatal(err)
	}
	// A record listed, then gone: what ReadDir saw and ReadFile no longer finds.
	if err := os.Symlink(filepath.Join(b.cfg.StateDir, "machines", "gone.json"), b.recordPath("kfc-b")); err != nil {
		t.Fatal(err)
	}
	rs, err := b.Machines()
	if err != nil || len(rs) != 1 || rs[0].ID != "kfc-a" {
		t.Fatalf("machines %+v %v", rs, err)
	}
}

// A state directory on a loop device that caches its backing file is
// refused, naming the fix: every VMM's disk writes would be cached twice in
// its own memory cgroup, which OOM-killed one mid-write on the KVM host.
// One with direct I/O, or on a real disk, is not.
func TestAStateDirectoryOnABufferedLoopDeviceIsRefused(t *testing.T) {
	state, err := os.MkdirTemp("/tmp", "fc") // short enough for a jail's socket path
	if err != nil {
		t.Skip("no /tmp:", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(state) })
	checks := func(buffered bool) *Checks {
		return &Checks{
			EUID: func() int { return 0 }, LookPath: func(s string) (string, error) { return "/usr/sbin/" + s, nil },
			Stat: func(string) (os.FileInfo, error) { return charDevice{}, nil }, ReadFile: os.ReadFile, Reflink: copyFile,
			LoopBuffered: func(string) (string, bool) { return "/dev/loop3", buffered },
		}
	}
	reasons := strings.Join(Missing(Config{StateDir: state, Checks: checks(true)}, false), "; ")
	if !strings.Contains(reasons, "/dev/loop3 without direct I/O") || !strings.Contains(reasons, "losetup --direct-io=on /dev/loop3") {
		t.Fatalf("reasons %q", reasons)
	}
	if reasons := strings.Join(Missing(Config{StateDir: state, Checks: checks(false)}, false), "; "); strings.Contains(reasons, "direct I/O") {
		t.Fatalf("a loop device with direct I/O was refused: %q", reasons)
	}
}

// An environment's data disk is the size its spec asks (its environment's
// measured need), bounded by the cell's ceiling; admission holds each
// machine at its own size, not at the ceiling.
func TestAnEnvironmentsDataDiskIsItsOwnSizeUpToTheCellsCeiling(t *testing.T) {
	b := newBackend(t, &fakeVMM{t: t, state: map[string]string{}, args: map[string][]string{}}, &fakeNet{taps: map[string]hostnet.Attachment{}})
	const gib = int64(1) << 30
	ceiling := int64(b.cfg.DataGB) * gib
	if n, err := b.dataBytes(""); err != nil || n != ceiling {
		t.Fatalf("no size asked: %d %v", n, err)
	}
	if n, err := b.dataBytes("3g"); err != nil || n != 3*gib {
		t.Fatalf("3g: %d %v", n, err)
	}
	if _, err := b.dataBytes(fmt.Sprintf("%dg", b.cfg.DataGB+1)); !errors.Is(err, driver.ErrDiskCapacity) || !strings.Contains(err.Error(), "ceiling") {
		t.Fatalf("above the ceiling: %v", err)
	}
	b.checks.Allocated = func(string) (int64, error) { return 0, nil }
	root := b.cfg.Kit.Manifest.Rootfs[guestinit.Environment].Size
	if err := b.writeRecord(Record{Name: "kodus-small-workload", ID: "kfc-s", Shape: isolation.ShapeEnvironment, DataBytes: 3 * gib}); err != nil {
		t.Fatal(err)
	}
	if held, _ := b.reservedDisk(); held != 3*gib+root {
		t.Fatalf("held %d, want its own 3 GiB data disk and its root", held)
	}
	b.checks.Free = func(string) (int64, error) { return 3*gib + root + 3*gib + root + diskMargin, nil }
	if err := b.diskRoom(isolation.ShapeEnvironment, 3*gib); err != nil {
		t.Fatalf("room for a second 3 GiB environment: %v", err)
	}
	if err := b.diskRoom(isolation.ShapeEnvironment, ceiling); !errors.Is(err, ErrNoDiskRoom) {
		t.Fatalf("no room for one at the ceiling: %v", err)
	}
}
