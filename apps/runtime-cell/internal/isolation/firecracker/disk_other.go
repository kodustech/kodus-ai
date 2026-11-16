//go:build !linux

package firecracker

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// reflink is Linux only (FICLONE).
func reflink(string, string) error {
	return errors.New("firecracker: copy-on-write clones need Linux (FICLONE on XFS or btrfs)")
}

// probeReflink clones a small file in dir: a file system without reflink
// (ext4, overlay, tmpfs) is refused, never copied around.
func probeReflink(c *Checks, dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("the state directory %s: %w", dir, err)
	}
	src := filepath.Join(dir, ".reflink-probe")
	dst := src + ".clone"
	_ = os.Remove(dst)
	if err := os.WriteFile(src, []byte("probe"), 0o600); err != nil {
		return fmt.Errorf("the state directory %s: %w", dir, err)
	}
	defer func() { _ = os.Remove(src); _ = os.Remove(dst) }()
	if err := c.Reflink(src, dst); err != nil {
		return fmt.Errorf("the state directory %s cannot make copy-on-write clones (it needs XFS with reflink=1 or btrfs): %w", dir, err)
	}
	return nil
}

// kernelRelease is Linux's only.
func kernelRelease() string { return "" }

// freeBytes and allocatedBytes are Linux's only (the backend runs nowhere else).
func freeBytes(string) (int64, error)      { return 0, errors.New("firecracker: Linux only") }
func allocatedBytes(string) (int64, error) { return 0, errors.New("firecracker: Linux only") }

// loopBuffered is Linux's only.
func loopBuffered(string) (string, bool) { return "", false }

func blockDevice(string) string { return "" }
