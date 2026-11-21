//go:build linux

package buildstate

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

// reflinkDir is a directory on a filesystem that reflinks, for the tests
// that need one (KODUS_TEST_REFLINK_DIR: an XFS or btrfs mount); they are
// skipped elsewhere.
func reflinkDir(t *testing.T) string {
	t.Helper()
	root := os.Getenv("KODUS_TEST_REFLINK_DIR")
	if root == "" {
		root = t.TempDir()
	}
	if !reflinks(root) {
		t.Skipf("%s does not reflink (set KODUS_TEST_REFLINK_DIR to an XFS or btrfs directory)", root)
	}
	dir, err := os.MkdirTemp(root, "clone-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func mustStat(t *testing.T, p string) unix.Stat_t {
	t.Helper()
	var st unix.Stat_t
	if err := unix.Lstat(p, &st); err != nil {
		t.Fatal(err)
	}
	return st
}

func TestMounterForIsTheOverlayWhereTheFilesystemDoesNotReflink(t *testing.T) {
	// tmpfs never reflinks.
	if _, err := os.Stat("/dev/shm"); err != nil {
		t.Skip("no /dev/shm")
	}
	m, view := MounterFor("/dev/shm/kodus-not-made-yet/buildkit")
	if _, ok := m.(overlayMounter); !ok || view != "overlay" {
		t.Fatalf("mounter %T (%s), want the overlay", m, view)
	}
}

func TestCloneTreeIsTheStateAsItIsAndSharesNothingTheBuildWrites(t *testing.T) {
	dir := reflinkDir(t)
	root := os.Geteuid() == 0
	src, dst := filepath.Join(dir, "env"), filepath.Join(dir, "merged")
	for _, p := range []string{filepath.Join(src, "snapshots", "1", "fs", "app", "node_modules", ".bin"), filepath.Join(src, "snapshots", "2", "fs", "app"), dst} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	big := bytes.Repeat([]byte("layer bytes "), 20_000)
	write := func(rel string, body []byte, mode os.FileMode) string {
		p := filepath.Join(src, rel)
		if err := os.WriteFile(p, body, mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, mode); err != nil {
			t.Fatal(err)
		}
		return p
	}
	pkg := write("snapshots/1/fs/app/package.json", []byte(`{"name":"base"}`), 0o644)
	write("snapshots/1/fs/app/node_modules/dep.js", big, 0o644)
	write("snapshots/1/fs/app/empty", nil, 0o600)
	tool := write("snapshots/1/fs/app/tool", []byte("#!/bin/sh\n"), 0o4755)
	write("cache.db", []byte("bolt"), 0o600)
	if err := os.Symlink("../dep.js", filepath.Join(src, "snapshots", "1", "fs", "app", "node_modules", ".bin", "dep")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(tool, filepath.Join(src, "snapshots", "1", "fs", "app", "tool-link")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(src, "snapshots", "1", "fs", "app", "pipe"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := unix.Lsetxattr(pkg, "user.kodus.test", []byte("kept"), 0); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(src, "snapshots", "2", "fs"), 0o500); err != nil {
		t.Fatal(err)
	}
	whiteout := filepath.Join(src, "snapshots", "2", "fs", "app", "package.json")
	if root {
		// What an upper layer of BuildKit's own overlays holds: a whiteout, an opaque directory, another owner.
		if err := unix.Mknod(whiteout, unix.S_IFCHR, 0); err != nil {
			t.Fatal(err)
		}
		if err := unix.Lsetxattr(filepath.Join(src, "snapshots", "2", "fs", "app"), "trusted.overlay.opaque", []byte("y"), 0); err != nil {
			t.Fatal(err)
		}
		if err := unix.Lchown(pkg, 1000, 1001); err != nil {
			t.Fatal(err)
		}
	}
	old := unix.NsecToTimespec(1_600_000_000 * 1e9)
	for _, p := range []string{pkg, filepath.Join(src, "snapshots", "1", "fs", "app")} {
		if err := unix.UtimesNanoAt(unix.AT_FDCWD, p, []unix.Timespec{old, old}, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			t.Fatal(err)
		}
	}

	if err := cloneTree(src, dst, 4); err != nil {
		t.Fatal(err)
	}

	same := func(rel string) {
		t.Helper()
		a, b := mustStat(t, filepath.Join(src, rel)), mustStat(t, filepath.Join(dst, rel))
		if a.Mode != b.Mode || a.Uid != b.Uid || a.Gid != b.Gid || a.Rdev != b.Rdev || a.Size != b.Size && a.Mode&unix.S_IFMT != unix.S_IFDIR {
			t.Errorf("%s: mode %o/%o owner %d:%d/%d:%d rdev %d/%d size %d/%d", rel, a.Mode, b.Mode, a.Uid, a.Gid, b.Uid, b.Gid, a.Rdev, b.Rdev, a.Size, b.Size)
		}
		if a.Mtim != b.Mtim {
			t.Errorf("%s: mtime %v, want %v", rel, b.Mtim, a.Mtim)
		}
	}
	for _, rel := range []string{
		"cache.db", "snapshots/1/fs/app", "snapshots/1/fs/app/package.json", "snapshots/1/fs/app/node_modules/dep.js", "snapshots/1/fs/app/empty",
		"snapshots/1/fs/app/tool", "snapshots/1/fs/app/tool-link", "snapshots/1/fs/app/node_modules/.bin/dep", "snapshots/1/fs/app/pipe", "snapshots/2/fs",
	} {
		same(rel)
	}
	if got, _ := os.ReadFile(filepath.Join(dst, "snapshots", "1", "fs", "app", "node_modules", "dep.js")); !bytes.Equal(got, big) {
		t.Error("dep.js: the clone's bytes differ")
	}
	if to, _ := os.Readlink(filepath.Join(dst, "snapshots", "1", "fs", "app", "node_modules", ".bin", "dep")); to != "../dep.js" {
		t.Errorf("symlink to %q", to)
	}
	a, b := mustStat(t, filepath.Join(dst, "snapshots", "1", "fs", "app", "tool")), mustStat(t, filepath.Join(dst, "snapshots", "1", "fs", "app", "tool-link"))
	if a.Ino != b.Ino || a.Nlink != 2 {
		t.Errorf("hard link: inodes %d and %d, %d links", a.Ino, b.Ino, a.Nlink)
	}
	if a.Ino == mustStat(t, tool).Ino {
		t.Error("the clone's file is the state's inode: a write would reach the environment")
	}
	val := make([]byte, 16)
	if n, err := unix.Lgetxattr(filepath.Join(dst, "snapshots", "1", "fs", "app", "package.json"), "user.kodus.test", val); err != nil || string(val[:n]) != "kept" {
		t.Errorf("xattr %q, %v", val, err)
	}
	if root {
		same("snapshots/2/fs/app/package.json")
		if n, err := unix.Lgetxattr(filepath.Join(dst, "snapshots", "2", "fs", "app"), "trusted.overlay.opaque", val); err != nil || string(val[:n]) != "y" {
			t.Errorf("opaque mark %q, %v", val, err)
		}
		// What the overlay refused: a new whiteout in the build's view of the state.
		if err := unix.Mknod(filepath.Join(dst, "snapshots", "1", "fs", "app", "removed"), unix.S_IFCHR, 0); err != nil {
			t.Errorf("a whiteout in the clone: %v", err)
		}
	}

	// The build writes its clone; the environment's state is as it was. And the other way.
	if err := os.WriteFile(filepath.Join(dst, "snapshots", "1", "fs", "app", "node_modules", "dep.js"), []byte("pull request"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dst, "cache.db"), []byte("pr db"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(src, "snapshots", "1", "fs", "app", "node_modules", "dep.js")); !bytes.Equal(got, big) {
		t.Error("the build's write reached the environment's state")
	}
	if got, _ := os.ReadFile(filepath.Join(src, "cache.db")); string(got) != "bolt" {
		t.Error("the build's write reached the environment's cache.db")
	}
	if err := os.WriteFile(filepath.Join(src, "snapshots", "1", "fs", "app", "empty"), []byte("a later seed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(dst, "snapshots", "1", "fs", "app", "empty")); len(got) != 0 {
		t.Error("a later seed's write reached the clone")
	}
}

func TestCloneMounterUnmountOfACloneIsNothing(t *testing.T) {
	// umount(2) answers EPERM before it looks at the path without CAP_SYS_ADMIN;
	// the cell that clones build states runs as root.
	if os.Geteuid() != 0 {
		t.Skip("unmount needs CAP_SYS_ADMIN; run as root")
	}
	dir := t.TempDir()
	if err := (cloneMounter{}).Unmount(dir); err != nil {
		t.Fatalf("unmount of a plain directory: %v", err)
	}
	if err := (cloneMounter{}).Unmount(filepath.Join(dir, "gone")); err != nil {
		t.Fatalf("unmount of a missing directory: %v", err)
	}
}

func TestCloneTreeFailsWhereTheFilesystemDoesNotReflink(t *testing.T) {
	if _, err := os.Stat("/dev/shm"); err != nil {
		t.Skip("no /dev/shm")
	}
	dir, err := os.MkdirTemp("/dev/shm", "clone-test-")
	if err != nil {
		t.Skip(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	src, dst := filepath.Join(dir, "env"), filepath.Join(dir, "merged")
	for _, p := range []string{src, dst} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(src, "f"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cloneTree(src, dst, 2); err == nil {
		t.Fatal("a clone without reflinks must fail, so the build keeps its own state")
	}
}
