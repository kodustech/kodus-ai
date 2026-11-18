//go:build linux

package coverage

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// tmpfsMagic is statfs(2)'s f_type of a tmpfs (linux/magic.h).
const tmpfsMagic = 0x01021994

// Tmpfs caps a coverage directory with a tmpfs mounted over it
// (https://docs.kernel.org/filesystems/tmpfs.html: size is "the limit of
// allocated bytes", nr_inodes "the maximum number of inodes"; shmem fails
// the write with ENOSPC past either). mount(2) needs CAP_SYS_ADMIN: the
// cell runs as root, as its build state overlays already need
// (dockergvisor/buildstate). The mount must be in the mount namespace
// Docker resolves bind sources in, or the services would write the
// directory under it: Cap refuses unless the cell shares the init
// process's namespace (a unit with PrivateMounts= or PrivateTmp= runs in
// its own, and its mounts never propagate back,
// https://man7.org/linux/man-pages/man7/mount_namespaces.7.html).
type Tmpfs struct{}

func (Tmpfs) Cap(dir string) error {
	if ok, err := tmpfsCapped(dir); err != nil || ok {
		return err
	}
	self, err := os.Readlink("/proc/self/ns/mnt")
	if err != nil {
		return fmt.Errorf("coverage: own mount namespace: %w", err)
	}
	if initNS, err := os.Readlink("/proc/1/ns/mnt"); err != nil || initNS != self {
		return fmt.Errorf("coverage: the cell is not in the host's mount namespace (%s, init %s): Docker would not see the cap: %v", self, initNS, err)
	}
	opts := "size=" + strconv.Itoa(DirBytes) + ",nr_inodes=" + strconv.Itoa(DirFiles) + ",mode=1777"
	if err := syscall.Mount("kodus-coverage", dir, "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, opts); err != nil {
		return fmt.Errorf("coverage: mount: %w", err)
	}
	if ok, err := tmpfsCapped(dir); err != nil || !ok {
		_ = syscall.Unmount(dir, syscall.MNT_DETACH)
		return errors.Join(errors.New("coverage: the mount is not the cap"), err)
	}
	return nil
}

// tmpfsCapped: dir is a tmpfs of at most DirBytes and DirFiles.
func tmpfsCapped(dir string) (bool, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return false, fmt.Errorf("coverage: statfs: %w", err)
	}
	if int64(st.Type) != tmpfsMagic { //nolint:gosec,unconvert // G115: f_type is a magic number; its width differs by arch
		return false, nil
	}
	bytes := uint64(st.Blocks) * uint64(st.Bsize) //nolint:gosec // G115: statfs counts and block size are non-negative
	return bytes > 0 && bytes <= DirBytes && st.Files > 0 && st.Files <= DirFiles, nil
}

func (Tmpfs) Release(dir string) error {
	mounted, err := tmpfsMountsUnder(filepath.Dir(dir))
	if err != nil {
		return err
	}
	for _, m := range mounted {
		if m == filepath.Clean(dir) {
			if err := syscall.Unmount(m, syscall.MNT_DETACH); err != nil {
				return fmt.Errorf("coverage: unmount: %w", err)
			}
		}
	}
	return nil
}

// Recover unmounts the coverage caps a cell that stopped without its
// releases left under claims (the agent's <workdir>/claims): their claims
// are gone with that cell. It returns how many.
func (Tmpfs) Recover(claims string) (int, error) {
	mounted, err := tmpfsMountsUnder(claims)
	if err != nil {
		return 0, err
	}
	n := 0
	var errs []error
	for _, m := range mounted {
		rel, err := filepath.Rel(claims, m)
		if err != nil || filepath.Base(rel) != DirName || filepath.Dir(rel) == "." || strings.Contains(filepath.Dir(rel), string(filepath.Separator)) {
			continue // only <claims>/<claim>/coverage
		}
		if err := syscall.Unmount(m, syscall.MNT_DETACH); err != nil {
			errs = append(errs, fmt.Errorf("coverage: unmount %s: %w", m, err))
			continue
		}
		n++
	}
	return n, errors.Join(errs...)
}

// tmpfsMountsUnder lists the tmpfs mount points strictly under root, from
// /proc/self/mountinfo (proc(5): field 5 is the mount point, the type
// follows the " - " separator; spaces and the like are octal escapes).
func tmpfsMountsUnder(root string) ([]string, error) {
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return nil, fmt.Errorf("coverage: mountinfo: %w", err)
	}
	defer func() { _ = f.Close() }()
	root = filepath.Clean(root)
	var out []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		pre, post, ok := strings.Cut(sc.Text(), " - ")
		fields, tail := strings.Fields(pre), strings.Fields(post)
		if !ok || len(fields) < 5 || len(tail) < 1 || tail[0] != "tmpfs" {
			continue
		}
		p := unescapeMountinfo(fields[4])
		if strings.HasPrefix(p, root+string(filepath.Separator)) {
			out = append(out, p)
		}
	}
	return out, sc.Err()
}

// unescapeMountinfo undoes the kernel's \ooo escapes.
func unescapeMountinfo(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
