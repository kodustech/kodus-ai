package guestinit

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

// AgentPath is the guest agent's binary in every rootfs: the kernel starts
// it as init (init=AgentPath) and init starts it again as the server. Init
// never asks the kernel for its own path: that is a read of /proc/self/exe,
// and /proc is not mounted when the kernel hands over.
const AgentPath = "/usr/local/bin/kody-guest"

// SystemPATH is the PATH of every program init starts, and the only one it
// looks programs up in: the kernel starts init with HOME and TERM and no
// PATH at all.
const SystemPATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// Kernel is what PID 1 asks of the kernel it runs on (init_linux.go; a
// test gives a fake). The kernel gives init a root file system and nothing
// else: no /proc until init mounts it and no PATH, so init reads nothing
// before it has mounted it and names every program by the PATH it gives
// that program.
type Kernel interface {
	// Mount makes the target, then mounts; a target the kernel mounted
	// already (devtmpfs) is no error.
	Mount(Mount) error
	ReadFile(path string) ([]byte, error)
	// WriteFile writes a file every user of the machine reads (0644).
	WriteFile(path string, data []byte) error
	MkdirAll(path string, perm fs.FileMode) error
	Sethostname(name string) error
	// LinkUp sets an interface up (the kernel's ip= sets eth0, not lo).
	LinkUp(name string) error
	// HasExt4 reports whether the device's superblock is ext4's.
	HasExt4(dev string) (bool, error)
	// IsExecutable reports whether path is a file init can run.
	IsExecutable(path string) bool
	// Run runs p to its end and returns its output.
	Run(p Process) ([]byte, error)
	// Start starts p in a session of its own and returns its pid.
	Start(p Process) (int, error)
}

// Process is one program init starts.
type Process struct {
	// Name is the program: a path, or a name looked up in Env's PATH.
	Name string
	Args []string
	// Env is the program's whole environment; init's own is not passed on.
	Env []string
	Dir string
	// UID and GID are the program's credentials when either is not zero.
	UID, GID int
	// NoNewPrivs: the program and everything it starts never gain a
	// privilege.
	NoNewPrivs bool
	// Log is the file its output is appended to ("": init's own).
	Log string
	// Cgroup is the cgroup (under CgroupRoot) the program starts in; empty:
	// init's own.
	Cgroup string
}

// Env is the environment of a program init starts with that home.
func Env(home string) []string { return []string{"PATH=" + SystemPATH, "HOME=" + home} }

// Path resolves the program the way execve's callers do, but in the PATH
// of the program's own environment, never in init's.
func (p Process) Path(isExecutable func(string) bool) (string, error) {
	if strings.Contains(p.Name, "/") {
		if !isExecutable(p.Name) {
			return "", fmt.Errorf("guestinit: %s is not an executable file", p.Name)
		}
		return p.Name, nil
	}
	for _, kv := range p.Env {
		path, ok := strings.CutPrefix(kv, "PATH=")
		if !ok {
			continue
		}
		for _, dir := range filepath.SplitList(path) {
			if dir == "" {
				continue
			}
			if c := filepath.Join(dir, p.Name); isExecutable(c) {
				return c, nil
			}
		}
	}
	return "", fmt.Errorf("guestinit: exec: %q: executable file not found in $PATH", p.Name)
}

// Machine is what Setup left running: the guest agent's server, which PID 1
// starts again whenever it dies.
type Machine struct {
	Profile   Profile
	Server    Process
	ServerPID int
}

// ProcMount is the first thing init mounts: everything after it reads the
// command line.
var ProcMount = Mount{Source: "proc", Target: "/proc", FSType: "proc", Flags: []string{"nosuid", "nodev", "noexec"}}

// Setup is PID 1's work up to the server: /proc first, then the profile
// and the boot values, the mounts (a blank data disk formatted just before
// it is mounted), the host name, lo, the resolver file, dockerd in an
// environment, and the server under the profile's user.
func Setup(k Kernel) (Machine, error) {
	if err := k.Mount(ProcMount); err != nil {
		return Machine{}, fmt.Errorf("guestinit: mount /proc: %w", err)
	}
	raw, err := k.ReadFile(ProfilePath)
	if err != nil {
		return Machine{}, fmt.Errorf("guestinit: %w", err)
	}
	p, err := ParseProfile(raw)
	if err != nil {
		return Machine{}, err
	}
	cmdline, err := k.ReadFile("/proc/cmdline")
	if err != nil {
		return Machine{}, fmt.Errorf("guestinit: %w", err)
	}
	b, err := ParseCmdline(string(cmdline))
	if err != nil {
		return Machine{}, err
	}
	for _, m := range p.Mounts(b) {
		if m.Target == ProcMount.Target {
			continue
		}
		if m.Target == DataMount {
			if err := formatOnce(k, m.Source); err != nil {
				return Machine{}, err
			}
		}
		if err := k.Mount(m); err != nil {
			return Machine{}, fmt.Errorf("guestinit: mount %s on %s: %w", m.FSType, m.Target, err)
		}
		if m.Target == DataMount {
			for _, d := range []string{"docker", "containerd", "workspace"} {
				if err := k.MkdirAll(filepath.Join(DataMount, d), 0o711); err != nil {
					return Machine{}, fmt.Errorf("guestinit: %w", err)
				}
			}
		}
	}
	if err := workloadCgroups(k); err != nil {
		return Machine{}, err
	}
	if err := k.Sethostname(b.Hostname); err != nil {
		return Machine{}, fmt.Errorf("guestinit: hostname: %w", err)
	}
	if err := k.LinkUp("lo"); err != nil {
		return Machine{}, fmt.Errorf("guestinit: lo up: %w", err)
	}
	if r := Resolv(b); r != "" {
		if err := k.WriteFile(ResolvPath, []byte(r)); err != nil {
			return Machine{}, fmt.Errorf("guestinit: %w", err)
		}
	}
	if p.Docker {
		d := Process{Name: "dockerd", Args: DockerdArgs(), Env: Env("/root"), Log: "/var/log/dockerd.log", Cgroup: AgentCgroup}
		if _, err := k.Start(d); err != nil {
			return Machine{}, fmt.Errorf("guestinit: start dockerd: %w", err)
		}
	}
	server := Process{Name: AgentPath, Args: ServerArgs(b), Env: Env("/tmp"), Dir: "/", UID: p.UID, GID: p.GID, NoNewPrivs: p.NoNewPrivs, Cgroup: AgentCgroup}
	pid, err := k.Start(server)
	if err != nil {
		return Machine{}, fmt.Errorf("guestinit: start the server: %w", err)
	}
	return Machine{Profile: p, Server: server, ServerPID: pid}, nil
}

// workloadCgroups makes the workload's cgroups (WorkloadCgroup) and lets
// them take every controller the kernel has: the workload's own cgroup holds
// no process (cgroup v2 keeps processes in leaves), so its children can be
// bounded, and Docker's containers under DockerCgroup get their limits.
func workloadCgroups(k Kernel) error {
	for _, d := range []string{AgentCgroup, DockerCgroup} {
		if err := k.MkdirAll(CgroupRoot+"/"+d, 0o755); err != nil {
			return fmt.Errorf("guestinit: cgroup %s: %w", d, err)
		}
	}
	raw, err := k.ReadFile(CgroupRoot + "/cgroup.controllers")
	if err != nil {
		return fmt.Errorf("guestinit: cgroup controllers: %w", err)
	}
	var enable []string
	for _, c := range strings.Fields(string(raw)) {
		enable = append(enable, "+"+c)
	}
	if len(enable) == 0 {
		return nil
	}
	for _, d := range []string{CgroupRoot, CgroupRoot + "/" + WorkloadCgroup} {
		if err := k.WriteFile(d+"/cgroup.subtree_control", []byte(strings.Join(enable, " "))); err != nil {
			return fmt.Errorf("guestinit: delegate %s in %s: %w", strings.Join(enable, " "), d, err)
		}
	}
	return nil
}

// formatOnce makes an ext4 file system on a blank data disk (its first
// boot): a disk whose superblock is already ext4 keeps its data.
func formatOnce(k Kernel, dev string) error {
	ok, err := k.HasExt4(dev)
	if err != nil {
		return fmt.Errorf("guestinit: data disk: %w", err)
	}
	if ok {
		return nil
	}
	out, err := k.Run(Process{Name: "mkfs.ext4", Args: []string{"-q", "-F", "-L", "kody-data", dev}, Env: Env("/root")})
	if err != nil {
		return fmt.Errorf("guestinit: mkfs.ext4 %s: %w: %s", dev, err, out)
	}
	return nil
}

// ErrNotLinux is Run on a system that is not Linux.
var ErrNotLinux = errors.New("guestinit: a microVM's init needs Linux")
