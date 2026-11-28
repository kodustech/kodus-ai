package preflight

import "golang.org/x/sys/unix"

// KernelClockSynced reads the kernel's clock state (adjtimex, changing
// nothing): TIME_ERROR or STA_UNSYNC is a clock no time daemon disciplines.
func KernelClockSynced() (bool, error) {
	var tx unix.Timex
	state, err := unix.Adjtimex(&tx)
	if err != nil {
		return false, err
	}
	return state != unix.TIME_ERROR && tx.Status&unix.STA_UNSYNC == 0, nil
}
