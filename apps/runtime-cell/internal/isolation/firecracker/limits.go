package firecracker

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// A VM's share of the host's disk and network (docs/runtime/isolation-p3-snapshots.md,
// "Per-VM limits"): Firecracker's own token buckets on each drive and on the
// NIC, both ways, sized from the machine's vCPUs, and the VMM cgroup's
// io.max on the state device as the hard bound on all of the VMM's I/O
// (its drives, its snapshot files and the page cache it writes back). One
// VM filling its disk had starved the others' guest agents for seconds and
// stalled a Destroy for minutes.

// Limits are the per-vCPU rates (Config), the shared policy
// (driver.IOLimits): zero takes the default, a negative value turns that
// limit off.
type Limits = driver.IOLimits

// burstSeconds is the one-time burst over the steady rate: a boot's image
// pull or a build's first writes run at full speed for that long.
const burstSeconds = 5

// rates are one machine's limits, in bytes and operations per second; zero
// is no limit.
type rates struct {
	diskBps, diskOps, netBps int64
}

// ratesOf is the shared policy's rates of a machine of vcpus.
func ratesOf(l Limits, vcpus int) rates {
	r := l.For(vcpus)
	return rates{diskBps: r.DiskBps, diskOps: r.DiskOps, netBps: r.NetBps}
}

// bucket is a Firecracker token bucket refilled every second.
func bucket(perSecond int64) map[string]any {
	return map[string]any{"size": perSecond, "one_time_burst": perSecond * burstSeconds, "refill_time": 1000}
}

// driveLimiter is a drive's rate_limiter; nil: none.
func (r rates) driveLimiter() map[string]any {
	l := map[string]any{}
	if r.diskBps > 0 {
		l["bandwidth"] = bucket(r.diskBps)
	}
	if r.diskOps > 0 {
		l["ops"] = bucket(r.diskOps)
	}
	if len(l) == 0 {
		return nil
	}
	return l
}

// netLimiter is the NIC's rx and tx rate_limiter; nil: none.
func (r rates) netLimiter() map[string]any {
	if r.netBps <= 0 {
		return nil
	}
	return map[string]any{"bandwidth": bucket(r.netBps)}
}

// boundIO writes the VMM cgroup's io.max once the jailer made the cgroup
// (the jailer's --cgroup takes no value with a space, and io.max's has
// two). On a boot the guest's first I/O may come before it, inside the
// drives' buckets; a restore writes it before the snapshot loads.
func (b *Backend) boundIO(id string, r rates) error {
	line := r.ioMax(b.ioDev)
	if line == "" {
		return nil
	}
	if err := os.WriteFile(filepath.Join(b.cgroupDir(id), "io.max"), []byte(line), 0o644); err != nil { //nolint:gosec // G306: a cgroup control file
		return fmt.Errorf("firecracker: io.max of %s: %w", id, err)
	}
	return nil
}

// ioMax is the VMM cgroup's io.max line on the state device dev
// ("major:minor"): twice the drives' bandwidth each way, so the bucket, not
// the cgroup, shapes the guest's I/O and the cgroup bounds what the VMM does
// besides (snapshot files, writeback). Empty: no device or no limit.
func (r rates) ioMax(dev string) string {
	if dev == "" || r.diskBps <= 0 {
		return ""
	}
	b := strconv.FormatInt(2*r.diskBps, 10)
	return fmt.Sprintf("%s rbps=%s wbps=%s", dev, b, b)
}
