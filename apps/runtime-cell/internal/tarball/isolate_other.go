//go:build !linux

package tarball

import (
	"errors"
	"os/exec"
)

func isolate(_ *exec.Cmd, allow bool) error {
	if !allow {
		return errors.New("tarball: no network namespace on this OS; refusing to extract")
	}
	return nil
}
