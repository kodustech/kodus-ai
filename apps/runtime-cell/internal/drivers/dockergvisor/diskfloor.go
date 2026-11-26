package dockergvisor

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildstate"
)

// The disk margin (R3-03, F1-01). Every claim of the cell writes to the same
// two filesystems: the work directory (build outputs, BuildKit state views,
// registries, caches) and Docker's data root (writable layers, volumes,
// logs). The agent's watchdog stops every claim once either is under the
// cell's floor (Config.DiskMinFreeBytes). One claim's build writing without
// end (a RUN that fills its BuildKit state view, which no image bound
// measures) used to bring every tenant there. The driver keeps a margin of
// one floor above it: under twice the floor a new workload is refused, as
// microvm refuses one its disk cannot hold, and the running build that
// wrote the most is stopped, one at a time (watchBuildDisk), both with
// driver.ErrDiskCapacity, so the other claims' builds run on. A running
// workload that fills a volume is the watchdog's to stop first
// (ClaimDiskUsage, agent disk_watch.go).

// diskShort says why the cell's disks have no room for more of a claim's
// writes, or nil: either has less than twice the floor free. A disk that
// cannot be read is nil: the watchdog reads it too.
func (d *Driver) diskShort(ctx context.Context) error {
	floor := d.cfg.DiskMinFreeBytes
	if floor <= 0 {
		return nil
	}
	free := buildstate.FreeBytes
	if d.hooks != nil && d.hooks.freeBytes != nil {
		free = d.hooks.freeBytes
	}
	disks := []struct{ what, path string }{{"the cell's work disk", d.workDir()}}
	if root := d.dataRootOf(ctx); root != "" {
		disks = append(disks, struct{ what, path string }{"Docker's disk", root})
	}
	for _, disk := range disks {
		n, err := free(disk.path)
		if err == nil && n < 2*floor {
			return fmt.Errorf("%w: %s has %d MiB free, under the %d MiB margin above the cell's floor", driver.ErrDiskCapacity, disk.what, n>>20, (2*floor)>>20)
		}
	}
	return nil
}

// ClaimDiskUsage is driver.DiskUsageReader's: the bytes each claim of this
// cell holds on Docker's disk, its containers' writable layers and its
// volumes (R3-03). A volume carries the claim's label when the driver made
// it, else its compose project's, whose containers carry the claim's.
func (d *Driver) ClaimDiskUsage(ctx context.Context) (map[string]int64, error) {
	du, err := d.d.DiskUsage(ctx)
	if err != nil {
		return nil, err
	}
	cellLabel, claimLabel := dockercli.LabelFromTag(driver.TagCell), dockercli.LabelFromTag(driver.TagClaim)
	out := map[string]int64{}
	claimOf := map[string]string{} // compose project -> claim
	for _, c := range du.Containers {
		claim := c.Labels[claimLabel]
		if c.Labels[cellLabel] != d.cfg.CellID || claim == "" {
			continue
		}
		out[claim] += c.Bytes
		if p := c.Labels[composeProjectLabel]; p != "" {
			claimOf[p] = claim
		}
	}
	for _, v := range du.Volumes {
		claim := ""
		if v.Labels[cellLabel] == d.cfg.CellID {
			claim = v.Labels[claimLabel]
		}
		if claim == "" {
			claim = claimOf[v.Labels[composeProjectLabel]]
		}
		if claim != "" {
			out[claim] += v.Bytes
		}
	}
	return out, nil
}

// PruneBuildCache is driver.BuildCachePruner's: the host Docker's build cache
// no running build holds, not used for olderThan or longer.
func (d *Driver) PruneBuildCache(ctx context.Context, olderThan time.Duration) (int64, error) {
	return d.d.BuilderPrune(ctx, olderThan)
}

var _ driver.BuildCachePruner = (*Driver)(nil)

// dataRootRetry is how long a daemon that did not say its data root is left
// before it is asked again.
const dataRootRetry = time.Minute

// dataRootCache is Docker's data root as the daemon said it: diskShort runs
// every 2 s of every running build and on every Create, and the root does
// not change while the daemon runs, so one docker info answers them all
// (N2).
type dataRootCache struct {
	mu     sync.Mutex
	root   string
	failed time.Time
}

// dataRootOf is Docker's data root, "" while the daemon does not say it.
func (d *Driver) dataRootOf(ctx context.Context) string {
	c := &d.dataRoot
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.root != "" || !c.failed.IsZero() && d.clock.Now().Sub(c.failed) < dataRootRetry {
		return c.root
	}
	root, err := d.d.DataRoot(ctx)
	if err != nil || root == "" {
		c.failed = d.clock.Now()
		return ""
	}
	c.root = root
	return root
}
