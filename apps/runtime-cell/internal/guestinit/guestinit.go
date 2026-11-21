// Package guestinit is what the guest agent does as a microVM's first
// process (docs/runtime/isolation-architecture.md C4): it reads the
// machine's profile, which the rootfs builder baked into the image
// (internal/rootfs), and the boot values the cell put on the kernel command
// line, mounts what the machine needs, starts Docker in an environment
// machine, then runs the guest agent's server on vsock under the profile's
// user and reaps orphans for as long as the machine runs.
//
// The rules (what is mounted where, with what bounds and owner; what the
// command line carries) are plain data here and tested without a VM; the
// Linux side (init_linux.go) only carries them out.
package guestinit

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// ProfilePath is where the rootfs builder writes the profile.
const ProfilePath = "/etc/kody-guest/profile.json"

// ResolvPath is the resolver file init writes; the rootfs builder makes
// /etc/resolv.conf a link to it, so a read-only root still takes the
// claim's resolver.
const ResolvPath = "/run/kody/resolv.conf"

// DataMount is where an environment machine's data disk is mounted:
// Docker's and containerd's state, and the workspace.
const DataMount = "/var/lib/kody-data"

// Profile names.
const (
	Sandbox     = "sandbox"
	Environment = "environment"
)

// Profile is what kind of machine a rootfs makes. It comes from the image
// the cell built, never from the workload.
type Profile struct {
	Name string `json:"name"`
	// UID and GID are the guest agent server's, and so every command's:
	// 1000 in a sandbox (as on gVisor), 0 in an environment (Docker).
	UID int `json:"uid"`
	GID int `json:"gid"`
	// NoNewPrivs: the server and every command it starts can never gain a
	// privilege (no_new_privs, as docker's no-new-privileges).
	NoNewPrivs bool `json:"noNewPrivs"`
	// ReadOnlyRoot: the root file system stays read-only; what commands
	// write lives in /workspace and /tmp, in the machine's memory.
	ReadOnlyRoot bool `json:"readOnlyRoot"`
	// Docker: start dockerd (with its own containerd) on the data disk.
	Docker bool `json:"docker"`
	// DataDevice is the block device of the machine's data disk, formatted
	// on its first boot ("" for none).
	DataDevice string `json:"dataDevice,omitempty"`
}

// SandboxProfile and EnvironmentProfile are the two machines the cell makes.
var (
	SandboxProfile     = Profile{Name: Sandbox, UID: 1000, GID: 1000, NoNewPrivs: true, ReadOnlyRoot: true}
	EnvironmentProfile = Profile{Name: Environment, UID: 0, GID: 0, Docker: true, DataDevice: "/dev/vdb"}
)

// ProfileByName is one of the two profiles.
func ProfileByName(name string) (Profile, error) {
	switch name {
	case Sandbox:
		return SandboxProfile, nil
	case Environment:
		return EnvironmentProfile, nil
	}
	return Profile{}, fmt.Errorf("guestinit: unknown profile %q (sandbox or environment)", name)
}

// ParseProfile reads the profile file and refuses anything but one of the
// two profiles as the cell defines them.
func ParseProfile(b []byte) (Profile, error) {
	var p Profile
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return Profile{}, fmt.Errorf("guestinit: profile: %w", err)
	}
	want, err := ProfileByName(p.Name)
	if err != nil {
		return Profile{}, err
	}
	if p != want {
		return Profile{}, fmt.Errorf("guestinit: profile %q differs from the cell's", p.Name)
	}
	return p, nil
}

// Boot is what the cell tells one machine on the kernel command line.
type Boot struct {
	// Hostname is the machine's host name (a new one per machine).
	Hostname string
	// DNS is the cell's resolver for the claim (the egress address).
	DNS netip.Addr
	// Port is the vsock port the guest agent serves.
	Port uint32
	// WorkspaceMB and TmpMB bound the in-memory /workspace and /tmp; zero
	// for /workspace: on the data disk.
	WorkspaceMB, TmpMB int
}

var hostnameRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// Validate refuses what init could not use as given.
func (b Boot) Validate() error {
	switch {
	case !hostnameRE.MatchString(b.Hostname):
		return fmt.Errorf("guestinit: hostname %q", b.Hostname)
	case b.DNS.IsValid() && !b.DNS.Is4():
		return fmt.Errorf("guestinit: resolver %s is not IPv4", b.DNS)
	case b.Port == 0:
		return errors.New("guestinit: no vsock port")
	case b.WorkspaceMB < 0 || b.TmpMB <= 0:
		return errors.New("guestinit: /workspace and /tmp sizes")
	}
	return nil
}

// Cmdline is the boot values as kernel parameters (kody.*), the inverse
// of ParseCmdline.
func (b Boot) Cmdline() string {
	parts := []string{
		"kody.hostname=" + b.Hostname, "kody.port=" + strconv.FormatUint(uint64(b.Port), 10),
		"kody.ws=" + strconv.Itoa(b.WorkspaceMB), "kody.tmp=" + strconv.Itoa(b.TmpMB),
	}
	if b.DNS.IsValid() {
		parts = append(parts, "kody.dns="+b.DNS.String())
	}
	return strings.Join(parts, " ")
}

// ParseCmdline reads the kody.* parameters of /proc/cmdline; the others are
// the kernel's. A kody.* parameter it does not know, or one given twice, is
// refused: the cell writes the command line, so anything else is a bug.
func ParseCmdline(s string) (Boot, error) {
	var b Boot
	seen := map[string]bool{}
	for _, f := range strings.Fields(s) {
		k, v, _ := strings.Cut(f, "=")
		if !strings.HasPrefix(k, "kody.") {
			continue
		}
		if seen[k] {
			return Boot{}, fmt.Errorf("guestinit: %s given twice", k)
		}
		seen[k] = true
		var err error
		switch k {
		case "kody.hostname":
			b.Hostname = v
		case "kody.dns":
			b.DNS, err = netip.ParseAddr(v)
		case "kody.port":
			var p uint64
			p, err = strconv.ParseUint(v, 10, 32)
			b.Port = uint32(p)
		case "kody.ws":
			b.WorkspaceMB, err = strconv.Atoi(v)
		case "kody.tmp":
			b.TmpMB, err = strconv.Atoi(v)
		default:
			return Boot{}, fmt.Errorf("guestinit: unknown parameter %s", k)
		}
		if err != nil {
			return Boot{}, fmt.Errorf("guestinit: %s: %w", k, err)
		}
	}
	return b, b.Validate()
}

// Mount is one mount init makes, in order.
type Mount struct {
	Source, Target, FSType string
	// Flags are the mount flags by name (nosuid, nodev, noexec, ro, bind).
	Flags []string
	Data  string
}

// Has reports whether the mount carries flag.
func (m Mount) Has(flag string) bool { return slices.Contains(m.Flags, flag) }

// Mounts is what init mounts for the profile and the boot values, in order.
func (p Profile) Mounts(b Boot) []Mount {
	nsd := []string{"nosuid", "nodev"}
	m := []Mount{
		ProcMount,
		{Source: "sysfs", Target: "/sys", FSType: "sysfs", Flags: []string{"nosuid", "nodev", "noexec"}},
		{Source: "devtmpfs", Target: "/dev", FSType: "devtmpfs", Flags: []string{"nosuid"}, Data: "mode=0755"},
		{Source: "devpts", Target: "/dev/pts", FSType: "devpts", Flags: []string{"nosuid", "noexec"}, Data: "mode=0620,ptmxmode=0666"},
		{Source: "tmpfs", Target: "/dev/shm", FSType: "tmpfs", Flags: nsd, Data: "mode=1777,size=64m"},
		{Source: "tmpfs", Target: "/run", FSType: "tmpfs", Flags: nsd, Data: "mode=0755,size=64m"},
		{Source: "cgroup2", Target: "/sys/fs/cgroup", FSType: "cgroup2", Flags: []string{"nosuid", "nodev", "noexec"}},
		{Source: "tmpfs", Target: "/tmp", FSType: "tmpfs", Flags: nsd, Data: fmt.Sprintf("mode=1777,size=%dm", b.TmpMB)},
	}
	if p.DataDevice != "" {
		m = append(m,
			Mount{Source: p.DataDevice, Target: DataMount, FSType: "ext4", Flags: nsd},
			Mount{Source: DataMount + "/containerd", Target: "/var/lib/containerd", Flags: []string{"bind"}},
		)
	}
	if b.WorkspaceMB > 0 {
		m = append(m, Mount{
			Source: "tmpfs", Target: "/workspace", FSType: "tmpfs", Flags: nsd,
			Data: fmt.Sprintf("mode=0755,size=%dm,uid=%d,gid=%d", b.WorkspaceMB, p.UID, p.GID),
		})
	} else if p.DataDevice != "" {
		m = append(m, Mount{Source: DataMount + "/workspace", Target: "/workspace", Flags: []string{"bind"}})
	}
	return m
}

// Resolv is the resolver file for the boot values ("" without a resolver:
// a machine with no way out).
func Resolv(b Boot) string {
	if !b.DNS.IsValid() {
		return ""
	}
	return "nameserver " + b.DNS.String() + "\noptions ndots:0 timeout:2 attempts:2\n"
}

// ServerArgs are the guest agent server's arguments for the boot values.
func ServerArgs(b Boot) []string {
	return []string{"-vsock", strconv.FormatUint(uint64(b.Port), 10), "-root", "/workspace"}
}

// DockerdArgs start dockerd with its state on the data disk (it starts its
// own containerd) and its containers under the workload's cgroup, so a
// snapshot's freeze stops them too.
func DockerdArgs() []string {
	return []string{"--data-root", DataMount + "/docker", "--host", "unix:///run/docker.sock", "--cgroup-parent", "/" + DockerCgroup}
}
