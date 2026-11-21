package guestinit

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

// WorkloadCgroup is the cgroup (under /sys/fs/cgroup) of everything the
// machine runs but init: the guest agent's server and every command it
// starts in AgentCgroup, dockerd and containerd there too, and Docker's
// containers under DockerCgroup. Freezing it stops every process of the
// workload at once and leaves init running.
const (
	WorkloadCgroup = "kody-workload"
	AgentCgroup    = WorkloadCgroup + "/agent"
	DockerCgroup   = WorkloadCgroup + "/docker"
)

// CgroupRoot is where init mounts cgroup2.
const CgroupRoot = "/sys/fs/cgroup"

// The files a rebirth writes and binds over the kernel's or the image's.
const (
	BootIDPath      = "/proc/sys/kernel/random/boot_id"
	BootIDFile      = "/run/kody/boot_id"
	MachineIDPath   = "/etc/machine-id"
	MachineIDFile   = "/run/kody/machine-id"
	systemdSeedFile = "/var/lib/systemd/random-seed"
)

// SeedFiles are the random seeds an init system saves across boots; a
// snapshot must hold none, or every restored machine would start from it
// (docs/snapshotting/random-for-clones.md, "User space considerations").
var SeedFiles = []string{systemdSeedFile, "/var/lib/random-seed"}

// Proc is one process as /proc shows it.
type Proc struct {
	PID, PPID int
	Comm      string
}

// CloneKernel is what PID 1 asks of the kernel around a snapshot
// (init_linux.go; a test gives a fake).
type CloneKernel interface {
	// AddEntropy mixes b into the kernel's input pool, credited
	// (RNDADDENTROPY), then reseeds the generator from it (RNDRESEEDCRNG).
	AddEntropy(b []byte) error
	// SetClock sets the wall clock (CLOCK_REALTIME).
	SetClock(unixNano int64) error
	Now() int64
	Sethostname(name string) error
	// WriteInPlace replaces a file's content without a new inode, so a
	// bind of it shows the new content.
	WriteInPlace(path string, data []byte) error
	// Bind mounts the file src over dst once; a dst bound already stays.
	Bind(src, dst string) error
	Exists(path string) bool
	Remove(path string) error
	ReadFile(path string) ([]byte, error)
	// ConfigureNet takes eth0 down (its routes and neighbours go), gives it
	// the MAC and address, brings it up and routes through the gateway.
	ConfigureNet(iface string, n NetConfig) error
	// Freeze freezes or thaws a cgroup and waits until it is.
	Freeze(cgroup string, frozen bool) error
	Processes() ([]Proc, error)
}

// Clone is init's side of the cell's snapshot steps.
type Clone struct {
	K       CloneKernel
	Profile Profile
	// ServerPID is the guest agent server's pid now (init restarts it).
	ServerPID func() int
	// Resolv writes the resolver file.
	Resolv func(data []byte) error
	mu     sync.Mutex
}

// Handle answers one control request read at readAt.
func (c *Clone) Handle(req ControlRequest, readAt time.Time) ControlReply {
	c.mu.Lock()
	defer c.mu.Unlock()
	var (
		rep ControlReply
		err error
	)
	switch req.Op {
	case OpPrepare:
		err = c.prepare(req.Purpose)
	case OpThaw:
		err = c.K.Freeze(WorkloadCgroup, false)
	case OpRebirth:
		if req.Rebirth == nil {
			err = errors.New("guestinit: a rebirth without its values")
			break
		}
		rep, err = c.rebirth(*req.Rebirth, readAt)
	default:
		err = fmt.Errorf("guestinit: unknown control op %q", req.Op)
	}
	if err != nil {
		return ControlReply{Error: clip(err.Error())}
	}
	rep.OK = true
	return rep
}

func clip(s string) string {
	if len(s) > 512 {
		return s[:512]
	}
	return s
}

// prepare refuses a sandbox template that runs any process of its
// workload (its memory would carry that process's state, random generators
// included, into every machine restored from it), removes the seed files,
// and freezes the workload. A session comes back as one machine and a round
// only into its own claim's machine, so their processes go with them; an environment runs its system by design, and what
// its processes hold is the residual risk docs/runtime/isolation-p3-snapshots.md
// states.
func (c *Clone) prepare(purpose string) error {
	switch purpose {
	case "template":
		if !c.Profile.Docker {
			if err := c.onlyOurs(); err != nil {
				return err
			}
		}
	case "session", "round":
		// One machine comes back from a session; a round comes back only
		// into its own claim's same machine: their processes go with them.
	default:
		return fmt.Errorf("guestinit: prepare for %q", purpose)
	}
	for _, f := range SeedFiles {
		if c.K.Exists(f) {
			if err := c.K.Remove(f); err != nil {
				return fmt.Errorf("guestinit: remove %s: %w", f, err)
			}
		}
	}
	if err := c.K.Freeze(WorkloadCgroup, true); err != nil {
		_ = c.K.Freeze(WorkloadCgroup, false)
		return fmt.Errorf("guestinit: freeze the workload: %w", err)
	}
	return nil
}

// onlyOurs refuses when a process other than init, the server and the
// kernel's threads runs.
func (c *Clone) onlyOurs() error {
	ps, err := c.K.Processes()
	if err != nil {
		return err
	}
	server := c.ServerPID()
	var foreign []string
	for _, p := range ps {
		if p.PID == 1 || p.PID == server || p.PID == 2 || p.PPID == 2 {
			continue
		}
		foreign = append(foreign, p.Comm+"("+strconv.Itoa(p.PID)+")")
	}
	if len(foreign) > 0 {
		if len(foreign) > 8 {
			foreign = append(foreign[:8], "...")
		}
		return fmt.Errorf("guestinit: a sandbox snapshot holds no process of its workload; running: %s", strings.Join(foreign, ", "))
	}
	return nil
}

// rebirth makes a restored machine its own, in the order that leaves
// nothing of the workload running on the snapshot's state: the kernel's
// generator first, then the clock, the names, the address and the
// resolver, and the workload thaws last.
func (c *Clone) rebirth(r Rebirth, readAt time.Time) (ControlReply, error) {
	if err := r.Validate(); err != nil {
		return ControlReply{}, err
	}
	if err := c.K.AddEntropy(r.Seed); err != nil {
		return ControlReply{}, fmt.Errorf("guestinit: reseed: %w", err)
	}
	if err := c.K.SetClock(r.UnixNano + int64(time.Since(readAt))); err != nil {
		return ControlReply{}, fmt.Errorf("guestinit: clock: %w", err)
	}
	if err := c.K.Sethostname(r.Hostname); err != nil {
		return ControlReply{}, fmt.Errorf("guestinit: hostname: %w", err)
	}
	if err := c.newID(BootIDFile, BootIDPath, r.BootID+"\n"); err != nil {
		return ControlReply{}, err
	}
	if c.K.Exists(MachineIDPath) {
		if err := c.newID(MachineIDFile, MachineIDPath, r.MachineID+"\n"); err != nil {
			return ControlReply{}, err
		}
	}
	if r.Net != nil {
		if err := c.K.ConfigureNet("eth0", *r.Net); err != nil {
			return ControlReply{}, fmt.Errorf("guestinit: eth0: %w", err)
		}
	}
	if r.DNS.IsValid() && c.Resolv != nil {
		if err := c.Resolv([]byte(Resolv(Boot{DNS: r.DNS}))); err != nil {
			return ControlReply{}, fmt.Errorf("guestinit: resolver: %w", err)
		}
	}
	for _, f := range SeedFiles {
		if c.K.Exists(f) {
			_ = c.K.Remove(f)
		}
	}
	got, err := c.K.ReadFile(BootIDPath)
	if err != nil {
		return ControlReply{}, err
	}
	if strings.TrimSpace(string(got)) != r.BootID {
		return ControlReply{}, fmt.Errorf("guestinit: boot_id reads %q after the rebirth", strings.TrimSpace(string(got)))
	}
	if err := c.K.Freeze(WorkloadCgroup, false); err != nil {
		return ControlReply{}, fmt.Errorf("guestinit: thaw the workload: %w", err)
	}
	return ControlReply{BootID: r.BootID, UnixNano: c.K.Now()}, nil
}

// newID writes id to file and binds it over path (once; later rebirths
// rewrite the file in place).
func (c *Clone) newID(file, path, id string) error {
	if err := c.K.WriteInPlace(file, []byte(id)); err != nil {
		return fmt.Errorf("guestinit: %w", err)
	}
	if err := c.K.Bind(file, path); err != nil {
		return fmt.Errorf("guestinit: bind %s: %w", path, err)
	}
	return nil
}

// parseStat reads "pid (comm) state ppid ...": comm may hold anything, so
// the fields after it start at the last ')'.
func parseStat(pid int, s string) (Proc, bool) {
	open, end := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
	if open < 0 || end < open {
		return Proc{}, false
	}
	f := strings.Fields(s[end+1:])
	if len(f) < 2 {
		return Proc{}, false
	}
	ppid, err := strconv.Atoi(f[1])
	if err != nil {
		return Proc{}, false
	}
	comm := s[open+1 : end]
	if len(comm) > 32 {
		comm = comm[:32]
	}
	return Proc{PID: pid, PPID: ppid, Comm: comm}, true
}
