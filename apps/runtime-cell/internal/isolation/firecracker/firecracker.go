// Package firecracker is the microVM IsolationBackend
// (docs/runtime/isolation-architecture.md C3, phase P2): one Firecracker
// microVM per machine, started by the jailer as a user of its own,
// chrooted, in its own PID namespace and cgroup; a pinned guest kernel and
// a root file system from the verified microVM kit (internal/kit); the
// root as a copy-on-write clone (reflink) of the kit's base; a tap on the
// claim's bridge from the host-network placement (placement/hostnet); and
// the guest agent (cmd/kody-guest, as the VM's init) over vsock.
//
// Snapshots (P3, snapshot.go and docs/runtime/isolation-p3-snapshots.md):
// a template or a session of one machine, kept in the store (vmsnap) and
// restored into a new machine that the guest's init makes its own before
// its workload runs again.
package firecracker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guestinit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/vmsnap"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/hostnet"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/vsock"
)

// Network is the part of the placement a microVM needs: a tap on its
// claim's network (at an address it keeps, when want is valid), and its
// removal.
type Network interface {
	AttachTapAt(ctx context.Context, network, machine string, uid int, want netip.Addr) (hostnet.Attachment, error)
	DetachTap(ctx context.Context, network, machine string) error
}

// Launcher runs the jailer with its arguments and returns once the jailer
// has handed the machine to its daemonized firecracker.
type Launcher interface {
	Launch(ctx context.Context, jailer string, args []string) error
}

// Config is the backend's.
type Config struct {
	Kit *kit.Kit
	// StateDir holds the bases (the kit's images on the clone-capable file
	// system), the jails and one record per machine. It must reflink.
	StateDir string
	Network  Network
	Host     isolation.Host
	// UIDBase and UIDs: each machine's VMM runs as UIDBase+n, n < UIDs
	// (900000 and 4096 when zero); no two live machines share one.
	UIDBase, UIDs int
	// CgroupRoot is the cgroup v2 mount ("/sys/fs/cgroup"), CgroupParent
	// the cell's group under it for every VMM ("kodus-microvm").
	CgroupRoot, CgroupParent string
	// MemoryMB and CPUs size a machine whose spec names none (2048, 2);
	// DataGB is an environment's data disk (40).
	MemoryMB, CPUs, DataGB int
	// Launcher runs the jailer (the host's, when nil).
	Launcher Launcher
	// KitProblem is why the kit did not load, when it did not.
	KitProblem string
	// Snapshots bounds what the snapshot store keeps (vmsnap.Policy; its
	// Here is the backend's own).
	Snapshots vmsnap.Policy
	// Checks replace the host probes (tests).
	Checks *Checks
	// ProcDir is the host's /proc, where ReapOrphans finds VMM processes
	// ("/proc" when empty; tests).
	ProcDir string
	// Limits are each machine's disk and network rates per vCPU (limits.go).
	Limits Limits
	// HostPolicy is HostShared (refuse a host whose SMT, KSM, swap or CPU
	// mitigations are not those of a multi-tenant host) or HostDedicated
	// (report them); empty is HostDedicated (host.go).
	HostPolicy string
	// HostRoot is where the host's /sys and /proc are ("/"; tests).
	HostRoot string
}

// Checks are the host probes New runs.
type Checks struct {
	EUID     func() int
	LookPath func(string) (string, error)
	Stat     func(string) (os.FileInfo, error)
	ReadFile func(string) ([]byte, error)
	// Reflink clones src to dst copy-on-write.
	Reflink func(src, dst string) error
	// Chown gives a jail file to the machine's VMM user.
	Chown func(path string, uid, gid int) error
	// KernelRelease is the host kernel's release.
	KernelRelease func() string
	// LoopBuffered names the loop device dir's file system is on when that
	// device does buffered I/O to its backing file (nil: not checked).
	LoopBuffered func(dir string) (dev string, buffered bool)
	// BlockDevice is the whole disk ("major:minor") dir is on; empty: none.
	BlockDevice func(dir string) string
	// Free is the bytes free on a file system; Allocated the bytes a file
	// holds on disk (its blocks, not its size).
	Free      func(dir string) (int64, error)
	Allocated func(path string) (int64, error)
}

func defaultChecks() *Checks {
	return &Checks{EUID: os.Geteuid, LookPath: exec.LookPath, Stat: os.Stat, ReadFile: os.ReadFile, Reflink: reflink, Chown: os.Lchown, KernelRelease: kernelRelease, Free: freeBytes, Allocated: allocatedBytes, LoopBuffered: loopBuffered, BlockDevice: blockDevice}
}

// Backend runs machines as Firecracker microVMs.
type Backend struct {
	cfg    Config
	checks *Checks
	// bases are the kit's images and kernel in StateDir, by kit path.
	bases map[string]string
	// ioDev is the state device io.max bounds ("major:minor"); empty: the
	// host's cgroup has no io controller or the state is on no block device.
	ioDev string
	mu    sync.Mutex
	// store keeps the snapshots; here is what this host restores with.
	store *vmsnap.Store
	here  vmsnap.Here
}

var _ isolation.Backend = (*Backend)(nil)

func unavailable(reasons []string) error {
	return &isolation.UnavailableError{Backend: isolation.Firecracker, Reason: strings.Join(reasons, "; ")}
}

// maxSockPath is a unix socket path's bound on Linux (sun_path, 108 bytes).
const maxSockPath = 107

// withDefaults fills what cfg leaves unset.
func (cfg Config) withDefaults() Config {
	if cfg.Checks == nil {
		cfg.Checks = defaultChecks()
	}
	if cfg.UIDBase == 0 {
		cfg.UIDBase = 900000
	}
	if cfg.UIDs == 0 {
		cfg.UIDs = 4096
	}
	if cfg.CgroupRoot == "" {
		cfg.CgroupRoot = "/sys/fs/cgroup"
	}
	if cfg.CgroupParent == "" {
		cfg.CgroupParent = "kodus-microvm"
	}
	if cfg.MemoryMB == 0 {
		cfg.MemoryMB = 2048
	}
	if cfg.CPUs == 0 {
		cfg.CPUs = 2
	}
	if cfg.DataGB == 0 {
		cfg.DataGB = 40
	}
	// A round outlives no claim (the longest ceiling is 4 h); a session is
	// a day's pause; a template is replaced by its key's next one, and a
	// week bounds one nobody replaced.
	if cfg.Snapshots.RoundTTL == 0 {
		cfg.Snapshots.RoundTTL = 5 * time.Hour
	}
	if cfg.Snapshots.SessionTTL == 0 {
		cfg.Snapshots.SessionTTL = 24 * time.Hour
	}
	if cfg.Snapshots.TemplateTTL == 0 {
		cfg.Snapshots.TemplateTTL = 7 * 24 * time.Hour
	}
	return cfg
}

// Missing names every prerequisite the host lacks for the backend:
// /dev/kvm, the kit, root, cgroup v2 with memory, cpu and pids, the
// placement's commands and tun device, and a state directory on a file
// system that reflinks. withNetwork: also that a placement was given.
func Missing(cfg Config, withNetwork bool) []string {
	cfg = cfg.withDefaults()
	c := cfg.Checks
	var missing []string
	if !cfg.Host.KVM {
		missing = append(missing, "no usable /dev/kvm (a host with KVM: bare metal or nested virtualization)")
	}
	switch {
	case cfg.KitProblem != "":
		missing = append(missing, "the microVM kit: "+cfg.KitProblem)
	case cfg.Kit == nil:
		missing = append(missing, "no microVM kit (-firecracker-kit and -firecracker-kit-digest)")
	case cfg.Kit.Manifest.Arch != cfg.Host.Arch:
		missing = append(missing, fmt.Sprintf("the kit is for %s, this host is %s", cfg.Kit.Manifest.Arch, cfg.Host.Arch))
	}
	if c.EUID() != 0 {
		missing = append(missing, "the jailer needs root (chroot, device nodes, cgroups, taps)")
	}
	if raw, err := c.ReadFile(filepath.Join(cfg.CgroupRoot, "cgroup.controllers")); err != nil {
		missing = append(missing, "cgroup v2 at "+cfg.CgroupRoot)
	} else if f := strings.Fields(string(raw)); !slices.Contains(f, "memory") || !slices.Contains(f, "cpu") || !slices.Contains(f, "pids") {
		missing = append(missing, "the memory, cpu and pids cgroup controllers at "+cfg.CgroupRoot)
	}
	missing = append(missing, hostnet.Prerequisites(c.LookPath, c.Stat)...)
	if withNetwork && cfg.Network == nil {
		missing = append(missing, "no host-network placement")
	}
	if cfg.StateDir == "" {
		missing = append(missing, "no state directory")
	} else if n := len(filepath.Join(cfg.StateDir, "jail", execName, idOf("x"), "root", "api.sock")); n > maxSockPath {
		missing = append(missing, fmt.Sprintf("the state directory %s is too long for a unix socket in a jail (%d bytes over %d)", cfg.StateDir, n, maxSockPath))
	} else if err := probeReflink(c, cfg.StateDir); err != nil {
		missing = append(missing, err.Error())
	} else if c.LoopBuffered != nil {
		if dev, buffered := c.LoopBuffered(cfg.StateDir); buffered {
			missing = append(missing, fmt.Sprintf("the state directory %s is on %s without direct I/O: every VMM's disk writes would be cached twice in its own memory cgroup, which OOM-kills it mid-write (losetup --direct-io=on %s)", cfg.StateDir, dev, dev))
		}
	}
	if cfg.HostPolicy == HostShared {
		root := cfg.HostRoot
		if root == "" {
			root = "/"
		}
		for _, u := range ProbeHost(c, root, cfg.HostPolicy).Unsafe() {
			missing = append(missing, "a shared cell's host: "+u)
		}
	}
	return missing
}

// Unavailable is the refusal for what Missing named.
func Unavailable(missing []string) error { return unavailable(missing) }

// New checks every prerequisite (Missing) and refuses with all the missing
// ones named, then lays the kit's images in the state directory, where
// machines clone them.
func New(cfg Config) (*Backend, error) {
	cfg = cfg.withDefaults()
	c := cfg.Checks
	if missing := Missing(cfg, true); len(missing) > 0 {
		return nil, unavailable(missing)
	}
	b := &Backend{cfg: cfg, checks: c, bases: map[string]string{}}
	for _, d := range []string{"bases", "jail", "machines", "snapshots"} {
		if err := os.MkdirAll(filepath.Join(cfg.StateDir, d), 0o700); err != nil {
			return nil, err
		}
	}
	files := []kit.File{cfg.Kit.Manifest.Kernel}
	for _, r := range cfg.Kit.Manifest.Rootfs {
		files = append(files, r.File)
	}
	for _, f := range files {
		p, err := b.base(f)
		if err != nil {
			return nil, unavailable([]string{err.Error()})
		}
		b.bases[f.Path] = p
	}
	if err := b.prepareCgroup(); err != nil {
		return nil, unavailable([]string{err.Error()})
	}
	if b.ioController() && c.BlockDevice != nil {
		b.ioDev = c.BlockDevice(cfg.StateDir)
	}
	store, err := vmsnap.NewStore(filepath.Join(cfg.StateDir, "snapshots"))
	if err != nil {
		return nil, unavailable([]string{err.Error()})
	}
	// A snapshot never takes the room the machines' disks were admitted with.
	store.Free = b.freeForSnapshots
	b.store = store
	cpuinfo, _ := c.ReadFile("/proc/cpuinfo")
	release := ""
	if c.KernelRelease != nil {
		release = c.KernelRelease()
	}
	b.here = vmsnap.Here{Kit: cfg.Kit.Digest, Host: vmsnap.HostFingerprint(cpuinfo, release, cfg.Kit.Manifest.Firecracker.SHA256)}
	for _, r := range cfg.Kit.Manifest.Rootfs {
		b.here.Bases = append(b.here.Bases, r.SHA256)
	}
	b.cfg.Snapshots.Here = b.here
	return b, nil
}

// base is a kit file laid in StateDir/bases under its digest, copied once
// and checked as it is copied (the kit may live on another file system).
func (b *Backend) base(f kit.File) (string, error) {
	dst := filepath.Join(b.cfg.StateDir, "bases", f.SHA256+filepath.Ext(f.Path))
	if fi, err := os.Stat(dst); err == nil && fi.Size() == f.Size {
		return dst, nil
	}
	src := b.cfg.Kit.Path(f)
	in, err := os.Open(src) //nolint:gosec // G304: a verified kit file
	if err != nil {
		return "", err
	}
	defer func() { _ = in.Close() }()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o444) //nolint:gosec // G304: the backend's own directory
	if err != nil {
		return "", err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(out, h), in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil && hex.EncodeToString(h.Sum(nil)) != f.SHA256 {
		err = fmt.Errorf("kit file %s changed while it was copied", f.Path)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return dst, os.Rename(tmp, dst)
}

// prepareCgroup makes the cell's cgroup for every VMM and lets its children
// take the memory, cpu and pids controllers.
func (b *Backend) prepareCgroup() error {
	dir := filepath.Join(b.cfg.CgroupRoot, b.cfg.CgroupParent)
	if err := os.MkdirAll(dir, 0o755); err != nil { //nolint:gosec // G301: a cgroup directory
		return fmt.Errorf("cgroup %s: %w", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cgroup.subtree_control"), []byte("+memory +cpu +pids"), 0o644); err != nil { //nolint:gosec // G306: a cgroup control file
		return fmt.Errorf("cgroup %s cannot delegate memory, cpu and pids: %w", dir, err)
	}
	return nil
}

// ioController delegates the io controller to the VMMs' cgroups when the
// host's cgroup has it: io.max then bounds each VMM's I/O on the state
// device. A host without it (no io in the parent's controllers) runs with
// the drives' token buckets alone.
func (b *Backend) ioController() bool {
	dir := filepath.Join(b.cfg.CgroupRoot, b.cfg.CgroupParent)
	return os.WriteFile(filepath.Join(dir, "cgroup.subtree_control"), []byte("+io"), 0o644) == nil //nolint:gosec // G306: a cgroup control file
}

// Capabilities is a microVM on KVM, paused in memory, the guest agent over
// vsock, Docker inside when the kit has an environment base, and memory
// snapshots (templates and sessions).
func (b *Backend) Capabilities() isolation.Capabilities {
	return isolation.Capabilities{
		Backend: isolation.Firecracker, Isolation: driver.IsolationMicroVM, Suspend: "hibernate",
		SnapshotMemory: true, NestedDocker: b.cfg.Kit.NestedDocker(), Guest: "vsock", KVM: true,
		Arch: []string{b.cfg.Kit.Manifest.Arch},
	}
}

// Record is what the backend keeps of a machine on disk, from before its
// VMM starts until its Destroy: enough to find and end everything it made.
type Record struct {
	Name    string            `json:"name"`
	ID      string            `json:"id"`
	UID     int               `json:"uid"`
	Shape   isolation.Shape   `json:"shape"`
	Network string            `json:"network,omitempty"`
	IP      string            `json:"ip,omitempty"`
	Labels  map[string]string `json:"labels"`
	Created time.Time         `json:"created"`
	// Org, Setup, Pool and Taints are what the snapshot rules read
	// (vmsnap.Admit), recorded before the machine exists.
	Org    string            `json:"org,omitempty"`
	Claim  string            `json:"claim,omitempty"`
	Setup  bool              `json:"setup,omitempty"`
	Pool   bool              `json:"pool,omitempty"`
	Taints []isolation.Taint `json:"taints,omitempty"`
	// MemoryMB and VCPUs are the machine's size.
	MemoryMB int `json:"memoryMb,omitempty"`
	VCPUs    int `json:"vcpus,omitempty"`
	// Restored is the snapshot the machine was restored from.
	Restored string `json:"restored,omitempty"`
	// DataBytes is an environment's data disk (zero on records from before:
	// the cell's -firecracker-data-gb).
	DataBytes int64 `json:"dataBytes,omitempty"`
}

func (r Record) facts() vmsnap.Facts {
	return vmsnap.Facts{Org: r.Org, Claim: r.Claim, Setup: r.Setup, Pool: r.Pool, Taints: r.Taints}
}

// idOf is the jail id of a machine name: alphanumerics and a hyphen, short
// enough for the jailer and a unix socket path.
func idOf(name string) string {
	s := sha256.Sum256([]byte(name))
	return "kfc-" + hex.EncodeToString(s[:10])
}

func (b *Backend) recordPath(id string) string {
	return filepath.Join(b.cfg.StateDir, "machines", id+".json")
}

func (b *Backend) jailDir(id string) string {
	return filepath.Join(b.cfg.StateDir, "jail", execName, id)
}

func (b *Backend) rootDir(id string) string { return filepath.Join(b.jailDir(id), "root") }

func (b *Backend) cgroupDir(id string) string {
	return filepath.Join(b.cfg.CgroupRoot, b.cfg.CgroupParent, id)
}

// Machines are the records of every machine the backend holds.
func (b *Backend) Machines() ([]Record, error) {
	entries, err := os.ReadDir(filepath.Join(b.cfg.StateDir, "machines"))
	if err != nil {
		return nil, err
	}
	var out []Record
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		r, err := b.readRecord(strings.TrimSuffix(e.Name(), ".json"))
		if errors.Is(err, fs.ErrNotExist) {
			// Destroyed since the listing: twenty claims released at once
			// made a concurrent List fail here (S-49).
			continue
		}
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

// Inventory is every machine the backend holds, from its records.
func (b *Backend) Inventory(context.Context) ([]isolation.Listed, error) {
	rs, err := b.Machines()
	if err != nil {
		return nil, err
	}
	out := make([]isolation.Listed, 0, len(rs))
	for i := range rs {
		r := &rs[i]
		l := isolation.Listed{Name: r.Name, ID: r.ID, Labels: r.Labels, Addresses: map[string]string{}}
		if r.Network != "" && r.IP != "" {
			l.Addresses[r.Network] = r.IP
		}
		out = append(out, l)
	}
	return out, nil
}

func (b *Backend) readRecord(id string) (Record, error) {
	raw, err := os.ReadFile(b.recordPath(id))
	if err != nil {
		return Record{}, err
	}
	var r Record
	if err := json.Unmarshal(raw, &r); err != nil {
		return Record{}, fmt.Errorf("firecracker: record %s: %w", id, err)
	}
	return r, nil
}

func (b *Backend) writeRecord(r Record) error {
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	tmp := b.recordPath(r.ID) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, b.recordPath(r.ID))
}

// allocUID is the first VMM user no record holds.
func (b *Backend) allocUID() (int, error) {
	rs, err := b.Machines()
	if err != nil {
		return 0, err
	}
	used := map[int]bool{}
	for i := range rs {
		used[rs[i].UID] = true
	}
	for n := range b.cfg.UIDs {
		if !used[b.cfg.UIDBase+n] {
			return b.cfg.UIDBase + n, nil
		}
	}
	return 0, fmt.Errorf("firecracker: all %d VMM users are taken", b.cfg.UIDs)
}

// sizeMB reads a docker-style size ("512m", "2g", "1024") in MiB.
func sizeMB(s string, def int) (int, error) {
	if s == "" {
		return def, nil
	}
	mult := 1
	switch {
	case strings.HasSuffix(s, "g"):
		mult, s = 1024, strings.TrimSuffix(s, "g")
	case strings.HasSuffix(s, "m"):
		s = strings.TrimSuffix(s, "m")
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("firecracker: size %q", s)
	}
	return n * mult, nil
}

// Create boots spec's machine: its record, its tap, its jail with a clone
// of the base for its shape, then the jailer, and returns once the VMM's
// API says it runs. What it made is undone when a step fails.
func (b *Backend) Create(ctx context.Context, spec isolation.Spec) (m isolation.Machine, err error) {
	profile := guestinit.Sandbox
	switch spec.Shape {
	case isolation.ShapeSandbox:
	case isolation.ShapeEnvironment:
		profile = guestinit.Environment
	default:
		return isolation.Machine{}, fmt.Errorf("firecracker: unknown machine shape %q", spec.Shape)
	}
	base, ok := b.cfg.Kit.Manifest.Rootfs[profile]
	if !ok {
		return isolation.Machine{}, fmt.Errorf("%w: the microVM kit has no %s base", driver.ErrUnsupported, profile)
	}
	if spec.Name == "" {
		return isolation.Machine{}, errors.New("firecracker: a machine needs a name")
	}
	mem, err := sizeMB(spec.Memory, b.cfg.MemoryMB)
	if err != nil {
		return isolation.Machine{}, err
	}
	cpus := b.cfg.CPUs
	if spec.CPUs != "" {
		f, perr := strconv.ParseFloat(spec.CPUs, 64)
		if perr != nil || f <= 0 {
			return isolation.Machine{}, fmt.Errorf("firecracker: cpus %q", spec.CPUs)
		}
		cpus = max(1, int(f+0.5))
	}
	id := idOf(spec.Name)
	b.mu.Lock()
	if _, err := os.Stat(b.recordPath(id)); err == nil {
		b.mu.Unlock()
		return isolation.Machine{}, fmt.Errorf("firecracker: machine %s exists", spec.Name)
	}
	var data int64
	if spec.Shape == isolation.ShapeEnvironment {
		data, err = b.dataBytes(spec.DiskSize)
	}
	if err == nil {
		err = b.diskRoom(spec.Shape, data)
	}
	var uid int
	if err == nil {
		uid, err = b.allocUID()
	}
	if err == nil {
		err = b.writeRecord(Record{
			Name: spec.Name, ID: id, UID: uid, Shape: spec.Shape, Network: spec.Network, Labels: spec.Labels, Created: time.Now().UTC(),
			DataBytes: data, Org: spec.Org, Claim: spec.Claim, Setup: spec.Setup, Pool: spec.Pool, Taints: taints(spec.Taints), MemoryMB: mem, VCPUs: cpus,
		})
	}
	b.mu.Unlock()
	if err != nil {
		return isolation.Machine{}, err
	}
	b.transition(id, isolation.StateCreated, "")
	defer func() {
		if err != nil {
			b.transition(id, isolation.StateFailed, err.Error())
			err = errors.Join(err, b.Destroy(context.WithoutCancel(ctx), spec.Name, isolation.DestroyOptions{}))
		}
	}()
	vm := VM{VCPUs: cpus, MemoryMB: mem, ReadOnlyRoot: profile == guestinit.Sandbox, DataDisk: profile == guestinit.Environment, Rates: ratesOf(b.cfg.Limits, cpus)}
	vm.Boot = guestinit.Boot{Hostname: id, Port: vsock.GuestPort, TmpMB: 512}
	if profile == guestinit.Sandbox {
		if vm.Boot.WorkspaceMB, err = sizeMB(spec.WorkspaceSize, mem/2); err != nil {
			return isolation.Machine{}, err
		}
		if vm.Boot.TmpMB, err = sizeMB(spec.TmpSize, 512); err != nil {
			return isolation.Machine{}, err
		}
	}
	ip, netns := "", ""
	if spec.Network != "" {
		a, err := b.cfg.Network.AttachTapAt(ctx, spec.Network, spec.Name, uid, netip.Addr{})
		if err != nil {
			return isolation.Machine{}, err
		}
		netns = a.Netns
		vm.Net = &Net{Tap: a.Tap, MAC: a.MAC, IP: a.IP, Gateway: a.Gateway, Prefix: a.Prefix}
		vm.Boot.DNS = a.DNS
		ip = a.IP.String()
		r, err := b.readRecord(id)
		if err != nil {
			return isolation.Machine{}, err
		}
		r.IP = ip
		if err := b.writeRecord(r); err != nil {
			return isolation.Machine{}, err
		}
	}
	if err := b.makeJail(id, uid, base, vm, data); err != nil {
		return isolation.Machine{}, err
	}
	jail := Jail{
		ID: id, Exec: b.cfg.Kit.Path(b.cfg.Kit.Manifest.Firecracker), UID: uid, GID: uid,
		ChrootBase: filepath.Join(b.cfg.StateDir, "jail"), CgroupParent: b.cfg.CgroupParent, MemoryMB: mem, CPUs: cpus,
		FileBytes: vm.FileBytes(base.Size, data), Netns: netns,
	}
	if err := b.launcher().Launch(ctx, b.cfg.Kit.Path(b.cfg.Kit.Manifest.Jailer), jail.Args()); err != nil {
		return isolation.Machine{}, fmt.Errorf("firecracker: jailer: %w", err)
	}
	b.transition(id, isolation.StateLaunched, "")
	if err := b.boundIO(id, vm.Rates); err != nil {
		return isolation.Machine{}, err
	}
	if err := b.waitRunning(ctx, id); err != nil {
		return isolation.Machine{}, err
	}
	b.transition(id, isolation.StateRunning, "")
	pid, _ := b.pid(id)
	m = isolation.Machine{Name: spec.Name, ID: id, PID: pid, Addresses: map[string]string{}}
	if ip != "" {
		m.Addresses[spec.Network] = ip
	}
	return m, nil
}

// makeJail lays the machine's files in its jail root, owned by its VMM
// user: the root clone (read-only for a sandbox), the kernel, an
// environment's sparse data disk, the config and the log.
func (b *Backend) makeJail(id string, uid int, base kit.Rootfs, vm VM, dataBytes int64) error {
	root := b.rootDir(id)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	in := func(p string) string { return filepath.Join(root, strings.TrimPrefix(p, "/")) }
	if err := b.checks.Reflink(b.bases[base.Path], in(jailRootfs)); err != nil {
		return err
	}
	if err := b.checks.Reflink(b.bases[b.cfg.Kit.Manifest.Kernel.Path], in(jailKernel)); err != nil {
		return err
	}
	owned := []string{in(jailRootfs), in(jailKernel)}
	if vm.DataDisk {
		f, err := os.OpenFile(in(jailData), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		err = f.Truncate(dataBytes)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return err
		}
		owned = append(owned, in(jailData))
	}
	cfg, err := vm.Config()
	if err != nil {
		return err
	}
	if err := os.WriteFile(in(jailConfig), cfg, 0o400); err != nil {
		return err
	}
	if err := os.WriteFile(in(jailLog), nil, 0o600); err != nil {
		return err
	}
	owned = append(owned, in(jailConfig), in(jailLog))
	for _, p := range owned {
		if err := b.checks.Chown(p, uid, uid); err != nil {
			return err
		}
	}
	mode := os.FileMode(0o600)
	if vm.ReadOnlyRoot {
		mode = 0o400
	}
	return os.Chmod(in(jailRootfs), mode)
}

func (b *Backend) launcher() Launcher {
	if b.cfg.Launcher != nil {
		return b.cfg.Launcher
	}
	return hostLauncher{}
}

// hostLauncher runs the jailer on the host. With --new-pid-ns the jailer
// returns once it cloned firecracker; it is reaped either way.
type hostLauncher struct{}

func (hostLauncher) Launch(ctx context.Context, jailer string, args []string) error {
	// The jailer exits once it handed the VMM to its own PID namespace, so
	// ending ctx never reaches the machine.
	cmd := exec.CommandContext(ctx, jailer, args...) //nolint:gosec // G204: the kit's verified jailer and the backend's own arguments
	cmd.Env = []string{}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	out := &strings.Builder{}
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("%w: %s", err, strings.TrimSpace(out.String()))
		}
		return nil
	case <-time.After(10 * time.Second):
		return nil // still running: it did not fork away, but the VMM is up or waitRunning says why
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (b *Backend) apiOf(id string) api { return api{sock: filepath.Join(b.rootDir(id), "api.sock")} }

// waitRunning waits for the VMM's API to say the machine runs.
func (b *Backend) waitRunning(ctx context.Context, id string) error {
	deadline := time.Now().Add(15 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		st, err := b.apiOf(id).state(ctx)
		if err == nil && st == "Running" {
			return nil
		}
		if err == nil {
			err = fmt.Errorf("state %q", st)
		}
		last = err
		time.Sleep(20 * time.Millisecond)
	}
	logTail, _ := os.ReadFile(filepath.Join(b.rootDir(id), "firecracker.log"))
	if len(logTail) > 2000 {
		logTail = logTail[len(logTail)-2000:]
	}
	return fmt.Errorf("firecracker: machine %s did not start: %w (log: %s)", id, last, strings.TrimSpace(string(logTail)))
}

// pid is the VMM's pid as the host sees it (the jailer writes it in the
// jail with --new-pid-ns).
func (b *Backend) pid(id string) (int, error) {
	raw, err := os.ReadFile(filepath.Join(b.rootDir(id), execName+".pid"))
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(raw)))
}

// recordOf is the record of a machine name; ok false when none.
func (b *Backend) recordOf(name string) (Record, bool, error) {
	r, err := b.readRecord(idOf(name))
	if errors.Is(err, os.ErrNotExist) {
		return Record{}, false, nil
	}
	if err != nil {
		return Record{}, false, err
	}
	if r.Name != name {
		return Record{}, false, fmt.Errorf("firecracker: record %s names %s, not %s", r.ID, r.Name, name)
	}
	return r, true, nil
}

// Discard ends a machine whose workload never ran: the same as Destroy.
func (b *Backend) Discard(ctx context.Context, name string) error {
	return b.Destroy(ctx, name, isolation.DestroyOptions{})
}

// Start resumes a paused machine.
func (b *Backend) Start(ctx context.Context, name string) error {
	return b.setState(ctx, name, "Resumed")
}

// Pause stops the machine's vCPUs; its memory stays where it is.
func (b *Backend) Pause(ctx context.Context, name string) error {
	return b.setState(ctx, name, "Paused")
}

func (b *Backend) setState(ctx context.Context, name, state string) error {
	r, ok, err := b.recordOf(name)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("firecracker: no machine %s", name)
	}
	if err := b.apiOf(r.ID).setState(ctx, state); err != nil {
		return err
	}
	b.transition(r.ID, map[string]string{"Paused": isolation.StatePaused, "Resumed": isolation.StateRunning}[state], "")
	return nil
}

// Destroy ends the machine's VMM, then removes its cgroup, its tap, its
// jail (the root clone, the data disk, the sockets) and its record. A
// machine already gone is fine; a step that fails leaves the record, so a
// later Destroy finishes the job.
func (b *Backend) Destroy(ctx context.Context, name string, _ isolation.DestroyOptions) error {
	r, ok, err := b.recordOf(name)
	if err != nil {
		return err
	}
	id := idOf(name)
	if _, alive := b.livePID(id); !alive && ok {
		if last := lastState(b.transitionsOf(id)); last == isolation.StateRunning || last == isolation.StatePaused {
			b.transition(id, isolation.StateExited, "the VMM was gone before Destroy")
		}
	}
	if err := b.kill(id); err != nil {
		return err
	}
	if _, err := os.Stat(b.jailDir(id)); ok && err == nil {
		// Its log goes with the jail: what is known of it is kept first.
		b.transition(id, isolation.StateDestroyed, "")
		b.keep(r)
	}
	var errs []error
	if err := removeCgroup(b.cgroupDir(id)); err != nil {
		errs = append(errs, err)
	}
	if ok && r.Network != "" {
		if err := b.cfg.Network.DetachTap(ctx, r.Network, name); err != nil {
			errs = append(errs, err)
		}
	}
	if err := os.RemoveAll(b.jailDir(id)); err != nil {
		errs = append(errs, err)
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	if err := os.Remove(b.recordPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Remove(b.statesPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// procPath is /proc/<pid>[/elem].
func procPath(pid int, elem ...string) string {
	return filepath.Join(append([]string{"/proc", strconv.Itoa(pid)}, elem...)...)
}

// livePID is the jail's VMM pid while that process still is that VMM (its
// command line names the jail id); ok false when it never started, is
// gone, or the pid is someone else's now.
func (b *Backend) livePID(id string) (int, bool) {
	pid, err := b.pid(id)
	if err != nil || pid <= 1 {
		return 0, false
	}
	cmdline, err := os.ReadFile(procPath(pid, "cmdline"))
	if err != nil || !isVMMOf(cmdline, id) {
		return 0, false
	}
	return pid, true
}

// isVMMOf reports whether a /proc/<pid>/cmdline (NUL-separated) is the
// jail's VMM: the jailer starts it with "--id" and the id as two arguments.
func isVMMOf(cmdline []byte, id string) bool {
	args := strings.Split(strings.TrimRight(string(cmdline), "\x00"), "\x00")
	for i, a := range args {
		if a == "--id="+id || (a == "--id" && i+1 < len(args) && args[i+1] == id) {
			return true
		}
	}
	return false
}

// kill ends the jail's VMM, if it still runs, and waits for it.
func (b *Backend) kill(id string) error {
	pid, ok := b.livePID(id)
	if !ok {
		return nil
	}
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("firecracker: kill %s: %w", id, err)
	}
	for range 250 {
		if _, err := os.Stat(procPath(pid)); errors.Is(err, os.ErrNotExist) {
			return nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	return fmt.Errorf("firecracker: %s did not end after SIGKILL", id)
}

// removeCgroup removes a VMM's cgroup once nothing is left in it. A
// cgroup still busy has its processes killed through cgroup.kill: the
// cgroup is the machine's own, so whatever is in it is that VMM, even when
// its pid file is gone with an earlier Destroy's jail.
func removeCgroup(dir string) error {
	killed := false
	for range 250 {
		err := os.Remove(dir)
		if err == nil || errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if !errors.Is(err, syscall.EBUSY) {
			return fmt.Errorf("firecracker: cgroup %s: %w", dir, err)
		}
		if !killed {
			killed = true
			_ = os.WriteFile(filepath.Join(dir, "cgroup.kill"), []byte("1"), 0o600)
		}
		time.Sleep(20 * time.Millisecond)
	}
	return fmt.Errorf("firecracker: cgroup %s is still busy", dir)
}

// DialVsock opens a stream to port on the machine's vsock (the observer
// mode a claim's observer VM serves): the host reaches a VM only this way.
// The guest's reserved ports (below 1024, init's) are not dialled here.
func (b *Backend) DialVsock(ctx context.Context, name string, port uint32) (net.Conn, error) {
	if port < 1024 {
		return nil, fmt.Errorf("firecracker: vsock port %d is the guest's init's", port)
	}
	r, ok, err := b.recordOf(name)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("firecracker: no machine %s", name)
	}
	return vsock.Dial(ctx, filepath.Join(b.rootDir(r.ID), "v.sock"), port)
}

// DialGuest opens a stream to the guest agent over the machine's vsock.
func (b *Backend) DialGuest(ctx context.Context, name string) (io.ReadWriteCloser, error) {
	r, ok, err := b.recordOf(name)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("firecracker: no machine %s", name)
	}
	if ctx.Err() == nil {
		if _, has := ctx.Deadline(); !has {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
		}
	}
	return vsock.Dial(ctx, filepath.Join(b.rootDir(r.ID), "v.sock"), vsock.GuestPort)
}

// Remains is what the host still holds of a machine: its record, its jail,
// its VMM process, its cgroup. Empty once Destroy finished.
func (b *Backend) Remains(name string) []string {
	id := idOf(name)
	var left []string
	if _, err := os.Stat(b.recordPath(id)); err == nil {
		left = append(left, "record "+b.recordPath(id))
	}
	if _, err := os.Stat(b.jailDir(id)); err == nil {
		left = append(left, "jail "+b.jailDir(id))
	}
	if _, err := os.Stat(b.statesPath(id)); err == nil {
		left = append(left, "states "+b.statesPath(id))
	}
	if pid, ok := b.livePID(id); ok {
		left = append(left, "process "+strconv.Itoa(pid))
	}
	if _, err := os.Stat(b.cgroupDir(id)); err == nil {
		left = append(left, "cgroup "+b.cgroupDir(id))
	}
	return left
}
