package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// The builder (rootless BuildKit, user 1000 in its image) writes host
// directories through bind mounts: an environment's BuildKit state and a
// build's overlay of it (state.go), a setup build's exported cache
// (cache.go), and the image tarball it leaves for the cell to load. A host
// user who could write any of them would put layers into a later build or
// swap the image the cell loads (cache poisoning), so they are never
// world-writable. Two layers keep everyone but the cell and the builder out:
//
//  1. The roots they live under (cache, buildkit and builds in WorkDir) are
//     the cell's own real directories, mode 0700: no other host user
//     reaches anything below them. That includes the host's uid 1000, often
//     its first login user, which owns the builder's directories (2). New
//     refuses a root someone else owns or that is a symlink, which is what
//     pre-creating it in a shared WorkDir (os.TempDir) would leave.
//  2. Each directory the builder writes is the builder's, mode 0700: inside
//     the roots, only the builder and root can touch it.
//
// Who the builder is on the host: runsc checks file access itself, against
// the owner and mode the host reports, and maps ids only through the user
// namespace in the container's OCI spec. Docker writes one there only when
// the daemon remaps users (userns-remap, or a rootless daemon); without it,
// uid 1000 in the sandbox is uid 1000 on the host. With it, the host id is
// an offset Docker does not report (the daemon's subordinate ranges), so
// the cell is told it (Config.BuilderUID, BuilderGID) or refuses to build.
type hostDirs struct {
	// uid and gid are the builder's on the host; self is the cell's uid.
	uid, gid, self int
	chown          func(path string, uid, gid int) error
	// owner is the uid that owns a file; false where the system says none.
	owner func(fs.FileInfo) (int, bool)
}

// builderUser is the user of the rootless BuildKit image (moby/buildkit:*-rootless).
const builderUser = 1000

// ErrBuilderIDsUnknown: Docker remaps user namespaces, and the cell was not
// told who the builder is on the host.
var ErrBuilderIDsUnknown = errors.New("dockergvisor: Docker remaps user namespaces (userns-remap or rootless): set the builder's host uid and gid (-gvisor-builder-uid, -gvisor-builder-gid)")

// usernsRemapped reports whether Docker gives containers a user namespace
// of their own (docker info's security options name userns or rootless).
func usernsRemapped(opts []string) bool {
	for _, o := range opts {
		for _, kv := range strings.Split(o, ",") {
			if kv == "name=userns" || kv == "name=rootless" {
				return true
			}
		}
	}
	return false
}

// builderIDs are the builder's host uid and gid: what the cell was told,
// or the image's user when Docker maps no user namespace.
func builderIDs(ctx context.Context, d Docker, cfg Config) (uid, gid int, err error) {
	if cfg.BuilderUID < 0 || cfg.BuilderGID < 0 {
		return 0, 0, fmt.Errorf("dockergvisor: builder uid %d gid %d", cfg.BuilderUID, cfg.BuilderGID)
	}
	if cfg.BuilderUID != 0 || cfg.BuilderGID != 0 {
		if cfg.BuilderUID == 0 || cfg.BuilderGID == 0 {
			return 0, 0, errors.New("dockergvisor: set both the builder's uid and gid, neither root")
		}
		return cfg.BuilderUID, cfg.BuilderGID, nil
	}
	opts, err := d.SecurityOptions(ctx)
	if err != nil {
		return 0, 0, err
	}
	if usernsRemapped(opts) {
		return 0, 0, ErrBuilderIDsUnknown
	}
	return builderUser, builderUser, nil
}

// builderDir makes p a directory only the builder (and root) can use. Its
// parent is one of the cell's private directories; p itself is never a
// link, which MkdirAll and Chmod would follow.
func (h hostDirs) builderDir(p string) error {
	if err := os.MkdirAll(p, 0o700); err != nil {
		return err
	}
	if err := h.realDir(p); err != nil {
		return err
	}
	if err := h.chown(p, h.uid, h.gid); err != nil {
		return err
	}
	return os.Chmod(p, 0o700)
}

// privateRoot makes p one of the cell's private directories (1).
func (h hostDirs) privateRoot(p string) error {
	if err := os.MkdirAll(p, 0o700); err != nil {
		return err
	}
	if err := h.realDir(p); err != nil {
		return err
	}
	info, err := os.Lstat(p)
	if err != nil {
		return err
	}
	if uid, ok := h.owner(info); ok && uid != h.self {
		return fmt.Errorf("dockergvisor: %s is owned by uid %d, not the cell's (%d)", p, uid, h.self)
	}
	return os.Chmod(p, 0o700)
}

func (h hostDirs) realDir(p string) error {
	info, err := os.Lstat(p)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("dockergvisor: %s is not a directory of the cell's", p)
	}
	return nil
}

// builderRoots are the private roots under the driver's work directory.
func builderRoots(workDir string) []string {
	return []string{filepath.Join(workDir, "cache"), filepath.Join(workDir, "buildkit"), filepath.Join(workDir, "builds")}
}
