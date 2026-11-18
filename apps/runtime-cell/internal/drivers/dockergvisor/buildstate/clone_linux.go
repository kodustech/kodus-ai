//go:build linux

package buildstate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"
)

// cloneMounter gives a non-seeding build its own clone of the environment's
// state in place of a kernel overlay of it: every file a reflink (FICLONE),
// so the clone shares the state's blocks until one side writes, and nothing
// the build writes reaches the environment's state (S-52), as with the
// overlay.
//
// Why not the overlay. BuildKit's snapshots are overlays themselves, mounted
// inside the sandbox over directories of its state. A layer that removes or
// replaces a file of a lower layer (COPY . . over the package.json an
// earlier COPY brought) writes a whiteout, a 0:0 character device, in its
// upper directory, and the kernel refuses to create one on an overlay mount
// (ovl_mknod: EPERM). On the overlay such a build failed with "remove
// /app/package.json: operation not permitted" and ran again cold. A clone is
// a plain directory: the whiteout is created.
//
// It needs a filesystem that reflinks (XFS, btrfs); MounterFor picks it only
// there.
type cloneMounter struct {
	// Mounted comes from the overlay mounter: what an earlier cell left
	// mounted is still found and unmounted at start.
	overlayMounter
	workers int
}

// cloneWorkers clone regular files side by side: the walk is one syscall
// chain per file, and a state has a few hundred thousand.
const cloneWorkers = 8

func (m cloneMounter) Overlay(lower, _, _, target string) error {
	return cloneTree(lower, target, m.workers)
}

// Unmount: a clone is a directory, nothing is mounted on it. An overlay an
// earlier cell left there is unmounted.
func (m cloneMounter) Unmount(target string) error {
	err := syscall.Unmount(target, syscall.MNT_DETACH)
	if errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.ENOENT) {
		return nil
	}
	return err
}

// MounterFor is how a non-seeding build reads the environment's state kept
// under root, and its name for the logs: a clone where the filesystem
// reflinks, the kernel's overlay elsewhere.
func MounterFor(root string) (Mounter, string) {
	if reflinks(root) {
		return cloneMounter{workers: cloneWorkers}, "clone"
	}
	return overlayMounter{}, "overlay"
}

// reflinks reports whether files under dir (or its nearest existing
// ancestor, before the store made it) can be cloned.
func reflinks(dir string) bool {
	for {
		if fi, err := os.Stat(dir); err == nil && fi.IsDir() { //nolint:gosec // G703: dir is the operator-configured store root or its ancestor
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
	probe, err := os.MkdirTemp(dir, ".kodus-reflink-")
	if err != nil {
		return false
	}
	defer func() { _ = os.RemoveAll(probe) }() //nolint:gosec // G703: probe is the temp dir just made under the store root; removal is best effort
	src := filepath.Join(probe, "a")
	if err := os.WriteFile(src, []byte("kodus"), 0o600); err != nil { //nolint:gosec // G703: src is a fixed name in a temp dir the cell just made
		return false
	}
	var st unix.Stat_t
	if err := unix.Lstat(src, &st); err != nil {
		return false
	}
	return cloneFile(src, filepath.Join(probe, "b"), &st) == nil
}

// cloneTree makes dst, an existing empty directory, a clone of the tree at
// src: directories, symlinks and special files made again, regular files
// reflinked, each with its owner, mode, extended attributes and times.
// BuildKit's snapshots hold whole root filesystems: setuid bits, file
// capabilities, hard links, and the whiteouts and opaque marks of its own
// overlays all have to come across as they are.
func cloneTree(src, dst string, workers int) error {
	if workers < 1 {
		workers = 1
	}
	c := &cloner{jobs: make(chan cloneJob, 4*workers), links: map[[2]uint64]string{}}
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range c.jobs {
				if c.failed() {
					continue // drain
				}
				c.fail(cloneRegular(j.src, j.dst, &j.st))
			}
		}()
	}
	c.fail(c.walk(src, dst))
	close(c.jobs)
	wg.Wait()
	if c.err != nil {
		return c.err
	}
	// Directory times last, deepest first: filling a directory moves them.
	for i := len(c.dirs) - 1; i >= 0; i-- {
		d := c.dirs[i]
		if err := setTimes(d.dst, &d.st); err != nil {
			return err
		}
	}
	return nil
}

type cloneJob struct {
	src, dst string
	st       unix.Stat_t
}

type cloner struct {
	jobs chan cloneJob
	dirs []cloneJob
	// links is where the first name of a hard-linked file went, by device
	// and inode; only the walk touches it.
	links map[[2]uint64]string

	mu  sync.Mutex
	err error
}

func (c *cloner) fail(err error) {
	if err == nil {
		return
	}
	c.mu.Lock()
	if c.err == nil {
		c.err = err
	}
	c.mu.Unlock()
}

func (c *cloner) failed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err != nil
}

func (c *cloner) walk(src, dst string) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if c.failed() {
			return nil
		}
		s, d := filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())
		var st unix.Stat_t
		if err := unix.Lstat(s, &st); err != nil {
			return fmt.Errorf("buildstate: clone: %w", err)
		}
		switch st.Mode & unix.S_IFMT {
		case unix.S_IFDIR:
			if err := unix.Mkdir(d, 0o700); err != nil {
				return fmt.Errorf("buildstate: clone %s: %w", d, err)
			}
			if err := c.walk(s, d); err != nil {
				return err
			}
			if err := setMeta(s, d, &st); err != nil {
				return err
			}
			c.dirs = append(c.dirs, cloneJob{src: s, dst: d, st: st})
		case unix.S_IFREG:
			if st.Nlink > 1 {
				// Hard links stay hard links: the first name is cloned here,
				// in the walk, so the next ones find it made.
				key := [2]uint64{uint64(st.Dev), st.Ino}
				if first, ok := c.links[key]; ok {
					if err := unix.Link(first, d); err != nil {
						return fmt.Errorf("buildstate: clone %s: %w", d, err)
					}
					continue
				}
				c.links[key] = d
				if err := cloneRegular(s, d, &st); err != nil {
					return err
				}
				continue
			}
			c.jobs <- cloneJob{src: s, dst: d, st: st}
		case unix.S_IFLNK:
			to, err := os.Readlink(s)
			if err != nil {
				return fmt.Errorf("buildstate: clone: %w", err)
			}
			if err := os.Symlink(to, d); err != nil {
				return fmt.Errorf("buildstate: clone: %w", err)
			}
			if err := setMeta(s, d, &st); err != nil {
				return err
			}
			if err := setTimes(d, &st); err != nil {
				return err
			}
		case unix.S_IFCHR, unix.S_IFBLK, unix.S_IFIFO:
			// A snapshot's whiteouts are 0:0 character devices.
			if err := unix.Mknod(d, st.Mode, int(st.Rdev)); err != nil { //nolint:gosec // G115: Linux dev_t packs 32-bit major/minor, fits int on the 64-bit hosts the cell runs on
				return fmt.Errorf("buildstate: clone %s: %w", d, err)
			}
			if err := setMeta(s, d, &st); err != nil {
				return err
			}
			if err := setTimes(d, &st); err != nil {
				return err
			}
		default:
			// A socket is its process's, gone with it.
		}
	}
	return nil
}

func cloneRegular(src, dst string, st *unix.Stat_t) error {
	if err := cloneFile(src, dst, st); err != nil {
		return err
	}
	if err := setMeta(src, dst, st); err != nil {
		return err
	}
	return setTimes(dst, st)
}

// cloneFile makes dst a reflink of the regular file src.
func cloneFile(src, dst string, st *unix.Stat_t) (err error) {
	in, err := unix.Open(src, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("buildstate: clone %s: %w", src, err)
	}
	defer func() { _ = unix.Close(in) }()
	out, err := unix.Open(dst, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return fmt.Errorf("buildstate: clone %s: %w", dst, err)
	}
	defer func() {
		if cerr := unix.Close(out); cerr != nil && err == nil {
			err = fmt.Errorf("buildstate: clone %s: close: %w", dst, cerr)
		}
	}()
	if st.Size > 0 {
		if err := unix.IoctlFileClone(out, in); err != nil {
			return fmt.Errorf("buildstate: reflink %s: %w", dst, err)
		}
	}
	return nil
}

// setMeta gives dst the owner, the extended attributes and the mode of
// src, in that order: a chown drops setuid bits and file capabilities.
func setMeta(src, dst string, st *unix.Stat_t) error {
	if err := unix.Lchown(dst, int(st.Uid), int(st.Gid)); err != nil {
		return fmt.Errorf("buildstate: clone %s: owner: %w", dst, err)
	}
	if err := copyXattrs(src, dst); err != nil {
		return fmt.Errorf("buildstate: clone %s: xattr: %w", dst, err)
	}
	if st.Mode&unix.S_IFMT == unix.S_IFLNK {
		return nil // a symlink has no mode of its own
	}
	if err := unix.Fchmodat(unix.AT_FDCWD, dst, st.Mode&0o7777, 0); err != nil {
		return fmt.Errorf("buildstate: clone %s: mode: %w", dst, err)
	}
	return nil
}

func setTimes(dst string, st *unix.Stat_t) error {
	ts := []unix.Timespec{st.Atim, st.Mtim}
	if err := unix.UtimesNanoAt(unix.AT_FDCWD, dst, ts, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return fmt.Errorf("buildstate: clone %s: times: %w", dst, err)
	}
	return nil
}

// copyXattrs copies every extended attribute of src (never following a
// symlink). A filesystem with none, or a namespace this process may not
// write, is skipped: what BuildKit reads (trusted.overlay.*, user.*,
// security.capability) is written by root on the filesystems it uses.
func copyXattrs(src, dst string) error {
	size, err := unix.Llistxattr(src, nil)
	if err != nil || size == 0 {
		if err == nil || errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EPERM) {
			return nil
		}
		return err
	}
	names := make([]byte, size)
	if size, err = unix.Llistxattr(src, names); err != nil {
		return err
	}
	for _, name := range splitNames(names[:size]) {
		n, err := unix.Lgetxattr(src, name, nil)
		if err != nil {
			if errors.Is(err, unix.ENODATA) {
				continue
			}
			return err
		}
		val := make([]byte, n)
		if n > 0 {
			if n, err = unix.Lgetxattr(src, name, val); err != nil {
				return err
			}
		}
		if err := unix.Lsetxattr(dst, name, val[:n], 0); err != nil && !errors.Is(err, unix.ENOTSUP) && !errors.Is(err, unix.EPERM) {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}

func splitNames(b []byte) []string {
	var out []string
	start := 0
	for i, c := range b {
		if c == 0 {
			if i > start {
				out = append(out, string(b[start:i]))
			}
			start = i + 1
		}
	}
	return out
}
