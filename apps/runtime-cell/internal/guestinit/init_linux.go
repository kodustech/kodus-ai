//go:build linux

package guestinit

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

var mountFlags = map[string]uintptr{
	"nosuid": unix.MS_NOSUID, "nodev": unix.MS_NODEV, "noexec": unix.MS_NOEXEC, "ro": unix.MS_RDONLY, "bind": unix.MS_BIND,
}

// Run is PID 1: it sets the machine up (Setup) and never returns while the
// machine runs, reaping orphans and starting the server again if it dies.
func Run() error {
	k := linuxKernel{}
	m, err := Setup(k)
	if err != nil {
		return err
	}
	var serverPID atomic.Int64
	serverPID.Store(int64(m.ServerPID))
	c := &Clone{
		K: &linuxClone{bound: map[string]bool{}}, Profile: m.Profile,
		ServerPID: func() int { return int(serverPID.Load()) },
		Resolv:    func(b []byte) error { return k.WriteFile(ResolvPath, b) },
	}
	// The image's machine id (an environment's Ubuntu keeps one) would be
	// every machine's: each boot takes its own.
	if c.K.Exists(MachineIDPath) {
		var b [16]byte
		if _, err := rand.Read(b[:]); err == nil {
			if err := c.newID(MachineIDFile, MachineIDPath, hex.EncodeToString(b[:])+"\n"); err != nil {
				fmt.Fprintln(os.Stderr, "kody-guest: machine id:", err)
			}
		}
	}
	go serveControl(c)
	// The wall clock follows the host's (clocksync.go); a kernel without the
	// KVM PTP clock keeps only the rebirth's step.
	if hc, err := openHostClock(); err != nil {
		fmt.Fprintln(os.Stderr, "kody-guest: no host clock, the wall clock is not kept on the host's:", err)
	} else {
		var reported atomic.Bool
		go SyncClock(context.Background(), hc, time.Tick(SyncInterval), func(err error) {
			if reported.CompareAndSwap(false, true) {
				fmt.Fprintln(os.Stderr, "kody-guest: clock sync:", err)
			}
		})
	}
	for {
		var ws unix.WaitStatus
		pid, err := unix.Wait4(-1, &ws, 0, nil)
		if err != nil {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		if pid == m.ServerPID {
			// The server died: the machine is useless without it, so start
			// it again rather than leave a VM nobody can reach.
			time.Sleep(200 * time.Millisecond)
			if m.ServerPID, err = k.Start(m.Server); err != nil {
				fmt.Fprintln(os.Stderr, "kody-guest: restart server:", err)
			}
			serverPID.Store(int64(m.ServerPID))
		}
	}
}

// linuxKernel is the Kernel PID 1 runs on.
type linuxKernel struct{}

func (linuxKernel) Mount(m Mount) error {
	if err := os.MkdirAll(m.Target, 0o755); err != nil { //nolint:gosec // G301: mount points of a root file system are 0755
		return err
	}
	var flags uintptr
	for _, f := range m.Flags {
		flags |= mountFlags[f]
	}
	err := unix.Mount(m.Source, m.Target, m.FSType, flags, m.Data)
	if errors.Is(err, unix.EBUSY) {
		return nil // the kernel mounted it already (devtmpfs)
	}
	return err
}

func (linuxKernel) ReadFile(path string) ([]byte, error) {
	return os.ReadFile(path) //nolint:gosec // G304: init's own fixed paths
}

func (linuxKernel) WriteFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil { //nolint:gosec // G301: every user of the machine reads it
		return err
	}
	return os.WriteFile(path, data, 0o644) //nolint:gosec // G306: every user of the machine reads it
}

func (linuxKernel) MkdirAll(path string, perm fs.FileMode) error { return os.MkdirAll(path, perm) }

func (linuxKernel) Sethostname(name string) error { return unix.Sethostname([]byte(name)) }

func (linuxKernel) LinkUp(name string) error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer func() { _ = unix.Close(fd) }()
	ifr, err := unix.NewIfreq(name)
	if err != nil {
		return err
	}
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, ifr); err != nil {
		return err
	}
	ifr.SetUint16(ifr.Uint16() | unix.IFF_UP)
	return unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, ifr)
}

func (linuxKernel) HasExt4(dev string) (bool, error) {
	f, err := os.Open(dev) //nolint:gosec // G304: the profile's own device
	if err != nil {
		return false, err
	}
	defer func() { _ = f.Close() }()
	magic := make([]byte, 2)
	if _, err := f.ReadAt(magic, 1024+0x38); err != nil {
		return false, err
	}
	return magic[0] == 0x53 && magic[1] == 0xef, nil
}

func (linuxKernel) IsExecutable(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0
}

// command is p as an exec.Cmd at its resolved path, so exec never looks it
// up in init's own PATH, which the kernel does not set.
func (k linuxKernel) command(p Process) (*exec.Cmd, error) {
	path, err := p.Path(k.IsExecutable)
	if err != nil {
		return nil, err
	}
	c := exec.Command(path, p.Args...) //nolint:gosec,noctx // G204: init's own programs; PID 1 has no context to end
	c.Env, c.Dir = p.Env, p.Dir
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if p.UID != 0 || p.GID != 0 {
		c.SysProcAttr.Credential = &syscall.Credential{Uid: uint32(p.UID), Gid: uint32(p.GID), Groups: []uint32{}} //nolint:gosec // G115: the profile's ids are small and fixed
	}
	return c, nil
}

func (k linuxKernel) Run(p Process) ([]byte, error) {
	c, err := k.command(p)
	if err != nil {
		return nil, err
	}
	return c.CombinedOutput()
}

// Start starts p. With NoNewPrivs the thread that forks sets no_new_privs
// first: the child inherits it from that thread, and every command after
// it too.
func (k linuxKernel) Start(p Process) (int, error) {
	c, err := k.command(p)
	if err != nil {
		return 0, err
	}
	c.Stdout, c.Stderr = os.Stdout, os.Stderr
	if p.Log != "" {
		logf, err := os.OpenFile(p.Log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return 0, err
		}
		defer func() { _ = logf.Close() }() // the child has its own copy once started
		c.Stdout, c.Stderr = logf, logf
	}
	if p.Cgroup != "" {
		// The child starts in its cgroup (clone3 CLONE_INTO_CGROUP), never
		// for a moment in init's.
		fd, err := unix.Open(CgroupRoot+"/"+p.Cgroup, unix.O_DIRECTORY|unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			return 0, fmt.Errorf("cgroup %s: %w", p.Cgroup, err)
		}
		defer func() { _ = unix.Close(fd) }()
		c.SysProcAttr.UseCgroupFD, c.SysProcAttr.CgroupFD = true, fd
	}
	done := make(chan error, 1)
	go func() {
		// The thread is never handed back to the scheduler: it ends with
		// the goroutine, so no other goroutine runs with its attributes.
		runtime.LockOSThread()
		if p.NoNewPrivs {
			if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
				done <- fmt.Errorf("no_new_privs: %w", err)
				return
			}
		}
		done <- c.Start()
	}()
	if err := <-done; err != nil {
		return 0, err
	}
	return c.Process.Pid, nil
}
