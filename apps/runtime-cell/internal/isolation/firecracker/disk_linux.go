//go:build linux

package firecracker

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// reflink makes dst a copy-on-write clone of src (FICLONE): the clone
// shares src's blocks until either is written. It never falls back to a
// full copy: a host whose file system cannot clone is refused at start.
func reflink(src, dst string) error {
	in, err := os.Open(src) //nolint:gosec // G304: the backend's own base image
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600) //nolint:gosec // G304: a path in the machine's own jail
	if err != nil {
		return err
	}
	if err := unix.IoctlFileClone(int(out.Fd()), int(in.Fd())); err != nil {
		_ = out.Close()
		_ = os.Remove(dst) //nolint:gosec // G703: dst is a path the backend built in a machine's own jail
		return fmt.Errorf("firecracker: reflink %s: %w", dst, err)
	}
	return out.Close()
}

// probeReflink clones a small file in dir: a file system without reflink
// (ext4, overlay, tmpfs) is refused, never copied around.
func probeReflink(c *Checks, dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil { //nolint:gosec // G703: the operator's own state directory
		return fmt.Errorf("the state directory %s: %w", dir, err)
	}
	src := filepath.Join(dir, ".reflink-probe")
	dst := src + ".clone"
	_ = os.Remove(dst)                                                //nolint:gosec // G703: a fixed name in the operator's state directory
	if err := os.WriteFile(src, []byte("probe"), 0o600); err != nil { //nolint:gosec // G703: a fixed name in the operator's state directory
		return fmt.Errorf("the state directory %s: %w", dir, err)
	}
	defer func() { _ = os.Remove(src); _ = os.Remove(dst) }() //nolint:gosec // G703: fixed names in the operator's state directory
	if err := c.Reflink(src, dst); err != nil {
		return fmt.Errorf("the state directory %s cannot make copy-on-write clones (it needs XFS with reflink=1 or btrfs): %w", dir, err)
	}
	return nil
}

// kernelRelease is the host kernel's release (uname -r).
func kernelRelease() string {
	var u unix.Utsname
	if err := unix.Uname(&u); err != nil {
		return ""
	}
	return unix.ByteSliceToString(u.Release[:])
}

// freeBytes is what an unprivileged writer may still use on dir's file system.
func freeBytes(dir string) (int64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil //nolint:gosec // G115: a file system's counts fit an int64
}

// allocatedBytes is what a file holds on disk: its blocks, not its size.
func allocatedBytes(path string) (int64, error) {
	var st unix.Stat_t
	if err := unix.Stat(path, &st); err != nil {
		return 0, err
	}
	return st.Blocks * 512, nil
}

// loopBuffered: dir's file system is on a loop device (major 7) whose
// backing file it reads and writes through the page cache (loop/dio 0).
func loopBuffered(dir string) (string, bool) {
	var st unix.Stat_t
	if err := unix.Stat(dir, &st); err != nil {
		return "", false
	}
	major, minor := unix.Major(st.Dev), unix.Minor(st.Dev)
	if major != 7 {
		return "", false
	}
	dio, err := os.ReadFile(fmt.Sprintf("/sys/dev/block/%d:%d/loop/dio", major, minor))
	if err != nil {
		return "", false
	}
	return fmt.Sprintf("/dev/loop%d", minor), strings.TrimSpace(string(dio)) == "0"
}

// blockDevice is the whole disk ("major:minor") dir's file system is on:
// io.max takes a disk, never a partition, so a partition names its disk.
func blockDevice(dir string) string {
	var st unix.Stat_t
	if err := unix.Stat(dir, &st); err != nil {
		return ""
	}
	dev := fmt.Sprintf("%d:%d", unix.Major(st.Dev), unix.Minor(st.Dev))
	sys := "/sys/dev/block/" + dev
	if _, err := os.Stat(sys); err != nil {
		return "" // no block device under it (tmpfs, overlay)
	}
	if _, err := os.Stat(sys + "/partition"); err == nil {
		raw, err := os.ReadFile(sys + "/../dev") //nolint:gosec // G304: sysfs, the device the state directory is on
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(raw))
	}
	return dev
}
