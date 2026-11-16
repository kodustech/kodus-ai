package claimlimits

import (
	"strconv"
	"strings"
	"testing"
)

func TestLowerOnlyLowersTheMemoryCeilingAndReadsItBack(t *testing.T) {
	f, r := testManager(t)
	if _, err := f.Ensure(testKey, testLimits); err != nil {
		t.Fatal(err)
	}
	n := r.dirs[testKey]
	before := map[string]string{"cpu.max": n.files["cpu.max"], "pids.max": n.files["pids.max"], "memory.swap.max": n.files["memory.swap.max"]}
	lowered := testLimits
	lowered.MemoryBytes = 64 << 20
	if err := f.Lower(testKey, lowered.MemoryBytes); err != nil {
		t.Fatal(err)
	}
	if n.files["memory.max"] != strconv.FormatInt(lowered.MemoryBytes, 10) {
		t.Fatalf("memory.max=%q", n.files["memory.max"])
	}
	for k, v := range before {
		if n.files[k] != v {
			t.Fatalf("%s changed: %q", k, n.files[k])
		}
	}
	// The ceiling a launch must name from now on is the lowered one.
	if _, err := f.Ensure(testKey, testLimits); err == nil {
		t.Fatal("Ensure accepted the ceiling the budget no longer has")
	}
	if _, err := f.Ensure(testKey, lowered); err != nil {
		t.Fatal(err)
	}
}

func TestLowerNeverRaisesTheCeiling(t *testing.T) {
	f, r := testManager(t)
	if _, err := f.Ensure(testKey, testLimits); err != nil {
		t.Fatal(err)
	}
	n := r.dirs[testKey]
	writes := len(n.writes)
	if err := f.Lower(testKey, testLimits.MemoryBytes*2); err == nil {
		t.Fatal("Lower raised the ceiling")
	}
	if err := f.Lower(testKey, 0); err == nil {
		t.Fatal("Lower accepted no ceiling")
	}
	if err := f.Lower(testKey, testLimits.MemoryBytes); err != nil {
		t.Fatalf("lowering to the same ceiling: %v", err)
	}
	if len(n.writes) != writes {
		t.Fatalf("writes=%v", n.writes[writes:])
	}
}

func TestLowerRefusesWhenTheKernelKeepsAnotherCeiling(t *testing.T) {
	f, r := testManager(t)
	if _, err := f.Ensure(testKey, testLimits); err != nil {
		t.Fatal(err)
	}
	r.dirs[testKey].readback = "memory.max"
	if err := f.Lower(testKey, 64<<20); err == nil {
		t.Fatal("a ceiling the kernel did not take was reported lowered")
	}
}

func TestUsageIsTheWorkingSetWithoutReclaimableFileCache(t *testing.T) {
	f, r := testManager(t)
	if _, err := f.Ensure(testKey, testLimits); err != nil {
		t.Fatal(err)
	}
	n := r.dirs[testKey]
	n.files["memory.current"] = "1000\n"
	n.files["memory.stat"] = "anon 300\nfile 600\nkernel 100\nshmem 200\nfile_mapped 10\n"
	n.files["memory.events"] = "low 0\nhigh 0\nmax 4\noom 1\noom_kill 2\noom_group_kill 0\n"
	u, err := f.Usage(testKey)
	if err != nil {
		t.Fatal(err)
	}
	// shmem is file memory the kernel cannot reclaim without swap (the
	// gVisor Sentry's memory file is shmem): it stays in the working set.
	if u.WorkingSetBytes() != 600 || u.OOMKills != 2 || u.CurrentBytes != 1000 {
		t.Fatalf("usage=%+v working=%d", u, u.WorkingSetBytes())
	}
	n.files["memory.stat"] = "anon 1\n"
	if _, err = f.Usage(testKey); err == nil || !strings.Contains(err.Error(), "file") {
		t.Fatalf("a memory.stat without file read as usage: %v", err)
	}
}

func TestSystemdLowerGoesOverTheBusAndKeepsTheUnitVerifiable(t *testing.T) {
	m, b, r := fakeSystemd(t)
	name, err := m.Ensure(testKey, testLimits)
	if err != nil {
		t.Fatal(err)
	}
	lowered := testLimits
	lowered.MemoryBytes = 64 << 20
	if err = m.Lower(testKey, lowered.MemoryBytes); err != nil {
		t.Fatal(err)
	}
	if len(b.memorySets) != 1 || b.memorySets[0] != name {
		t.Fatalf("sets=%v", b.memorySets)
	}
	if len(r.writes) != 0 || len(r.dirs[name].writes) != 0 {
		t.Fatal("controller wrote systemd cgroupfs")
	}
	if err = m.Verify(testKey, 12); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Ensure(testKey, lowered); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Ensure(testKey, testLimits); err == nil {
		t.Fatal("Ensure accepted the ceiling the slice no longer has")
	}
	if err = m.Lower(testKey, testLimits.MemoryBytes); err == nil {
		t.Fatal("Lower raised the slice's ceiling")
	}
	r.dirs[name].files["memory.current"] = "500"
	r.dirs[name].files["memory.stat"] = "file 100\nshmem 0\n"
	r.dirs[name].files["memory.events"] = "oom_kill 1\n"
	u, err := m.Usage(testKey)
	if err != nil || u.WorkingSetBytes() != 400 || u.OOMKills != 1 {
		t.Fatalf("usage=%+v err=%v", u, err)
	}
}

func TestSystemdLowerRefusesWhenTheKernelKeepsAnotherCeiling(t *testing.T) {
	m, b, _ := fakeSystemd(t)
	if _, err := m.Ensure(testKey, testLimits); err != nil {
		t.Fatal(err)
	}
	b.skipKernel = true
	if err := m.Lower(testKey, 64<<20); err == nil {
		t.Fatal("a ceiling the kernel did not take was reported lowered")
	}
}
