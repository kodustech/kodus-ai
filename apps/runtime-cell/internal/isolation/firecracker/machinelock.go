package firecracker

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// The machine lock (F2-01). The orphan pass of the out-of-process reaper
// reads the records once, then removes every VMM, cgroup, jail, tap and
// namespace no record names. A Create or Restore of the cell writes its
// record first, then makes those: one that wrote its record just after the
// pass read the records lost its tap, jail or cgroup while it booted. The
// cell's Create and Restore hold the state directory's lock shared from
// their record until they return, and the pass holds it exclusive for the
// whole of it, so neither ever sees the other half done.

// machineLockName is the lock file in the state directory.
const machineLockName = "machines.lock"

// lockMachines takes the machine lock, shared (a Create, a Restore) or
// exclusive (the orphan pass); the returned func lets it go.
func (b *Backend) lockMachines(exclusive bool) (func(), error) {
	f, err := os.OpenFile(filepath.Join(b.cfg.StateDir, machineLockName), os.O_CREATE|os.O_RDWR, 0o600) //nolint:gosec // G304: the cell's own state directory
	if err != nil {
		return nil, fmt.Errorf("firecracker: machine lock: %w", err)
	}
	how := syscall.LOCK_SH
	if exclusive {
		how = syscall.LOCK_EX
	}
	for {
		err = syscall.Flock(int(f.Fd()), how) //nolint:gosec // G115: a file descriptor fits an int
		if err != syscall.EINTR {
			break
		}
	}
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("firecracker: machine lock: %w", err)
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) //nolint:gosec // G115: as above
		_ = f.Close()
	}, nil
}
