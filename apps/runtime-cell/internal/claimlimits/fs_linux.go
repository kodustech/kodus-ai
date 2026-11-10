//go:build linux

package claimlimits

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

const cgroupMount = "/sys/fs/cgroup"
const maxControlBytes = 64 << 10

type localDirectory struct{ file *os.File }

// New opens an existing dedicated root below /sys/fs/cgroup. Ancestors and
// files are opened with O_NOFOLLOW; ordinary directories and root cgroup are
// refused. An exclusive nonblocking directory flock is held until Close so
// a second cell cannot prune or configure parents under the same delegation.
// It changes no ancestor or Docker daemon configuration.
func New(root string) (*FS, error) {
	if root == cgroupMount || !strings.HasPrefix(root, cgroupMount+"/") || filepath.Clean(root) != root {
		return nil, fmt.Errorf("%w: dedicated root below /sys/fs/cgroup required", ErrUnavailable)
	}
	parent := strings.TrimPrefix(root, cgroupMount)
	if err := ValidateParent(parent); err != nil {
		return nil, err
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("%w: open mount: %w", ErrUnavailable, err)
	}
	for _, part := range strings.Split(strings.TrimPrefix(root, "/"), "/") {
		next, e := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		unix.Close(fd)
		if e != nil {
			return nil, fmt.Errorf("%w: open dedicated root: %w", ErrUnavailable, e)
		}
		fd = next
	}
	d := &localDirectory{os.NewFile(uintptr(fd), "claimlimits-root")}
	closeOnError := true
	defer func() {
		if closeOnError {
			d.Close()
		}
	}()
	var stat unix.Statfs_t
	if err = unix.Fstatfs(fd, &stat); err != nil || uint64(stat.Type) != uint64(unix.CGROUP2_SUPER_MAGIC) {
		return nil, fmt.Errorf("%w: cgroup v2 filesystem required", ErrUnavailable)
	}
	var owner unix.Stat_t
	if err = unix.Fstat(fd, &owner); err != nil {
		return nil, fmt.Errorf("%w: stat root: %w", ErrUnavailable, err)
	}
	if owner.Mode&0022 != 0 || (owner.Uid != 0 && owner.Uid != uint32(os.Geteuid())) {
		return nil, fmt.Errorf("%w: dedicated root must not be writable by other users", ErrUnavailable)
	}
	if err = lockRoot(d); err != nil {
		return nil, err
	}
	f, err := newFS(d, parent)
	if err != nil {
		return nil, err
	}
	closeOnError = false
	return f, nil
}
func (d *localDirectory) openFile(name string, flags int) (*os.File, error) {
	fd, err := unix.Openat(int(d.file.Fd()), name, flags|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), name), nil
}
func (d *localDirectory) Read(name string) (string, error) {
	file, err := d.openFile(name, unix.O_RDONLY)
	if err != nil {
		return "", err
	}
	defer file.Close()
	value, err := io.ReadAll(io.LimitReader(file, maxControlBytes+1))
	if err != nil {
		return "", err
	}
	if len(value) > maxControlBytes {
		return "", errors.New("claimlimits: oversized control file")
	}
	return string(value), nil
}
func (d *localDirectory) Write(name, value string) error {
	file, err := d.openFile(name, unix.O_WRONLY)
	if err != nil {
		return err
	}
	_, err = file.WriteString(value)
	return errors.Join(err, file.Close())
}
func (d *localDirectory) Mkdir(name string) error { return unix.Mkdirat(int(d.file.Fd()), name, 0700) }
func (d *localDirectory) Open(name string) (directory, error) {
	file, err := d.openFile(name, unix.O_RDONLY|unix.O_DIRECTORY)
	if err != nil {
		return nil, err
	}
	return &localDirectory{file}, nil
}
func (d *localDirectory) Remove(name string) error {
	return unix.Unlinkat(int(d.file.Fd()), name, unix.AT_REMOVEDIR)
}
func (d *localDirectory) Close() error { return d.file.Close() }
func readProcessCgroup(pid int) (string, error) {
	file, err := os.Open("/proc/" + strconv.Itoa(pid) + "/cgroup")
	if err != nil {
		return "", err
	}
	defer file.Close()
	value, err := io.ReadAll(io.LimitReader(file, maxControlBytes+1))
	if err != nil {
		return "", err
	}
	if len(value) > maxControlBytes {
		return "", errors.New("claimlimits: oversized process membership")
	}
	return string(value), nil
}

func (d *localDirectory) List() ([]string, error) {
	file, err := d.openFile(".", unix.O_RDONLY|unix.O_DIRECTORY)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	entries, err := file.ReadDir(maxDirectoryEntries + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if len(entries) > maxDirectoryEntries {
		return nil, errors.New("claimlimits: too many parent entries")
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		out = append(out, entry.Name())
	}
	return out, nil
}

// lockRoot locks the directory inode without a lockfile (cgroupfs cannot hold
// ordinary files). The fd is O_CLOEXEC: helpers cannot inherit ownership. Any
// error, including filesystems without flock support, refuses enforcement.
func lockRoot(d *localDirectory) error {
	if err := unix.Flock(int(d.file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return fmt.Errorf("%w: delegated root cannot be exclusively locked: %w", ErrUnavailable, err)
	}
	return nil
}
