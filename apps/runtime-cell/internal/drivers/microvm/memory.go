package microvm

import (
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/firecracker"
)

// Memory admission on a microVM cell (ADR-070): every machine is a VMM on
// this host, so the cell counts a claim for what its machines may hold
// here, as docker-gvisor counts its containers. Without it a microVM cell
// was bounded by MaxClaims alone (20), about 10 Runs whatever their size
// (the Firecracker spike, round 3).
//
// An environment claim is two machines: its workload VM, at the claim's
// size, and its observer VM, at ObserverMemoryMB. Each is counted for:
//
//   - while the claim boots (its builds, its bake, its first round): the
//     VMM's memory.max (firecracker.MemoryMaxMB), the guest's memory, the
//     VMM's own and the page cache room that builds and snapshot writes
//     fill (13/11, isolation-p3-snapshots.md);
//   - once it is ready: firecracker.ResidentMB, the guest's memory and the
//     VMM's. A guest never gives back memory it touched (no balloon), so
//     the guest stays counted whole, unlike a ready gVisor claim; only the
//     page cache, which the host writes back and reclaims, is dropped.
//
// A code sandbox is one machine with no observer, counted at its VMM's
// memory.max from boot to release, as the agent counts every sandbox at
// its boot figure.

// guestMB is the guest memory of a claim of size: its own, else the cell's
// default.
func (d *Driver) guestMB(size driver.ClaimSize) int {
	if size.MemoryMB > 0 {
		return size.MemoryMB
	}
	return d.cfg.MemoryMB
}

// ClaimMemory is driver.MemoryBudget's: the claim's workload VM and its
// observer VM.
func (d *Driver) ClaimMemory(size driver.ClaimSize) driver.ClaimMemory {
	guest, obs := d.guestMB(size), d.cfg.ObserverMemoryMB
	return driver.ClaimMemory{
		BootMB:  firecracker.MemoryMaxMB(guest) + firecracker.MemoryMaxMB(obs),
		ReadyMB: firecracker.ResidentMB(guest) + firecracker.ResidentMB(obs),
	}
}

// SandboxMemoryMB is driver.SandboxBudget's: one sandbox VM, at the most
// its VMM may hold.
func (d *Driver) SandboxMemoryMB(size driver.ClaimSize) int {
	return firecracker.MemoryMaxMB(d.guestMB(size))
}

var (
	_ driver.MemoryBudget  = (*Driver)(nil)
	_ driver.SandboxBudget = (*Driver)(nil)
)
