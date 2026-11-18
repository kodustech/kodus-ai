//go:build !linux

package coverage

import "errors"

// Tmpfs caps a coverage directory on Linux only (tmpfs_linux.go): on any
// other host no claim is instrumented.
type Tmpfs struct{}

func (Tmpfs) Cap(string) error { return errors.New("coverage: a tmpfs cap needs Linux") }

func (Tmpfs) Release(string) error { return nil }

func (Tmpfs) Recover(string) (int, error) { return 0, nil }
