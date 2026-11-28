package driver

// A sandbox's share of the host's disk and network, one policy for every
// driver (docs/runtime/isolation-architecture.md, "Per-sandbox limits"):
// rates per vCPU of the machine's shape, operator-configurable, each driver
// enforcing them its own way (microVM: Firecracker's token buckets on each
// drive and the NIC, and io.max on the VMM's cgroup).

// IOLimits are the per-vCPU rates: zero takes the default, a negative
// value turns that limit off.
type IOLimits struct {
	// DiskMBps and DiskIOPS are each disk's bandwidth (MB/s) and
	// operations per second, per vCPU.
	DiskMBps, DiskIOPS int
	// NetMbps is the network bandwidth each way (Mbit/s), per vCPU.
	NetMbps int
}

// The defaults per vCPU, and the most one machine gets whatever its vCPUs.
const (
	DefaultDiskMBps = 100
	DefaultDiskIOPS = 2500
	DefaultNetMbps  = 250
	MaxDiskMBps     = 500
	MaxDiskIOPS     = 12000
	MaxNetMbps      = 2000
)

// IORates are one machine's limits in bytes and operations per second;
// zero is no limit.
type IORates struct {
	DiskBps, DiskOps, NetBps int64
}

func perCPU(v, def, ceiling, cpus int) int64 {
	if v < 0 {
		return 0
	}
	if v == 0 {
		v = def
	}
	return int64(min(v*cpus, ceiling))
}

// For is the rates of a machine of vcpus.
func (l IOLimits) For(vcpus int) IORates {
	vcpus = max(1, vcpus)
	return IORates{
		DiskBps: perCPU(l.DiskMBps, DefaultDiskMBps, MaxDiskMBps, vcpus) * 1_000_000,
		DiskOps: perCPU(l.DiskIOPS, DefaultDiskIOPS, MaxDiskIOPS, vcpus),
		NetBps:  perCPU(l.NetMbps, DefaultNetMbps, MaxNetMbps, vcpus) * 1_000_000 / 8,
	}
}
