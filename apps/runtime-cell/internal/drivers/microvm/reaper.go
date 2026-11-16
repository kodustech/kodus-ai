package microvm

import (
	"context"
	"path/filepath"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/firecracker"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/hostnet"
)

// Reaper is a microvm cell as the out-of-process reaper sees it (cmd/reaper
// -driver microvm, ADR-056, S-08): the backend's records on the cell's state
// directory, Destroy, and the orphan pass. It runs whether the cell is alive
// or not, as root on the host, and never opens the kit, the egress or the
// placement: a tap goes by its name, and the claim networks and their nft
// rules stay the cell's, pruned when it starts again.
type Reaper struct {
	cellID  string
	backend *firecracker.Backend
}

// NewForReaper opens the cell's state directory (its -firecracker-state-dir).
func NewForReaper(cellID, stateDir string) (*Reaper, error) {
	b, err := firecracker.ForReaper(firecracker.Config{StateDir: filepath.Join(stateDir, "vm"), Network: hostnet.TapRemover{}})
	if err != nil {
		return nil, err
	}
	return &Reaper{cellID: cellID, backend: b}, nil
}

// List is the cell's machines whose tags match selector, with the tags they
// were born with (kodus:hard-expires among them).
func (r *Reaper) List(ctx context.Context, selector map[string]string) ([]driver.MachineRef, error) {
	all, err := r.backend.Inventory(ctx)
	if err != nil {
		return nil, err
	}
	var out []driver.MachineRef
	for _, m := range all {
		if m.Labels[driver.TagCell] != r.cellID || !driver.Matches(m.Labels, selector) {
			continue
		}
		out = append(out, driver.MachineRef{MachineID: m.Name, DriverRef: m.ID, Tags: m.Labels})
	}
	return out, nil
}

// Destroy ends the machine: its VMM, cgroup, tap, jail and record.
func (r *Reaper) Destroy(ctx context.Context, ref driver.MachineRef) error {
	return r.backend.Destroy(ctx, ref.MachineID, isolation.DestroyOptions{})
}

// ReapOrphans ends what no record names (firecracker.Backend.ReapOrphans).
func (r *Reaper) ReapOrphans(ctx context.Context) ([]string, error) {
	return r.backend.ReapOrphans(ctx)
}
