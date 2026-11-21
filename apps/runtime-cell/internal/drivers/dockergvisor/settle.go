package dockergvisor

import (
	"context"
	"errors"
	"fmt"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// Under claim limits a claim is counted at its whole ceiling while it builds
// (ClaimMemory: one build at a time may take all of it). Once ready its
// builds are over: SettleReady lowers the ceiling its subtree runs under to
// what it holds plus room, and admission counts that from then on. The
// enforced ceiling comes down first and is never raised again, so what the
// claim may use is never more than what the cell counts for it. Counting a
// ready claim at its build size held a second claim of a two-sided Run out
// of a 16 GiB cell for the whole of the first's life.

const (
	// settleMinGrowthMB is the least room a ready claim keeps above what it
	// holds; it otherwise keeps half again as much.
	settleMinGrowthMB = 512
	// settleLaunchRoomMB is room for what starts in the claim's budget after
	// ready: a browser probe (BrowserRunner, 1g by default).
	settleLaunchRoomMB = 1024
)

// settledMB is the ceiling a ready claim holding workingSet bytes runs
// under: what it holds, half again (at least settleMinGrowthMB) and a
// launch's room, no less than floorMB (Config.MemReady) and no more than
// sizeMB, its build ceiling.
func settledMB(workingSet int64, floorMB, sizeMB int) int {
	need := int((workingSet + 1<<20 - 1) >> 20)
	mb := need + max(need/2, settleMinGrowthMB) + settleLaunchRoomMB
	return min(max(mb, floorMB), sizeMB)
}

func (d *Driver) resizer() (claimlimits.Resizer, bool) {
	if d.cfg.ClaimLimits == nil || d.cfg.ClaimBudgets == nil {
		return nil, false
	}
	return d.cfg.ClaimBudgets, true
}

// SettleReady is driver.ReadySettler's: the MB the ready claim of ref is to
// be counted for, its budget's ceiling already lowered to it. 0 when the
// cell has no budget it can lower (count ClaimMemory's ReadyMB). An error
// leaves the ceiling where it was, or lower; the caller keeps counting the
// claim at its size.
func (d *Driver) SettleReady(ctx context.Context, ref driver.MachineRef) (int, error) {
	r, ok := d.resizer()
	if !ok || ref.MachineID == "" {
		return 0, nil
	}
	g, err := d.groupFromHolder(ctx, ref)
	if err != nil {
		return 0, err
	}
	u, err := r.Usage(g.key)
	if err != nil {
		return 0, errors.Join(ErrResourceEnforcement, err)
	}
	size := int(g.limits.MemoryBytes >> 20)
	mb := settledMB(u.WorkingSetBytes(), d.readyMB, size)
	if mb >= size {
		return size, nil
	}
	if err = r.Lower(g.key, int64(mb)<<20); err != nil {
		return 0, errors.Join(ErrResourceEnforcement, err)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if cur, ok := d.limitGroups[g.network]; ok && cur.key == g.key {
		cur.limits.MemoryBytes = int64(mb) << 20
		d.limitGroups[g.network] = cur
	}
	for _, p := range d.pinned {
		if p.group.key == g.key {
			p.group.limits.MemoryBytes = int64(mb) << 20
		}
	}
	return mb, nil
}

// lowered is g with the ceiling SettleReady left on its budget in this
// process: a holder's labels and a fresh groupFor keep the build ceiling the
// claim started with, and Ensure only takes the ceiling the budget has.
// After a restart the cell starts from an empty tree (RequireEmpty).
func (d *Driver) lowered(g limitGroup) limitGroup {
	d.mu.Lock()
	defer d.mu.Unlock()
	if cur, ok := d.limitGroups[g.network]; ok && cur.key == g.key && cur.limits.MemoryBytes > 0 && cur.limits.MemoryBytes < g.limits.MemoryBytes {
		g.limits.MemoryBytes = cur.limits.MemoryBytes
	}
	return g
}

// MachineHealth is driver.HealthReader's, on a cell whose claim budgets can
// be read: running while the machine's holder runs, and the oom_kill count
// of the claim's whole budget (memory.events is hierarchical), so a step
// during which the kernel killed in the claim reads vmHealth oom, a lost
// machine to the gate, not a regression.
func (d *Driver) MachineHealth(ctx context.Context, ref driver.MachineRef) (driver.MachineHealth, error) {
	r, ok := d.resizer()
	if !ok {
		return driver.MachineHealth{}, fmt.Errorf("dockergvisor: machine health needs a readable claim budget")
	}
	cs, err := d.d.Inspect(ctx, ref.MachineID)
	if err != nil {
		return driver.MachineHealth{}, err
	}
	running := false
	for i := range cs {
		if cs[i].Name == ref.MachineID {
			running = cs[i].PID > 0
		}
	}
	if !running {
		return driver.MachineHealth{}, nil
	}
	g, err := d.groupFromHolder(ctx, ref)
	if err != nil {
		return driver.MachineHealth{}, err
	}
	u, err := r.Usage(g.key)
	if err != nil {
		return driver.MachineHealth{}, errors.Join(ErrResourceEnforcement, err)
	}
	return driver.MachineHealth{Running: true, OOMKills: u.OOMKills}, nil
}

var (
	_ driver.ReadySettler = (*Driver)(nil)
	_ driver.HealthReader = (*Driver)(nil)
)
