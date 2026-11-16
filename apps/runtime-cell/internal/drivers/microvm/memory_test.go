//go:build unix

package microvm

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/firecracker"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
)

// memoryMaxMB is the memory.max, in MB, the jailer gives the VMM of a
// machine the backend was asked for: what the host lets that machine hold.
func memoryMaxMB(t *testing.T, memory string) int {
	t.Helper()
	mb, err := strconv.Atoi(strings.TrimSuffix(memory, "m"))
	if err != nil {
		t.Fatalf("machine memory %q", memory)
	}
	for _, a := range (firecracker.Jail{MemoryMB: mb, CPUs: 1}).Args() {
		if v, ok := strings.CutPrefix(a, "memory.max="); ok {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			return int(n >> 20)
		}
	}
	t.Fatal("the jailer sets no memory.max")
	return 0
}

// A microVM cell admits by memory (ADR-070), as a docker-gvisor cell does:
// without a budget it was bounded by MaxClaims alone, 10 Runs whatever
// their size (spike-firecracker-2026-11.md round 3). A claim is counted,
// while it boots, for the memory.max of both its VMMs (its workload VM and
// its observer VM: the guest, the VMM, the page cache room), so the host
// can never be asked for more than those limits allow; once ready, for
// what they hold that the host cannot reclaim (every guest's memory and
// every VMM's own). A sandbox is one VM, counted at its VMM's memory.max.
// The budget is found through the Observed wrapper cmd/cell puts on it.
func TestAMicroVMClaimIsCountedForWhatItsVMMsMayHold(t *testing.T) {
	d, ref, _, bin := envDriver(t)
	b := d.cfg.Backend.(*memBackend)
	tls := t.TempDir()
	for _, f := range []string{"cert.pem", "key.pem", "ca.pem"} {
		_ = os.WriteFile(filepath.Join(tls, f), []byte("pem "+f), 0o600)
	}
	d.cfg.ObserverTLSDir = tls
	_ = os.WriteFile(filepath.Join(bin, "nohup"), []byte("#!/bin/sh\n"), 0o755)
	ctx := context.Background()
	obs := spec("run-1")
	obs.Role = driver.RoleObserver
	oref, err := d.Create(ctx, obs)
	if err != nil {
		t.Fatal(err)
	}

	_, parts := driver.Observed(d, d.Parts(), metrics.NewRegistry(), slog.New(slog.DiscardHandler))
	budget := parts.Memory
	if budget == nil || parts.SandboxMemory == nil {
		t.Fatal("a microVM cell has no memory budget: it admits by free slots alone")
	}
	work, observer := memoryMaxMB(t, b.specs[ref.MachineID].Memory), memoryMaxMB(t, b.specs[oref.MachineID].Memory)
	got := budget.ClaimMemory(driver.ClaimSize{})
	if got.BootMB != work+observer {
		t.Fatalf("a booting claim is counted for %d MB; its VMMs may hold %d + %d MB", got.BootMB, work, observer)
	}
	// Ready: the guests whole (a VM never gives back memory it touched),
	// and each VMM's own, without the page cache room.
	if want := 2048 + 512 + 2*128; got.ReadyMB != want {
		t.Fatalf("a ready claim is counted for %d MB, want %d", got.ReadyMB, want)
	}
	if got.ReadyMB >= got.BootMB {
		t.Fatalf("ready %d MB is not below boot %d MB", got.ReadyMB, got.BootMB)
	}
	// A claim that asks a size is counted at it; the observer stays the cell's.
	if big := budget.ClaimMemory(driver.ClaimSize{MemoryMB: 4096, CPUs: 2}); big.BootMB != memoryMaxMB(t, "4096m")+observer || big.ReadyMB != 4096+128+512+128 {
		t.Fatalf("a 4 GiB claim is counted for %+v", big)
	}

	s := spec("run-1")
	s.ClaimID, s.ClaimGroupID = "box-1", networkName("box-1")
	if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: "box-1"}); err != nil {
		t.Fatal(err)
	}
	s.ClaimSize = driver.ClaimSize{MemoryMB: 1024, CPUs: 1}
	box, err := d.CreateSandbox(ctx, driver.SandboxRequest{Spec: s})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := parts.SandboxMemoryMB(s.ClaimSize), memoryMaxMB(t, b.specs[box.MachineID].Memory); got != want {
		t.Fatalf("a 1 GiB sandbox is counted for %d MB; its VMM may hold %d", got, want)
	}
	if got, want := parts.SandboxMemoryMB(driver.ClaimSize{}), memoryMaxMB(t, "2048m"); got != want {
		t.Fatalf("a sandbox of the default size is counted for %d MB, want %d", got, want)
	}
}
