//go:build linux

package dockergvisor

import (
	"fmt"
	"os"
	"strings"
	"syscall"
)

// overlayMounter mounts the read-only view of an environment's BuildKit
// state with the kernel's overlayfs (the cell runs as root).
type overlayMounter struct{}

func (overlayMounter) Overlay(lower, upper, work, target string) error {
	for _, p := range []string{lower, upper, work} {
		if strings.ContainsAny(p, ",:") {
			return fmt.Errorf("dockergvisor: overlay path %q has a separator", p)
		}
	}
	opts := "lowerdir=" + lower + ",upperdir=" + upper + ",workdir=" + work
	return syscall.Mount("overlay", target, "overlay", syscall.MS_NOSUID|syscall.MS_NODEV, opts)
}

func (overlayMounter) Unmount(target string) error {
	return syscall.Unmount(target, syscall.MNT_DETACH)
}

func (overlayMounter) Mounted(under string) ([]overlayMount, error) {
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return parseOverlayMounts(f, under)
}

func defaultMounter() stateMounter { return overlayMounter{} }

func statfsFree(path string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}
