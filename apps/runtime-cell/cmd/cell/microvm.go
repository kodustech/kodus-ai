package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"path/filepath"
	"strconv"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildmirror"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hostcheck"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

// microVM cells (-isolation-backend firecracker, docs/runtime/isolation-architecture.md
// "P2 as built"): the kit the cell verifies by digest, where its machines'
// state lives, and the egress address on the host.
type microvmSettings struct {
	Kit, KitDigest, StateDir, Egress     string
	Mirror                               string
	ObserverTLS                          string
	MemoryMB, CPUs, MaxMemoryMB, MaxCPUs int
	DataGB                               int
	DiskMBps, DiskIOPS, NetMbps          int
	GVisorIOLimits                       bool
	HostPolicy                           string
}

func (s *microvmSettings) register(fs *flag.FlagSet) {
	fs.StringVar(&s.Kit, "firecracker-kit", "", "firecracker: the microVM kit directory (firecracker, jailer, guest kernel, base rootfs images), extracted from its signed OCI artifact")
	fs.StringVar(&s.KitDigest, "firecracker-kit-digest", "", "firecracker: sha256:<hex> of the kit's manifest.json; the cell refuses any other kit")
	fs.StringVar(&s.StateDir, "firecracker-state-dir", "", "firecracker: the machines' state (jails, root clones, network state), on XFS with reflink=1 or btrfs (default <state-dir>/microvm)")
	fs.StringVar(&s.Egress, "firecracker-egress-address", "10.212.255.1", "firecracker: the host address the cell's egress (proxy and resolver) listens on, outside the claim pool; 'off': claims have no way out")
	fs.IntVar(&s.MemoryMB, "firecracker-memory-mb", 2048, "firecracker: a machine's memory when its claim asks none")
	fs.IntVar(&s.CPUs, "firecracker-cpus", 2, "firecracker: a machine's vCPUs when its claim asks none")
	fs.IntVar(&s.MaxMemoryMB, "firecracker-max-memory-mb", 0, "firecracker: the most memory one claim may ask (default: -firecracker-memory-mb)")
	fs.StringVar(&s.ObserverTLS, "firecracker-observer-tls-dir", "/etc/kodus/cell/observer-server", "firecracker: cert.pem and key.pem of the observers (for -observer-server-name) and ca.pem, the CA of -observer-cert; laid into each observer VM")
	fs.IntVar(&s.MaxCPUs, "firecracker-max-cpus", 0, "firecracker: the most vCPUs one claim may ask (default: -firecracker-cpus)")
	fs.IntVar(&s.DiskMBps, "sandbox-disk-mbps-per-cpu", 0, "firecracker and docker-gvisor (with -gvisor-io-limits): a sandbox's disk bandwidth per vCPU, MB/s (0: 100, up to 500 a machine; -1: none). Firecracker: each drive's token bucket, and io.max at twice it on the VMM's cgroup; docker-gvisor: Docker's blkio limits on the data root's disk")
	fs.IntVar(&s.DiskIOPS, "sandbox-disk-iops-per-cpu", 0, "firecracker and docker-gvisor (with -gvisor-io-limits): a sandbox's disk operations per second per vCPU (0: 2500, up to 12000 a machine; -1: none)")
	fs.IntVar(&s.NetMbps, "sandbox-net-mbps-per-cpu", 0, "firecracker and docker-gvisor (with -gvisor-io-limits): a sandbox's network bandwidth each way per vCPU, Mbit/s (0: 250, up to 2000 a machine; -1: none). Firecracker: the NIC's token buckets; docker-gvisor: tc on its host-side veth")
	fs.BoolVar(&s.GVisorIOLimits, "gvisor-io-limits", false, "docker-gvisor: bound each workload container's disk and network by the -sandbox-*-per-cpu rates (off until proven on the production hosts: a container whose veth cannot be shaped is refused)")
	fs.StringVar(&s.Mirror, "firecracker-mirror", "", "firecracker: the cell's mirror as the VMs name it (http://mirror.cell.internal:8080, the egress's -mirror-listen port on -firecracker-egress-address): every build gets its npm, PyPI and Go build args, the VM's own builder pulls docker.io through it, and the VMs may reach its port. Empty: no mirror")
	fs.IntVar(&s.DataGB, "firecracker-data-gb", 40, "firecracker: an environment's data disk (Docker's images, volumes and build cache), GiB; the state disk admits an environment only with room for its disks at this size next to the others'")
}

// openMicroVM is the microvm driver for st: the kit verified, the host's
// prerequisites checked (all the missing ones named), then the placement
// and the backend.
func openMicroVM(ctx context.Context, st settings, cellID string, trust machinetrust.Files, log *slog.Logger) (*microvm.Driver, error) {
	m := st.MicroVM
	var err error
	f := microvm.Firecracker{
		CellID: cellID, KitDir: m.Kit, KitDigest: m.KitDigest, StateDir: m.StateDir, Host: isolation.ProbeHost(),
		MemoryMB: m.MemoryMB, CPUs: m.CPUs, MaxMemoryMB: m.MaxMemoryMB, MaxCPUs: m.MaxCPUs, ObserverTLSDir: m.ObserverTLS, Trust: trust, Log: log, DataGB: m.DataGB,
		Limits:     m.ioLimits(),
		HostPolicy: m.HostPolicy,
	}
	if f.StateDir == "" {
		f.StateDir = filepath.Join(st.StateDir, "microvm")
	}
	if m.Egress == "off" {
		f.NoEgress = true
	} else {
		a, perr := netip.ParseAddr(m.Egress)
		if perr != nil {
			return nil, fmt.Errorf("firecracker-egress-address: %w", perr)
		}
		f.Egress = a
	}
	if f.Mirror, err = buildmirror.At(m.Mirror); err != nil {
		return nil, fmt.Errorf("firecracker-mirror: %w", err)
	}
	s, err := microvm.Open(ctx, f)
	return s.Driver, err
}

// hostReport is heartbeat host of what the cell found of its host.
func hostReport(h hostcheck.State) *protocol.HeartbeatBodyHost {
	sw := func(s string) protocol.HeartbeatBodyHostSmt { return protocol.HeartbeatBodyHostSmt(s) }
	r := &protocol.HeartbeatBodyHost{Policy: protocol.HeartbeatBodyHostPolicy(h.Policy), Smt: sw(h.SMT), Ksm: sw(h.KSM), Swap: sw(h.Swap), Vulnerable: append([]string{}, h.Vulnerable...)}
	if h.Microcode != "" {
		mc := h.Microcode
		if len(mc) > 32 {
			mc = mc[:32]
		}
		r.Microcode = &mc
	}
	return r
}

// microvmObservers is each claim's observer VM, reached over its vsock
// (microvm.Driver.DialObserver) with the cell's observer client
// certificate: the host opens no TCP connection into a VM. The targets are
// the workload VM's address on each exposed port.
func microvmObservers(obsTLS *tls.Config, d *microvm.Driver) agent.ObserverFactory {
	return func(ctx context.Context, c agent.ClaimInfo, targets []observer.Target) (observer.Client, error) {
		targets, err := d.Targets(ctx, c.Workload.MachineID, targets)
		if err != nil {
			return nil, err
		}
		// The address only names the endpoint (the client checks it is an
		// address); every connection goes over the observer VM's vsock.
		machine := c.Observer.MachineID
		hc := &http.Client{Timeout: 11 * time.Minute, Transport: &http.Transport{
			// One vsock connection per request: an idle connection the observer
			// closed is only seen on the next write, and a POST is not retried.
			DisableKeepAlives: true,
			TLSClientConfig:   obsTLS,
			DialContext:       func(ctx context.Context, _, _ string) (net.Conn, error) { return d.DialObserver(ctx, machine) },
		}}
		return observerclient.Configure(ctx, hc, "https://"+net.JoinHostPort(c.Observer.PrivateAddress, strconv.Itoa(microvm.ObserverVsockPort)), observerConfig(c, targets))
	}
}

// hostPolicyFor is -host-policy for the driver: auto is shared on a microVM
// cell and dedicated on docker-gvisor, whose hosts run SMT today (EC2's
// default); a shared gVisor fleet sets shared once its hosts run one thread
// per core.
func hostPolicyFor(flag, driverKind string) (string, error) {
	switch flag {
	case hostcheck.Shared, hostcheck.Dedicated:
		return flag, nil
	case "", "auto":
		if driverKind == microvm.Kind {
			return hostcheck.Shared, nil
		}
		return hostcheck.Dedicated, nil
	}
	return "", fmt.Errorf("-host-policy %q: shared, dedicated or auto", flag)
}

// ioLimits is the shared per-sandbox policy the flags set.
func (s *microvmSettings) ioLimits() driver.IOLimits {
	return driver.IOLimits{DiskMBps: s.DiskMBps, DiskIOPS: s.DiskIOPS, NetMbps: s.NetMbps}
}

// gvisorIOLimits is the policy for docker-gvisor, nil until -gvisor-io-limits.
func (s *microvmSettings) gvisorIOLimits() *driver.IOLimits {
	if !s.GVisorIOLimits {
		return nil
	}
	l := s.ioLimits()
	return &l
}
