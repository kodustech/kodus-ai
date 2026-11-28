//go:build !linux

package preflight

import "errors"

// KernelClockSynced is Linux's only: elsewhere the check reports nothing.
func KernelClockSynced() (bool, error) {
	return false, errors.New("preflight: clock state is read on Linux only")
}
