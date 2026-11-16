package microvm

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"path/filepath"
	"slices"
	"strconv"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildmirror"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/firecracker"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/hostnet"
)

// Firecracker is what a cell with -isolation-backend firecracker opens.
type Firecracker struct {
	CellID string
	// KitDir and KitDigest are the microVM kit and the digest of its
	// manifest the cell pins.
	KitDir, KitDigest string
	// StateDir holds the placement's and the backend's state; it must be
	// on a file system that reflinks (XFS, btrfs).
	StateDir string
	// Egress is the egress's address on the host (hostnet.DefaultEgress
	// when invalid); NoEgress leaves claims with no way out.
	Egress   netip.Addr
	NoEgress bool
	Pool     netip.Prefix
	// MemoryMB and CPUs size a claim that asks none; MaxMemoryMB and
	// MaxCPUs bound what one may ask.
	MemoryMB, CPUs, MaxMemoryMB, MaxCPUs int
	// DataGB is an environment's data disk (firecracker.Config.DataGB).
	DataGB int
	// Limits are each machine's disk and network rates per vCPU
	// (firecracker.Limits: zero the default, negative off).
	Limits firecracker.Limits
	// HostPolicy is firecracker.HostShared or HostDedicated (empty:
	// dedicated); a shared cell does not open on an unsafe host.
	HostPolicy string
	Host       isolation.Host
	// ObserverTLSDir holds the observers' TLS files (Config.ObserverTLSDir).
	ObserverTLSDir string
	// Trust are the cell's trust files (Config.Trust).
	Trust machinetrust.Files
	// Log is Config.Log.
	Log *slog.Logger
	// Mirror is the cell's mirror as the VMs name it (Config.Mirror); its
	// port joins what a machine may reach of the egress address.
	Mirror buildmirror.Mirror
	// Checks and Runner replace the host probes and commands (tests).
	Checks *firecracker.Checks
	Runner hostnet.Runner
}

// egressTCPPorts are the egress's ports a machine reaches: the resolver and
// the proxy, and the mirror's when the cell serves one.
func egressTCPPorts(m buildmirror.Mirror) ([]uint16, error) {
	ports := []uint16{53, 80, 443}
	if m.Registry == "" {
		return ports, nil
	}
	_, p, err := net.SplitHostPort(m.Registry)
	if err != nil {
		return nil, fmt.Errorf("microvm: mirror %q: %w", m.Registry, err)
	}
	n, err := strconv.ParseUint(p, 10, 16)
	if err != nil || n == 0 {
		return nil, fmt.Errorf("microvm: mirror port %q", p)
	}
	if !slices.Contains(ports, uint16(n)) {
		ports = append(ports, uint16(n))
	}
	return ports, nil
}

// Stack is an opened microvm cell: the driver and the two ports under it.
type Stack struct {
	Driver  *Driver
	Place   *hostnet.Placement
	Backend *firecracker.Backend
}

// Open loads and verifies the kit, checks every prerequisite of the host
// and refuses with all the missing ones named, before anything touches the
// host's network; then it makes the placement, the backend and the driver.
func Open(ctx context.Context, f Firecracker) (Stack, error) {
	bcfg := firecracker.Config{StateDir: filepath.Join(f.StateDir, "vm"), Host: f.Host, Checks: f.Checks, MemoryMB: f.MemoryMB, CPUs: f.CPUs, DataGB: f.DataGB, Limits: f.Limits, HostPolicy: f.HostPolicy}
	k, err := kit.Load(f.KitDir, f.KitDigest, f.Host.Arch)
	if err != nil {
		bcfg.KitProblem = err.Error()
	} else {
		bcfg.Kit = k
	}
	if missing := firecracker.Missing(bcfg, false); len(missing) > 0 {
		return Stack{}, firecracker.Unavailable(missing)
	}
	tcp, err := egressTCPPorts(f.Mirror)
	if err != nil {
		return Stack{}, err
	}
	place, err := hostnet.New(ctx, hostnet.Config{StateDir: filepath.Join(f.StateDir, "net"), Pool: f.Pool, Egress: f.Egress, TCPPorts: tcp, Runner: f.Runner})
	if err != nil {
		return Stack{}, err
	}
	bcfg.Network = place
	backend, err := firecracker.New(bcfg)
	if err != nil {
		return Stack{}, err
	}
	d, err := New(Config{
		CellID: f.CellID, Backend: backend, Place: place, Egress: !f.NoEgress,
		MemoryMB: f.MemoryMB, CPUs: f.CPUs, MaxMemoryMB: f.MaxMemoryMB, MaxCPUs: f.MaxCPUs, ObserverTLSDir: f.ObserverTLSDir, Trust: f.Trust, Log: f.Log,
		DataCeilingGB: bcfgDataGB(f.DataGB), NeedsFile: filepath.Join(f.StateDir, "environment-disks.json"),
		Mirror: f.Mirror,
	})
	if err != nil {
		return Stack{}, err
	}
	reapAtStart(ctx, d.cfg.Log, backend, place)
	return Stack{Driver: d, Place: place, Backend: backend}, nil
}

// reapAtStart ends, before the cell serves anything, what an earlier run
// left without a record (a VMM, a cgroup, a jail, a tap: the backend's
// orphan pass) and the claim networks no machine record holds, with their
// bridges and rules. A failure is logged: the cell still starts, and the
// out-of-process reaper runs the same pass.
func reapAtStart(ctx context.Context, log *slog.Logger, backend *firecracker.Backend, place *hostnet.Placement) {
	gone, err := backend.ReapOrphans(ctx)
	if len(gone) > 0 || err != nil {
		log.Warn("microvm.orphans", "removed", gone, "err", err)
	}
	rs, err := backend.Machines()
	if err != nil {
		log.Warn("microvm.orphans.networks", "err", err)
		return
	}
	held := map[string]bool{}
	for i := range rs {
		held[rs[i].Network] = true
	}
	nets, err := place.PruneNetworks(ctx, func(n string) bool { return held[n] })
	if len(nets) > 0 || err != nil {
		log.Warn("microvm.orphans.networks", "removed", nets, "err", err)
	}
}

// bcfgDataGB is the backend's data disk ceiling for f's DataGB (its default when unset).
func bcfgDataGB(gb int) int {
	if gb == 0 {
		return 40
	}
	return gb
}
