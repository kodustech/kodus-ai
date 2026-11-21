package conformance

import (
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// CgroupMemory is a cgroup v2 directory's memory.max and memory.peak, in MB
// (a limit of "max" reads as the largest int): Target.MachineMemory of a
// backend whose machine is one cgroup.
func CgroupMemory(t *testing.T, dir string) (limitMB, peakMB int) {
	t.Helper()
	read := func(name string) int {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("the machine's cgroup: %v", err)
		}
		s := strings.TrimSpace(string(raw))
		if s == "max" {
			return math.MaxInt
		}
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			t.Fatalf("%s/%s reads %q", dir, name, s)
		}
		return int(n >> 20)
	}
	return read("memory.max"), read("memory.peak")
}

// The memory admission (ADR-070) is only as good as the figure a backend
// counts a machine for: a cell that counts less than the host lets the
// machine hold can commit more memory than the host has. So on every
// backend with a budget, a sandbox's cgroup limit is at most what the cell
// counts it for, and a sandbox that fills its memory holds no more on the
// host than that. The fill must show on the host, or the reading proves
// nothing.
func aSandboxNeverHoldsMoreThanTheCellCountsItFor(t *testing.T, tg Target) {
	if !tg.Boundary {
		t.Skip(tg.Name + " runs commands on the host: it limits nothing")
	}
	if tg.Parts.Memory == nil {
		t.Skip(tg.Name + " has no memory admission (driver.Parts.Memory)")
	}
	if tg.MachineMemory == nil {
		t.Skip(tg.Name + " reads no machine's memory on the host")
	}
	size := driver.ClaimSize{MemoryMB: 512, CPUs: 1}
	counted := tg.Parts.SandboxMemoryMB(size)
	b := newBox(t, tg, "org-conf-a", size, driver.RoleWorkload)
	const fillMB = 320
	// Page by page, so every page is touched, and held until it is read.
	r := b.python(t, `b = bytearray(`+strconv.Itoa(fillMB)+` << 20)
for i in range(0, len(b), 4096): b[i] = 1
print(sum(b[::4096]))`)
	if r.ExitCode != 0 || strings.TrimSpace(r.Stdout) != strconv.Itoa(fillMB<<20/4096) {
		t.Fatalf("filling %d MB: exit %d %q %s", fillMB, r.ExitCode, r.Stdout, r.Stderr)
	}
	limit, peak := tg.MachineMemory(t, b.ref)
	t.Logf("%s: a %d MB sandbox is counted for %d MB; its cgroup may hold %d MB and held at most %d MB", tg.Name, size.MemoryMB, counted, limit, peak)
	if peak < fillMB {
		t.Fatalf("the host saw at most %d MB of a %d MB fill: the reading is not the machine's", peak, fillMB)
	}
	if limit > counted {
		t.Fatalf("the host lets the sandbox hold %d MB and the cell counts it for %d MB", limit, counted)
	}
	if peak > counted {
		t.Fatalf("the sandbox held %d MB on the host and the cell counts it for %d MB", peak, counted)
	}
}
