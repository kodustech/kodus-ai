package firecracker

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guestinit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// ErrNoDiskRoom refuses a machine whose disks the state file system could
// not hold if every machine on it wrote its disks full (S-09). An
// environment's data disk and writable root are sparse: thin, they would
// let one claim's VM fill the host's disk and fail its neighbours' writes.
// It wraps driver.ErrDiskCapacity, the claim's resources blocker.
var ErrNoDiskRoom = fmt.Errorf("firecracker: %w", driver.ErrDiskCapacity)

// diskMargin is kept free beyond every machine's ceiling.
const diskMargin = 1 << 30

// dataBytes is an environment's data disk: the size its spec asks
// (DiskSize, the environment's measured need) or the cell's ceiling
// (-firecracker-data-gb) when it asks none. More than the ceiling is the
// cell's capacity, named.
func (b *Backend) dataBytes(size string) (int64, error) {
	ceiling := int64(b.cfg.DataGB) << 30
	if size == "" {
		return ceiling, nil
	}
	mb, err := sizeMB(size, 0)
	if err != nil {
		return 0, err
	}
	if n := int64(mb) << 20; n <= ceiling {
		return n, nil
	}
	return 0, fmt.Errorf("%w: the environment needs a %s data disk and this cell's ceiling is %d GiB (-firecracker-data-gb)", ErrNoDiskRoom, size, b.cfg.DataGB)
}

// diskCeiling is what a machine of shape may write on the state file
// system: an environment's data disk (data bytes) and its writable root
// (RLIMIT_FSIZE bounds each, VM.FileBytes); a sandbox's root is read-only
// and its workspace is in its memory.
func (b *Backend) diskCeiling(shape isolation.Shape, data int64) int64 {
	if shape != isolation.ShapeEnvironment {
		return 0
	}
	if data <= 0 {
		data = int64(b.cfg.DataGB) << 30
	}
	return data + b.cfg.Kit.Manifest.Rootfs[guestinit.Environment].Size
}

// reservedDisk is what the machines here may still write: each one's
// ceiling (its own data disk's size) less what its own blank data disk
// already holds. A root (a clone of the base) and a restored data disk (a
// clone of a snapshot's) count whole: their shared blocks are copied on
// write.
func (b *Backend) reservedDisk() (int64, error) {
	rs, err := b.Machines()
	if err != nil {
		return 0, err
	}
	var n int64
	for i := range rs {
		r := &rs[i]
		c := b.diskCeiling(r.Shape, r.DataBytes)
		if c == 0 {
			continue
		}
		if r.Restored == "" && b.checks.Allocated != nil {
			if used, err := b.checks.Allocated(filepath.Join(b.rootDir(r.ID), strings.TrimPrefix(jailData, "/"))); err == nil {
				c -= min(used, c-b.cfg.Kit.Manifest.Rootfs[guestinit.Environment].Size)
			}
		}
		n += max(c, 0)
	}
	return n, nil
}

// diskRoom refuses a machine of shape when the state file system, less
// what the machines here may still write, cannot hold its ceiling. Called
// under b.mu before the machine's record exists.
func (b *Backend) diskRoom(shape isolation.Shape, data int64) error {
	need := b.diskCeiling(shape, data)
	if need == 0 || b.checks.Free == nil {
		return nil
	}
	free, err := b.checks.Free(b.cfg.StateDir)
	if err != nil {
		return err
	}
	held, err := b.reservedDisk()
	if err != nil {
		return err
	}
	if free-held < need+diskMargin {
		return fmt.Errorf("%w: the state disk has %d MiB free, %d MiB held for the machines on it, and a new environment needs %d MiB", ErrNoDiskRoom, free>>20, held>>20, need>>20)
	}
	return nil
}

// freeForSnapshots is the state disk's free space less what the machines
// on it may still write: a snapshot never takes the room a running
// machine's disk was admitted with.
func (b *Backend) freeForSnapshots() (int64, error) {
	if b.checks.Free == nil {
		return 1 << 62, nil
	}
	free, err := b.checks.Free(b.cfg.StateDir)
	if err != nil {
		return 0, err
	}
	held, err := b.reservedDisk()
	if err != nil {
		return 0, err
	}
	return free - held, nil
}
