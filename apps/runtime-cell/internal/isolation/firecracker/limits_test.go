package firecracker

import (
	"context"
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guestinit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/vsock"
)

func configOf(t *testing.T, v VM) map[string]any {
	t.Helper()
	v.Boot = guestinit.Boot{Hostname: "kfc-x", Port: vsock.GuestPort, TmpMB: 512}
	raw, err := v.Config()
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func sizeOf(l any, kind string) float64 {
	m, _ := l.(map[string]any)
	b, _ := m[kind].(map[string]any)
	n, _ := b["size"].(float64)
	return n
}

// Every drive and the NIC (both ways) get a token bucket sized from the
// machine's vCPUs, up to a ceiling; an operator's own rate replaces the
// default, and a negative one turns that limit off. With none, one VM
// filling its disk starved its neighbours' guest agents.
func TestAMachinesDisksAndNICAreBoundedByItsShape(t *testing.T) {
	net := &Net{Tap: "kft1", MAC: "06:00:0a:00:00:01", IP: netip.MustParseAddr("10.213.0.128"), Gateway: netip.MustParseAddr("10.213.0.1"), Prefix: 24}
	for _, c := range []struct {
		name               string
		limits             Limits
		vcpus              int
		disk, ops, netByte float64
	}{
		{"defaults, 2 vCPUs", Limits{}, 2, 200e6, 5000, 2 * 250e6 / 8},
		{"defaults, 16 vCPUs, at the ceilings", Limits{}, 16, driver.MaxDiskMBps * 1e6, driver.MaxDiskIOPS, driver.MaxNetMbps * 1e6 / 8},
		{"the operator's rates", Limits{DiskMBps: 50, DiskIOPS: 1000, NetMbps: 100}, 1, 50e6, 1000, 100e6 / 8},
		{"turned off", Limits{DiskMBps: -1, DiskIOPS: -1, NetMbps: -1}, 2, 0, 0, 0},
	} {
		m := configOf(t, VM{VCPUs: c.vcpus, MemoryMB: 512, DataDisk: true, Net: net, Rates: ratesOf(c.limits, c.vcpus)})
		drives := m["drives"].([]any)
		for _, d := range drives {
			l := d.(map[string]any)["rate_limiter"]
			if sizeOf(l, "bandwidth") != c.disk || sizeOf(l, "ops") != c.ops {
				t.Errorf("%s: drive %v", c.name, d)
			}
		}
		nic := m["network-interfaces"].([]any)[0].(map[string]any)
		if sizeOf(nic["rx_rate_limiter"], "bandwidth") != c.netByte || sizeOf(nic["tx_rate_limiter"], "bandwidth") != c.netByte {
			t.Errorf("%s: nic %v", c.name, nic)
		}
		if c.disk == 0 {
			if _, ok := drives[0].(map[string]any)["rate_limiter"]; ok {
				t.Errorf("%s: a limiter of nothing", c.name)
			}
		}
	}
}

// The VMM's cgroup gets io.max on the state disk at twice the drives'
// bandwidth: the bucket shapes the guest, the cgroup bounds the VMM's own
// snapshot and writeback I/O. No device or no limit: no io.max.
func TestTheVMMsCgroupBoundsItsIOOnTheStateDisk(t *testing.T) {
	r := ratesOf(Limits{}, 2)
	if got := r.ioMax("259:0"); got != "259:0 rbps=400000000 wbps=400000000" {
		t.Fatalf("io.max %q", got)
	}
	if r.ioMax("") != "" || ratesOf(Limits{DiskMBps: -1}, 2).ioMax("259:0") != "" {
		t.Fatal("io.max without a device or a limit")
	}
	// Written into the VMM's cgroup once the jailer made it (its --cgroup takes no value with a space).
	b, _, _ := snapBackend(t)
	b.ioDev = "259:0"
	name := "kodus-io-workload"
	if err := os.MkdirAll(b.cgroupDir(idOf(name)), 0o755); err != nil {
		t.Fatal(err)
	}
	m, err := b.Create(context.Background(), isolation.Spec{Shape: isolation.ShapeSandbox, Name: name, Network: "kodus-io", CPUs: "2"})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(b.cgroupDir(m.ID), "io.max"))
	if string(got) != "259:0 rbps=400000000 wbps=400000000" {
		t.Fatalf("io.max %q", got)
	}
	_ = os.Remove(filepath.Join(b.cgroupDir(m.ID), "io.max"))
}

// A machine restored from a snapshot gets this cell's buckets on its drives
// and its NIC: a snapshot keeps the ones it was taken with, none before.
func TestARestoredMachineGetsTheCellsLimits(t *testing.T) {
	b, vmm, _ := snapBackend(t)
	setupSandbox(t, b, "kodus-setup-workload", "kodus-setup")
	snap, err := b.Snapshot(context.Background(), "kodus-setup-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a"})
	if err != nil {
		t.Fatal(err)
	}
	m, err := b.Restore(context.Background(), snap, isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-c-workload", Network: "kodus-c", Org: "org-a"})
	if err != nil {
		t.Fatal(err)
	}
	got := vmm.limits[m.ID]
	if len(got) != 2 || got[0]["drive_id"] != "rootfs" || got[1]["iface_id"] != "eth0" || sizeOf(got[0]["rate_limiter"], "bandwidth") == 0 || sizeOf(got[1]["tx_rate_limiter"], "bandwidth") == 0 {
		t.Fatalf("limits patched on the restore: %v", got)
	}
}

// The VMM joins its machine's network namespace (the jailer's --netns, the
// path the network gave the tap in), on boot and on a restore alike.
func TestTheVMMRunsInItsMachinesNetworkNamespace(t *testing.T) {
	b, vmm, _ := snapBackend(t)
	src := setupSandbox(t, b, "kodus-setup-workload", "kodus-setup")
	if got := argValues(vmm.args[src.ID], "--netns"); len(got) != 1 || got[0] != "/run/netns/kfn-kodus-setup-workload" {
		t.Fatalf("boot: --netns %v", got)
	}
	snap, err := b.Snapshot(context.Background(), "kodus-setup-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a"})
	if err != nil {
		t.Fatal(err)
	}
	m, err := b.Restore(context.Background(), snap, isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-c-workload", Network: "kodus-c", Org: "org-a"})
	if err != nil {
		t.Fatal(err)
	}
	if got := argValues(vmm.args[m.ID], "--netns"); len(got) != 1 || got[0] != "/run/netns/kfn-kodus-c-workload" {
		t.Fatalf("restore: --netns %v", got)
	}
	if args := (Jail{ID: "kfc-x", Exec: "/fc", ChrootBase: "/j", CgroupParent: "p", MemoryMB: 512, CPUs: 1}).Args(); slices.Contains(args, "--netns") {
		t.Fatal("--netns with no namespace")
	}
}
