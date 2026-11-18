package firecracker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// TapInventory is a network that can list the host's machine taps and
// remove one by name (hostnet's placement, and the reaper's TapRemover).
type TapInventory interface {
	HostTaps(ctx context.Context) ([]string, error)
	RemoveTap(ctx context.Context, name string) error
	TapOf(machine string) string
}

// NetnsInventory is a network that gives each machine a network namespace
// of its own, and can list and remove them.
type NetnsInventory interface {
	HostNetns(ctx context.Context) ([]string, error)
	RemoveNetns(ctx context.Context, name string) error
	NetnsOf(machine string) string
}

// ForReaper is the backend the out-of-process reaper opens on a cell's
// state directory (cmd/reaper -driver microvm): its records, Destroy and
// ReapOrphans, nothing that boots. It needs no kit, makes no directory and
// touches no cgroup but a machine's own; network is TapRemover's kind, which
// removes taps by name and never writes the nft table.
func ForReaper(cfg Config) (*Backend, error) {
	if cfg.StateDir == "" || cfg.Network == nil {
		return nil, errors.New("firecracker: the reaper needs the state directory and a network")
	}
	cfg = cfg.withDefaults()
	if _, err := os.Stat(filepath.Join(cfg.StateDir, "machines")); err != nil {
		return nil, fmt.Errorf("firecracker: %s is not a microVM state directory: %w", cfg.StateDir, err)
	}
	return &Backend{cfg: cfg, checks: cfg.Checks, bases: map[string]string{}}, nil
}

func (b *Backend) procDir() string {
	if b.cfg.ProcDir != "" {
		return b.cfg.ProcDir
	}
	return "/proc"
}

// ReapOrphans ends what a machine left on the host without a record: a
// VMM process, a cgroup under the cell's parent, a jail, a states file, a
// tap or (when the network has them, NetnsInventory) a network namespace. A record is written before any of them exists and removed after all
// of them are gone (Create, Destroy), so none of them is ever in flight
// without one. It names each thing it removed.
func (b *Backend) ReapOrphans(ctx context.Context) ([]string, error) {
	// No Create or Restore runs between the records read and the removals
	// (machinelock.go).
	unlock, err := b.lockMachines(true)
	if err != nil {
		return nil, err
	}
	defer unlock()
	rs, err := b.Machines()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if b.orphanPassRead != nil {
		b.orphanPassRead()
	}
	known := map[string]bool{}
	taps := map[string]bool{}
	inv, _ := b.cfg.Network.(TapInventory)
	nsInv, _ := b.cfg.Network.(NetnsInventory)
	netns := map[string]bool{}
	for i := range rs {
		known[rs[i].ID] = true
		if inv != nil {
			taps[inv.TapOf(rs[i].Name)] = true
		}
		if nsInv != nil {
			netns[nsInv.NetnsOf(rs[i].Name)] = true
		}
	}
	var gone []string
	var errs []error
	// VMMs first: a process holds its cgroup busy and its jail's files open.
	killed := map[int]string{}
	for pid, id := range b.vmmProcesses() {
		if known[id] {
			continue
		}
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			errs = append(errs, fmt.Errorf("firecracker: kill orphan VMM %d (%s): %w", pid, id, err))
			continue
		}
		killed[pid] = id
	}
	// A killed VMM is not gone yet: its guest's memory is torn down first,
	// which takes long enough on a nested host that S-08 found the process
	// still there after the pass. Each is named only once it has exited.
	for pid, id := range killed {
		if err := b.waitExited(ctx, pid); err != nil {
			errs = append(errs, fmt.Errorf("firecracker: orphan VMM %d (%s): %w", pid, id, err))
			continue
		}
		gone = append(gone, "process "+strconv.Itoa(pid)+" "+id)
	}
	if ents, err := os.ReadDir(filepath.Join(b.cfg.CgroupRoot, b.cfg.CgroupParent)); err == nil {
		for _, e := range ents {
			if id := e.Name(); e.IsDir() && strings.HasPrefix(id, "kfc-") && !known[id] {
				if err := removeCgroup(b.cgroupDir(id)); err != nil {
					errs = append(errs, err)
					continue
				}
				gone = append(gone, "cgroup "+id)
			}
		}
	}
	if ents, err := os.ReadDir(filepath.Join(b.cfg.StateDir, "jail", execName)); err == nil {
		for _, e := range ents {
			if id := e.Name(); strings.HasPrefix(id, "kfc-") && !known[id] {
				if err := os.RemoveAll(b.jailDir(id)); err != nil {
					errs = append(errs, err)
					continue
				}
				gone = append(gone, "jail "+id)
			}
		}
	}
	if ents, err := os.ReadDir(filepath.Dir(b.statesPath("x"))); err == nil {
		for _, e := range ents {
			if id := strings.TrimSuffix(e.Name(), ".jsonl"); strings.HasPrefix(id, "kfc-") && !known[id] {
				if err := os.Remove(b.statesPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
					errs = append(errs, err)
				}
			}
		}
	}
	if inv != nil {
		host, err := inv.HostTaps(ctx)
		if err != nil {
			errs = append(errs, err)
		}
		for _, t := range host {
			if taps[t] {
				continue
			}
			if err := inv.RemoveTap(ctx, t); err != nil {
				errs = append(errs, err)
				continue
			}
			gone = append(gone, "tap "+t)
		}
	}
	if nsInv != nil {
		host, err := nsInv.HostNetns(ctx)
		if err != nil {
			errs = append(errs, err)
		}
		for _, n := range host {
			if netns[n] {
				continue
			}
			if err := nsInv.RemoveNetns(ctx, n); err != nil {
				errs = append(errs, err)
				continue
			}
			gone = append(gone, "netns "+n)
		}
	}
	return gone, errors.Join(errs...)
}

// vmmExitWait bounds how long the orphan pass waits for a VMM it killed.
const vmmExitWait = 10 * time.Second

// waitExited waits until pid has no entry in the host's /proc, or only a
// zombie's (it has exited; its parent has not collected it yet).
func (b *Backend) waitExited(ctx context.Context, pid int) error {
	dir := filepath.Join(b.procDir(), strconv.Itoa(pid))
	deadline := time.Now().Add(vmmExitWait)
	for {
		if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if raw, err := os.ReadFile(filepath.Join(dir, "stat")); err == nil { //nolint:gosec // G304: /proc/<pid>/stat of the VMM this pass killed
			// The state follows the command name, which is in parentheses.
			if i := strings.LastIndexByte(string(raw), ')'); i >= 0 && strings.HasPrefix(strings.TrimSpace(string(raw[i+1:])), "Z") {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("still running %s after SIGKILL", vmmExitWait)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// vmmProcesses are the host's jailed firecracker processes, by pid, with
// the jail id their command line names.
func (b *Backend) vmmProcesses() map[int]string {
	out := map[int]string{}
	ents, err := os.ReadDir(b.procDir())
	if err != nil {
		return out
	}
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 1 {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(b.procDir(), e.Name(), "cmdline"))
		if err != nil {
			continue
		}
		args := strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")
		if len(args) == 0 || filepath.Base(args[0]) != execName {
			continue
		}
		for i, a := range args {
			id := ""
			if v, ok := strings.CutPrefix(a, "--id="); ok {
				id = v
			} else if a == "--id" && i+1 < len(args) {
				id = args[i+1]
			}
			if strings.HasPrefix(id, "kfc-") {
				out[pid] = id
				break
			}
		}
	}
	return out
}
