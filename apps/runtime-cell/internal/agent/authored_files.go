package agent

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// authoredFilesDir is where every authored file lives (protocol.AuthoredFilePath).
const authoredFilesDir = ".kodus"

// authoredFileError is why one authored file could not be written. The
// message names the path (checked against protocol.AuthoredFilePath) and a
// fixed reason, never repository text: the product's card reads it.
type authoredFileError struct {
	path   string
	reason string
}

func (e *authoredFileError) Error() string { return "authored file " + e.path + ": " + e.reason }

// writeAuthoredFiles writes the build files Kody wrote with an authored
// recipe into the checkout, under .kodus/, before the boot reads them. No
// recipe or no files: nothing to write.
//
// The checkout of a Run is the PR's, and a PR may plant .kodus as a link
// (to /etc, or to another directory of the repository) or put a file where
// Kody's goes. So nothing is ever followed or replaced: the rules are
// checked again here (protocol.CheckAuthoredFiles), every open is relative
// to a directory opened with O_NOFOLLOW, .kodus must be a real directory
// this cell owns (it is created when absent), and each file is created with
// O_CREAT|O_EXCL, which never follows a link at the last component either.
// A file already there fails the claim, unless it is a regular file with
// exactly the same bytes (the recipe PR Kodus opens adds those very files):
// nothing would change, so nothing is written.
func writeAuthoredFiles(repo string, r *protocol.ClaimAcquireBodyRecipe) error {
	if r == nil || len(r.Files) == 0 {
		return nil
	}
	if err := protocol.CheckAuthoredFiles(r.Files); err != nil {
		return err
	}
	root, err := unix.Open(repo, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open the checkout: %w", err)
	}
	defer unix.Close(root)
	dir, err := openAuthoredDir(root, true)
	if err != nil {
		return err
	}
	defer unix.Close(dir)
	for _, f := range r.Files {
		if err := writeAuthoredFile(dir, f); err != nil {
			return err
		}
	}
	return nil
}

// errNoAuthoredDir: the checkout has no .kodus and none was to be created.
var errNoAuthoredDir = errors.New("the checkout has no " + authoredFilesDir)

// openAuthoredDir opens .kodus of the checkout without following it,
// creating it when absent if create is set (errNoAuthoredDir otherwise), and
// refuses anything but a directory this cell owns.
func openAuthoredDir(root int, create bool) (int, error) {
	const flags = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	fd, err := unix.Openat(root, authoredFilesDir, flags, 0)
	if errors.Is(err, unix.ENOENT) && !create {
		return -1, errNoAuthoredDir
	}
	if errors.Is(err, unix.ENOENT) {
		if err := unix.Mkdirat(root, authoredFilesDir, 0o755); err != nil && !errors.Is(err, unix.EEXIST) {
			return -1, fmt.Errorf("create %s: %w", authoredFilesDir, err)
		}
		fd, err = unix.Openat(root, authoredFilesDir, flags, 0)
	}
	if err != nil {
		return -1, &authoredFileError{path: authoredFilesDir, reason: notADirectory(root, err)}
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		unix.Close(fd)
		return -1, fmt.Errorf("stat %s: %w", authoredFilesDir, err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR || int(st.Uid) != os.Geteuid() {
		unix.Close(fd)
		return -1, &authoredFileError{path: authoredFilesDir, reason: "is not a directory of this cell; Kody's build files are written only into one"}
	}
	return fd, nil
}

// notADirectory words why .kodus could not be opened as a directory.
func notADirectory(root int, openErr error) string {
	var st unix.Stat_t
	if err := unix.Fstatat(root, authoredFilesDir, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return "cannot be opened (" + openErr.Error() + ")"
	}
	if st.Mode&unix.S_IFMT == unix.S_IFLNK {
		return "is a symbolic link in the checkout; Kody's build files are never written through a link"
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return "is not a directory in the checkout; Kody's build files go only into a .kodus directory"
	}
	return "cannot be opened (" + openErr.Error() + ")"
}

// writeAuthoredFile creates one file in .kodus, exclusively.
func writeAuthoredFile(dir int, f protocol.AuthoredFile) error {
	name := strings.TrimPrefix(f.Path, authoredFilesDir+"/")
	fd, err := unix.Openat(dir, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o644)
	if errors.Is(err, unix.EEXIST) {
		return sameFile(dir, name, f)
	}
	if err != nil {
		return fmt.Errorf("create %s: %w", f.Path, err)
	}
	file := os.NewFile(uintptr(fd), f.Path)
	defer file.Close()
	if _, err := io.WriteString(file, f.Content); err != nil {
		return fmt.Errorf("write %s: %w", f.Path, err)
	}
	return file.Close()
}

// sameFile accepts a file the checkout already has only when it is a
// regular file (opened without following a link, without blocking on a
// FIFO) with exactly the authored bytes.
func sameFile(dir int, name string, f protocol.AuthoredFile) error {
	exists := &authoredFileError{path: f.Path, reason: "is already in the checkout with other content; Kody never replaces a repository file"}
	fd, err := unix.Openat(dir, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return &authoredFileError{path: f.Path, reason: "is already in the checkout and is not a regular file; Kody never replaces or follows it"}
	}
	file := os.NewFile(uintptr(fd), f.Path)
	defer file.Close()
	st, err := file.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return &authoredFileError{path: f.Path, reason: "is already in the checkout and is not a regular file; Kody never replaces or follows it"}
	}
	if st.Size() != int64(len(f.Content)) {
		return exists
	}
	got, err := io.ReadAll(io.LimitReader(file, protocol.MaxAuthoredFileBytes+1))
	if err != nil || !bytes.Equal(got, []byte(f.Content)) {
		return exists
	}
	return nil
}
