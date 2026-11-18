package microvm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

// An environment's data disk is sized from its own setup
// (docs/runtime/isolation-p3-snapshots.md, "Disk per environment"): the
// bake measures the setup's data disk at its high-water mark (the host
// blocks it took: a guest's frees are never given back), and the
// environment's need is that times needFactor, in whole GiB, at least
// minNeedGiB and at most the cell's ceiling. Its next machines boot with
// that disk; one with no need yet (its first setup) boots at the ceiling.
// A machine whose disk fills is the resources/disk_capacity blocker, and
// an environment that filled a disk below the ceiling gets the ceiling next.

const (
	needFactor = 1.5
	minNeedGiB = 2
)

func needKey(org, env string) string { return org + "\x00" + env }

func (d *Driver) loadNeeds() error {
	d.needs = map[string]int64{}
	if d.cfg.NeedsFile == "" {
		return nil
	}
	raw, err := os.ReadFile(d.cfg.NeedsFile)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var byKey map[string]int64
	if err := json.Unmarshal(raw, &byKey); err != nil {
		return fmt.Errorf("microvm: %s: %w", d.cfg.NeedsFile, err)
	}
	for k, v := range byKey {
		d.needs[k] = v
	}
	return nil
}

// setNeed records an environment's need; the caller holds no lock.
func (d *Driver) setNeed(org, env string, bytes int64) error {
	d.mu.Lock()
	d.needs[needKey(org, env)] = bytes
	snapshot := make(map[string]int64, len(d.needs))
	for k, v := range d.needs {
		snapshot[k] = v
	}
	d.mu.Unlock()
	if d.cfg.NeedsFile == "" {
		return nil
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(d.cfg.NeedsFile), 0o700); err != nil {
		return err
	}
	tmp := d.cfg.NeedsFile + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, d.cfg.NeedsFile)
}

func (d *Driver) ceilingBytes() int64 { return int64(d.cfg.DataCeilingGB) << 30 }

// diskSizeOf is the data disk an environment's next machine boots with
// ("" : the backend's ceiling).
func (d *Driver) diskSizeOf(org, env string) string {
	d.mu.Lock()
	n := d.needs[needKey(org, env)]
	d.mu.Unlock()
	if n <= 0 || n >= d.ceilingBytes() {
		return ""
	}
	return strconv.FormatInt(n>>30, 10) + "g"
}

// needOf is a measured peak's need: ×needFactor in whole GiB, between
// minNeedGiB and the ceiling.
func (d *Driver) needOf(peak int64) int64 {
	gib := int64(float64(peak)*needFactor+float64(1<<30)-1) >> 30
	return min(max(gib, minNeedGiB), int64(d.cfg.DataCeilingGB)) << 30
}

// measureNeed keeps the setup machine's data disk peak as its
// environment's need (Bake, before the machine is kept as the template).
func (d *Driver) measureNeed(ref driver.MachineRef, org, env string) {
	peak, err := d.cfg.Backend.DataAllocated(ref.MachineID)
	if err != nil {
		d.cfg.Log.Warn("microvm.disk_need.unmeasured", "machine", ref.MachineID, "err", err)
		return
	}
	need := d.needOf(peak)
	if err := d.setNeed(org, env, need); err != nil {
		d.cfg.Log.Warn("microvm.disk_need.unsaved", "environment", env, "err", err)
		return
	}
	d.cfg.Log.Info("microvm.disk_need", "environment", env, "peakMiB", peak>>20, "needGiB", need>>30, "ceilingGiB", d.cfg.DataCeilingGB)
}

// diskFull turns a failed boot or recipe step into the cell's capacity
// when the machine's data disk is (nearly) full: the blocker names the
// disk and the ceiling, and an environment that filled a disk below the
// ceiling gets the ceiling for its next machines. Any other failure stays.
func (d *Driver) diskFull(ctx context.Context, ref driver.MachineRef, cause error) error {
	r, err := d.Exec(ctx, ref, kodyexec.Request{Command: "df -B1 --output=size,avail /var/lib/kody-data | tail -1", TimeoutMs: 10_000})
	if err != nil || r.ExitCode != 0 {
		return cause
	}
	f := strings.Fields(r.Stdout)
	if len(f) != 2 {
		return cause
	}
	size, err1 := strconv.ParseInt(f[0], 10, 64)
	avail, err2 := strconv.ParseInt(f[1], 10, 64)
	if err1 != nil || err2 != nil || size <= 0 || avail > max(size/50, 256<<20) {
		return cause
	}
	org, env := ref.Tags[driver.TagOrg], ref.Tags[driver.TagEnv]
	gib := (size + 1<<29) >> 30
	if size < d.ceilingBytes()-(1<<30) {
		_ = d.setNeed(org, env, d.ceilingBytes())
		return fmt.Errorf("%w: the environment filled its %d GiB data disk; its next machines get the cell's ceiling, %d GiB: %w", driver.ErrDiskCapacity, gib, d.cfg.DataCeilingGB, cause)
	}
	return fmt.Errorf("%w: the environment needs more than the cell's %d GiB data disk ceiling (-firecracker-data-gb): %w", driver.ErrDiskCapacity, d.cfg.DataCeilingGB, cause)
}
