package firecracker

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guestinit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/vsock"
)

// Paths inside a machine's jail, as the jailed firecracker sees them.
const (
	jailAPISock = "/api.sock"
	jailVsock   = "/v.sock"
	jailConfig  = "/config.json"
	jailKernel  = "/vmlinux"
	jailRootfs  = "/rootfs.ext4"
	jailData    = "/data.ext4"
	jailLog     = "/firecracker.log"
	// execName is the binary's name in the jail: the jailer copies
	// -exec-file there and names the jail directory after it.
	execName = "firecracker"
)

// Jail is one machine's jailer invocation.
type Jail struct {
	ID           string
	Exec         string // the kit's firecracker
	UID, GID     int
	ChrootBase   string
	CgroupParent string
	// MemoryMB and CPUs bound the VMM process's cgroup: the guest's memory
	// plus the VMM's own, and its vCPUs.
	MemoryMB, CPUs int
	// FileBytes bounds every file the VMM writes (RLIMIT_FSIZE): VM.FileBytes.
	// Zero: maxLogBytes.
	FileBytes int64
	// Restore starts the VMM with its API only: the machine comes from a
	// snapshot load, not from a config file.
	Restore bool
	// Netns is the network namespace the VMM joins (the machine's own, with
	// its tap in it); empty: the host's.
	Netns string
}

// vmmOverheadMB is what the VMM itself may take beyond the guest's memory.
const vmmOverheadMB = 128

// vmmCacheMB is the host page cache the VMM's own disk and snapshot writes
// may hold beyond the guest's memory and its own: those pages are charged
// to its cgroup. The kernel lets a cgroup's dirty pages grow to a share of
// what it can still cache when the guest's memory is barely touched, and
// that share does not shrink as the guest touches the rest: a guest
// filling its disk once had its VMM OOM-killed with anon 2042 MB against a
// 2688 MiB memory.max, its dirty and writeback pages (up to 630 and
// 150 MB, sampled on the KVM host) left nowhere to go. A flat 512 MiB was
// enough on one host and not the next; the room is half the guest's
// memory, at least vmmCacheMinMB, so it stays above what the kernel lets
// stay dirty. It is in memory.max itself: a memory.high at the guest's
// size throttled every snapshot's memory-file write (the conformance
// snapshots ran 5-10 times slower). It is a limit, not a reservation: the
// cell's admission counts it while a machine boots and builds
// (MemoryMaxMB), not once it is ready (ResidentMB), and the cache is
// reclaimed by the host like any other.
func vmmCacheMB(guestMB int) int { return max(vmmCacheMinMB, guestMB/2) }

const vmmCacheMinMB = 768

// MemoryMaxMB is the memory.max of the VMM of a guest of guestMB, in MB:
// the guest's memory, the VMM's own and the room for its page cache. It is
// the most the host lets that machine hold, and what the cell's memory
// admission counts a booting machine at (drivers/microvm ClaimMemory).
func MemoryMaxMB(guestMB int) int { return guestMB + vmmOverheadMB + vmmCacheMB(guestMB) }

// ResidentMB is what a running machine of guestMB holds that the host
// cannot reclaim, in MB: the guest's memory, which a microVM never gives
// back once touched (no balloon), and the VMM's own. Its page cache is not
// in it: the kernel writes it back and reclaims it.
func ResidentMB(guestMB int) int { return guestMB + vmmOverheadMB }

// maxLogBytes bounds the VMM's log: a guest cannot fill the cell's disk
// through it.
const maxLogBytes = 64 << 20

// FileBytes is the bound on every file the VMM writes, rootBytes and
// dataBytes being the sizes of its root and data disks. The kernel kills a
// process that writes past RLIMIT_FSIZE (SIGXFSZ), so a disk the guest
// writes must fit under it: an environment writes to the end of its root
// and data disks; and every VMM writes its memory file when it is
// snapshotted, the size of the guest's memory.
func (v VM) FileBytes(rootBytes, dataBytes int64) int64 {
	n := max(int64(maxLogBytes), int64(v.MemoryMB)<<20)
	if !v.ReadOnlyRoot {
		n = max(n, rootBytes)
	}
	if v.DataDisk {
		n = max(n, dataBytes)
	}
	return n
}

// Args are the jailer's arguments: its own, then the VMM's after "--".
// It runs firecracker as the machine's own user, chrooted in its jail, in a
// new PID namespace, in a cgroup v2 of the cell's parent bounded to the
// machine's memory and CPUs, with a bound on file size and descriptors.
func (j Jail) Args() []string {
	maxBytes := int64(MemoryMaxMB(j.MemoryMB)) << 20
	fileBytes := j.FileBytes
	if fileBytes <= 0 {
		fileBytes = maxLogBytes
	}
	args := []string{
		"--id", j.ID,
		"--exec-file", j.Exec,
		"--uid", strconv.Itoa(j.UID), "--gid", strconv.Itoa(j.GID),
		"--chroot-base-dir", j.ChrootBase,
		"--cgroup-version", "2",
		"--parent-cgroup", j.CgroupParent,
		"--cgroup", "memory.max=" + strconv.FormatInt(maxBytes, 10),
		"--cgroup", "cpu.max=" + strconv.Itoa(j.CPUs*100000) + " 100000",
		"--cgroup", "pids.max=" + strconv.Itoa(32+4*j.CPUs),
	}
	args = append(args,
		"--resource-limit", "fsize="+strconv.FormatInt(fileBytes, 10),
		"--resource-limit", "no-file=1024",
		"--daemonize",
		"--new-pid-ns",
	)
	if j.Netns != "" {
		args = append(args, "--netns", j.Netns)
	}
	args = append(args, "--", "--api-sock", jailAPISock)
	if !j.Restore {
		args = append(args, "--config-file", jailConfig)
	}
	return args
}

// VM is one machine's Firecracker configuration.
type VM struct {
	VCPUs, MemoryMB int
	// ReadOnlyRoot attaches the root drive read-only (a sandbox).
	ReadOnlyRoot bool
	// DataDisk attaches the data drive (an environment).
	DataDisk bool
	// Net is the machine's interface; nil: none.
	Net  *Net
	Boot guestinit.Boot
	// Rates are its drives' and NIC's token buckets (Limits.of); zero: none.
	Rates rates
}

// Net is a machine's interface as the guest's kernel configures it.
type Net struct {
	Tap     string
	MAC     string
	IP      netip.Addr
	Gateway netip.Addr
	Prefix  int
}

func netmask(bits int) string {
	var b [4]byte
	for i := range bits {
		b[i/8] |= 0x80 >> (i % 8)
	}
	return netip.AddrFrom4(b).String()
}

// BootArgs is the guest kernel's command line: no serial console, the guest
// agent as init, the root read-only or not, the address on eth0 set by the
// kernel, and the guest agent's boot values.
func (v VM) BootArgs() string {
	args := []string{
		"reboot=k", "panic=1", "pci=off", "8250.nr_uarts=0",
		"i8042.noaux", "i8042.nomux", "i8042.nopnp", "i8042.dumbkbd",
		"quiet", "loglevel=1", "random.trust_cpu=on",
		"root=/dev/vda", "rootfstype=ext4",
		"init=" + guestinit.AgentPath,
	}
	if v.ReadOnlyRoot {
		args = append(args, "ro")
	} else {
		args = append(args, "rw")
	}
	if v.Net != nil {
		args = append(args, fmt.Sprintf("ip=%s::%s:%s:%s:eth0:off", v.Net.IP, v.Net.Gateway, netmask(v.Net.Prefix), v.Boot.Hostname))
	}
	return strings.Join(args, " ") + " " + v.Boot.Cmdline()
}

type drive struct {
	ID          string         `json:"drive_id"`
	Path        string         `json:"path_on_host"`
	Root        bool           `json:"is_root_device"`
	ReadOnly    bool           `json:"is_read_only"`
	RateLimiter map[string]any `json:"rate_limiter,omitempty"`
}

// Config is the VMM's config file (--config-file): it boots the machine
// with no API call.
func (v VM) Config() ([]byte, error) {
	if v.VCPUs < 1 || v.MemoryMB < 128 {
		return nil, fmt.Errorf("firecracker: %d vCPUs and %d MiB is not a machine", v.VCPUs, v.MemoryMB)
	}
	if err := v.Boot.Validate(); err != nil {
		return nil, err
	}
	lim := v.Rates.driveLimiter()
	drives := []drive{{ID: "rootfs", Path: jailRootfs, Root: true, ReadOnly: v.ReadOnlyRoot, RateLimiter: lim}}
	if v.DataDisk {
		drives = append(drives, drive{ID: "data", Path: jailData, RateLimiter: lim})
	}
	cfg := map[string]any{
		"boot-source":    map[string]any{"kernel_image_path": jailKernel, "boot_args": v.BootArgs()},
		"drives":         drives,
		"machine-config": map[string]any{"vcpu_count": v.VCPUs, "mem_size_mib": v.MemoryMB, "smt": false},
		"vsock":          map[string]any{"guest_cid": vsock.GuestCID, "uds_path": jailVsock},
		"entropy":        map[string]any{},
		"logger":         map[string]any{"log_path": jailLog, "level": "Warning"},
	}
	if v.Net != nil {
		nic := map[string]any{"iface_id": "eth0", "guest_mac": v.Net.MAC, "host_dev_name": v.Net.Tap}
		if l := v.Rates.netLimiter(); l != nil {
			nic["rx_rate_limiter"], nic["tx_rate_limiter"] = l, l
		}
		cfg["network-interfaces"] = []map[string]any{nic}
	}
	return json.MarshalIndent(cfg, "", "  ")
}
