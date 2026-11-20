//go:build linux

package guest

import "golang.org/x/sys/unix"

// Undumpable makes the guest agent a process the sandbox's commands cannot
// inspect. They run as its user, so by default they could open
// /proc/<guest>/fd/{0,1} (the stream to the cell) to read or forge frames, or
// ptrace it (boundary probes P15/P16, dev cell 2026-11-20). A non-dumpable
// process's /proc entries belong to root and ptrace by its user is refused.
// A command it starts is dumpable again from its execve, as usual.
func Undumpable() error {
	return unix.Prctl(unix.PR_SET_DUMPABLE, 0, 0, 0, 0)
}

// Dumpable reports the process's dumpable flag (for tests and the startup check).
func Dumpable() (bool, error) {
	v, err := unix.PrctlRetInt(unix.PR_GET_DUMPABLE, 0, 0, 0, 0)
	return v != 0, err
}
