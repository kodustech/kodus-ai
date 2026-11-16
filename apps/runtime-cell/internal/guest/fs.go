//go:build unix

// Package guest is the guest agent: the one process inside a sandbox machine
// (a tool container under gVisor, or a microVM) that runs its commands and
// touches its files on the cell's behalf. The cell speaks to it over a byte
// stream (docker exec's stdio, a unix socket, or vsock in a microVM)
// in the cell protocol's own frames (sandbox.op in, guest.result out), so
// the machine side is the same whatever carries the stream.
//
// Every bound and every no-follow rule lives here, inside the machine: a
// path is opened one segment at a time relative to the directory before it,
// with O_NOFOLLOW, so no symbolic link (one the repository commits, or one a
// command made a moment ago) can take a read, a write, a list or a remove
// outside the root.
package guest

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// opError is a refusal with the protocol's code.
type opError struct {
	code protocol.SandboxErrorCode
	msg  string
}

func (e *opError) Error() string { return e.msg }

func refuse(code protocol.SandboxErrorCode, format string, a ...any) error {
	return &opError{code, fmt.Sprintf(format, a...)}
}

// errnoError names a syscall failure on rel with the protocol's code.
func errnoError(rel string, err error) error {
	var oe *opError
	if errors.As(err, &oe) {
		return err
	}
	switch {
	case errors.Is(err, unix.ELOOP), errors.Is(err, unix.EMLINK):
		return refuse(protocol.SandboxErrorCodeSymlink, "%s is a symbolic link; it is never followed", rel)
	case errors.Is(err, unix.ENOENT):
		return refuse(protocol.SandboxErrorCodeNotFound, "%s does not exist", rel)
	case errors.Is(err, unix.ENOTDIR):
		return refuse(protocol.SandboxErrorCodeNotDirectory, "a parent of %s is not a directory", rel)
	case errors.Is(err, unix.EISDIR):
		return refuse(protocol.SandboxErrorCodeIsDirectory, "%s is a directory", rel)
	case errors.Is(err, unix.EACCES), errors.Is(err, unix.EPERM):
		return refuse(protocol.SandboxErrorCodeDenied, "%s: permission denied", rel)
	}
	return refuse(protocol.SandboxErrorCodeIo, "%s: %v", rel, err)
}

// segments splits a path the decoder already checked (plain segments). It
// checks again: the guest agent never relies on its caller.
func segments(rel string) ([]string, error) {
	if rel == "" {
		return nil, nil
	}
	if len(rel) > protocol.SandboxPathMax || strings.HasPrefix(rel, "/") || strings.ContainsAny(rel, "\\\x00") {
		return nil, refuse(protocol.SandboxErrorCodeInvalidPath, "path %q is not relative to the sandbox root", rel)
	}
	parts := strings.Split(rel, "/")
	for _, p := range parts {
		if p == "" || p == "." || p == ".." {
			return nil, refuse(protocol.SandboxErrorCodeInvalidPath, "path %q has an empty, . or .. segment", rel)
		}
	}
	return parts, nil
}

// FS is the root every file operation stays under, held open.
type FS struct {
	root int
	dir  string
	// path replaces BaseEnv's PATH when set (WithPath).
	path string
	// env is added to BaseEnv, before the caller's (WithEnv).
	env map[string]string
}

// WithEnv adds env to what every command starts with, before the caller's
// own: the trust variables of a sandbox the cell mounted its CA into
// (TrustEnv). It is the machine's own setting, never masked in the output.
func (f *FS) WithEnv(env map[string]string) *FS {
	f.env = env
	return f
}

// WithPath runs commands with this PATH instead of the tool image's: the
// fake driver's guest agent runs on the developer's host, whose tools live
// elsewhere.
func (f *FS) WithPath(path string) *FS {
	f.path = path
	return f
}

// OpenRoot opens dir as the root. The root itself is the machine's own
// (/workspace); only what is below it is untrusted.
func OpenRoot(dir string) (*FS, error) {
	fd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("guest: root %s: %w", dir, err)
	}
	return &FS{root: fd, dir: dir}, nil
}

func (f *FS) Close() error { return unix.Close(f.root) }

// Dir is the root's path inside the machine.
func (f *FS) Dir() string { return f.dir }

const dirFlags = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC

// openatDir is the open of one directory segment; a test swaps it for one
// that follows links, as gVisor's does.
var openatDir = func(dir int, name string) (int, error) { return unix.Openat(dir, name, dirFlags, 0) }

// openDirAt opens name below dir as a directory without following a link.
// O_NOFOLLOW alone is not enough: gVisor (runsc) follows a symbolic link to
// a directory on openat with O_DIRECTORY|O_NOFOLLOW, where Linux answers
// ENOTDIR. So what was opened is checked against the entry itself: name,
// not followed, must be a directory with the same device and inode. The
// check comes after the open, so a link swapped in or out between the two
// never passes. A mismatch is ELOOP, which the callers report as a link.
func openDirAt(dir int, name string) (int, error) {
	fd, err := openatDir(dir, name)
	if err != nil {
		return -1, err
	}
	var opened, entry unix.Stat_t
	if err := unix.Fstat(fd, &opened); err != nil {
		_ = unix.Close(fd)
		return -1, err
	}
	if err := unix.Fstatat(dir, name, &entry, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		_ = unix.Close(fd)
		return -1, err
	}
	if entry.Mode&unix.S_IFMT != unix.S_IFDIR || entry.Dev != opened.Dev || entry.Ino != opened.Ino {
		_ = unix.Close(fd)
		return -1, unix.ELOOP
	}
	return fd, nil
}

// walk opens the directory that holds the last segment, every segment on
// the way with O_NOFOLLOW. mkdirs makes the missing ones (0755). The caller
// closes the returned fd; it is a dup of the root for a one-segment path.
func (f *FS) walk(parts []string, mkdirs bool, rel string) (int, error) {
	fd, err := unix.Dup(f.root)
	if err != nil {
		return -1, errnoError(rel, err)
	}
	for _, p := range parts {
		next, err := openDirAt(fd, p)
		if errors.Is(err, unix.ENOENT) && mkdirs {
			if merr := unix.Mkdirat(fd, p, 0o755); merr != nil && !errors.Is(merr, unix.EEXIST) {
				_ = unix.Close(fd)
				return -1, errnoError(rel, merr)
			}
			next, err = openDirAt(fd, p)
		}
		if err != nil {
			// O_DIRECTORY|O_NOFOLLOW on a symlink is ELOOP on Linux and
			// ENOTDIR on some systems: say symlink when it is one.
			link := leafIsSymlink(fd, p)
			_ = unix.Close(fd)
			if link {
				return -1, refuse(protocol.SandboxErrorCodeSymlink, "%s: %s is a symbolic link; it is never followed", rel, p)
			}
			return -1, errnoError(rel, err)
		}
		_ = unix.Close(fd)
		fd = next
	}
	return fd, nil
}

// parentAndLeaf opens the directory holding rel's last segment.
func (f *FS) parentAndLeaf(rel string, mkdirs bool) (int, string, error) {
	parts, err := segments(rel)
	if err != nil {
		return -1, "", err
	}
	if len(parts) == 0 {
		return -1, "", refuse(protocol.SandboxErrorCodeInvalidPath, "the operation needs a path below the root")
	}
	dir, err := f.walk(parts[:len(parts)-1], mkdirs, rel)
	if err != nil {
		return -1, "", err
	}
	return dir, parts[len(parts)-1], nil
}

// leafIsSymlink tells a refused O_NOFOLLOW open of a symlink from other
// failures on systems that answer ENOTDIR or EMLINK instead of ELOOP.
func leafIsSymlink(dir int, leaf string) bool {
	var st unix.Stat_t
	return unix.Fstatat(dir, leaf, &st, unix.AT_SYMLINK_NOFOLLOW) == nil && st.Mode&unix.S_IFMT == unix.S_IFLNK
}

func openLeaf(dir int, leaf, rel string, flags int, mode uint32) (*os.File, error) {
	fd, err := unix.Openat(dir, leaf, flags|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, mode)
	if err != nil {
		if leafIsSymlink(dir, leaf) {
			return nil, refuse(protocol.SandboxErrorCodeSymlink, "%s is a symbolic link; it is never followed", rel)
		}
		return nil, errnoError(rel, err)
	}
	file := os.NewFile(uintptr(fd), rel)
	st, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, errnoError(rel, err)
	}
	if st.IsDir() {
		_ = file.Close()
		return nil, refuse(protocol.SandboxErrorCodeIsDirectory, "%s is a directory", rel)
	}
	if !st.Mode().IsRegular() {
		// A fifo or a device would block or read something that is not a file.
		_ = file.Close()
		return nil, refuse(protocol.SandboxErrorCodeNotRegular, "%s is not a regular file", rel)
	}
	return file, nil
}

// Read returns up to length bytes of rel from offset.
func (f *FS) Read(rel string, offset, length int64) (protocol.SandboxResult, error) {
	if length <= 0 || length > protocol.SandboxFileChunkBytes {
		return protocol.SandboxResult{}, refuse(protocol.SandboxErrorCodeTooLarge, "a read returns at most %d bytes", protocol.SandboxFileChunkBytes)
	}
	dir, leaf, err := f.parentAndLeaf(rel, false)
	if err != nil {
		return protocol.SandboxResult{}, err
	}
	defer func() { _ = unix.Close(dir) }()
	file, err := openLeaf(dir, leaf, rel, unix.O_RDONLY, 0)
	if err != nil {
		return protocol.SandboxResult{}, err
	}
	defer func() { _ = file.Close() }()
	st, err := file.Stat()
	if err != nil {
		return protocol.SandboxResult{}, errnoError(rel, err)
	}
	buf := make([]byte, length)
	n, err := file.ReadAt(buf, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return protocol.SandboxResult{}, errnoError(rel, err)
	}
	content := base64.StdEncoding.EncodeToString(buf[:n])
	size := st.Size()
	eof := offset+int64(n) >= size
	return protocol.SandboxResult{Ok: true, Content: &content, Size: &size, Eof: &eof}, nil
}

// Write puts content in rel (replacing it, or at its end with appendTo),
// making the parents with mkdirs. A symlink in its place is refused, never
// written through.
func (f *FS) Write(rel, content string, mode uint32, appendTo, mkdirs bool) (protocol.SandboxResult, error) {
	data, err := base64.StdEncoding.DecodeString(content)
	if err != nil {
		return protocol.SandboxResult{}, refuse(protocol.SandboxErrorCodeInvalidPath, "content is not base64")
	}
	if len(data) > protocol.SandboxFileChunkBytes {
		return protocol.SandboxResult{}, refuse(protocol.SandboxErrorCodeTooLarge, "a write takes at most %d bytes", protocol.SandboxFileChunkBytes)
	}
	dir, leaf, err := f.parentAndLeaf(rel, mkdirs)
	if err != nil {
		return protocol.SandboxResult{}, err
	}
	defer func() { _ = unix.Close(dir) }()
	flags := unix.O_WRONLY | unix.O_CREAT
	if appendTo {
		flags |= unix.O_APPEND
	}
	file, err := openLeaf(dir, leaf, rel, flags, mode)
	if err != nil {
		return protocol.SandboxResult{}, err
	}
	defer func() { _ = file.Close() }()
	// Truncated only once the open proved it is a regular file of the root.
	if !appendTo {
		if err := file.Truncate(0); err != nil {
			return protocol.SandboxResult{}, errnoError(rel, err)
		}
	}
	n, err := file.Write(data)
	if err != nil {
		return protocol.SandboxResult{}, errnoError(rel, err)
	}
	w := int64(n)
	return protocol.SandboxResult{Ok: true, Written: &w}, nil
}

func entryType(m uint32) protocol.SandboxEntryType {
	switch m & unix.S_IFMT {
	case unix.S_IFREG:
		return protocol.SandboxEntryTypeFile
	case unix.S_IFDIR:
		return protocol.SandboxEntryTypeDir
	case unix.S_IFLNK:
		return protocol.SandboxEntryTypeSymlink
	}
	return protocol.SandboxEntryTypeOther
}

// Stat describes rel (the root when empty) without following it.
func (f *FS) Stat(rel string) (protocol.SandboxResult, error) {
	var st unix.Stat_t
	if rel == "" {
		if err := unix.Fstat(f.root, &st); err != nil {
			return protocol.SandboxResult{}, errnoError(".", err)
		}
	} else {
		dir, leaf, err := f.parentAndLeaf(rel, false)
		if err != nil {
			return protocol.SandboxResult{}, err
		}
		defer func() { _ = unix.Close(dir) }()
		if err := unix.Fstatat(dir, leaf, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return protocol.SandboxResult{}, errnoError(rel, err)
		}
	}
	t := entryType(uint32(st.Mode))
	size := st.Size
	mode := int64(st.Mode & 0o7777)
	return protocol.SandboxResult{Ok: true, Type: &t, Size: &size, Mode: &mode}, nil
}

// Remove unlinks rel: a file or a symlink itself, never a directory.
func (f *FS) Remove(rel string) (protocol.SandboxResult, error) {
	dir, leaf, err := f.parentAndLeaf(rel, false)
	if err != nil {
		return protocol.SandboxResult{}, err
	}
	defer func() { _ = unix.Close(dir) }()
	var st unix.Stat_t
	if err := unix.Fstatat(dir, leaf, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return protocol.SandboxResult{}, errnoError(rel, err)
	}
	if st.Mode&unix.S_IFMT == unix.S_IFDIR {
		return protocol.SandboxResult{}, refuse(protocol.SandboxErrorCodeIsDirectory, "%s is a directory; remove takes files only", rel)
	}
	if err := unix.Unlinkat(dir, leaf, 0); err != nil {
		return protocol.SandboxResult{}, errnoError(rel, err)
	}
	return protocol.SandboxResult{Ok: true}, nil
}

// listBudget bounds what a list puts in its frame: the entries' paths in
// bytes, well under the frame limit with their JSON around them.
const listBudget = 640 * 1024

// List walks rel (the root when empty) to depth, depth first, names sorted,
// never into a symlink. Entries are relative to rel.
func (f *FS) List(rel string, depth, maxEntries int) (protocol.SandboxResult, error) {
	parts, err := segments(rel)
	if err != nil {
		return protocol.SandboxResult{}, err
	}
	fd, err := f.walk(parts, false, rel)
	if err != nil {
		return protocol.SandboxResult{}, err
	}
	l := lister{max: maxEntries, budget: listBudget, entries: []protocol.SandboxEntry{}}
	err = l.walk(fd, "", depth)
	_ = unix.Close(fd)
	if err != nil {
		return protocol.SandboxResult{}, errnoError(rel, err)
	}
	return protocol.SandboxResult{Ok: true, Entries: l.entries, Truncated: &l.truncated}, nil
}

type lister struct {
	max, budget int
	entries     []protocol.SandboxEntry
	truncated   bool
}

// walk lists the directory fd (which it does not close) at prefix.
func (l *lister) walk(fd int, prefix string, depth int) error {
	dup, err := unix.Dup(fd)
	if err != nil {
		return err
	}
	dir := os.NewFile(uintptr(dup), prefix)
	names, err := dir.Readdirnames(-1)
	_ = dir.Close()
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, name := range names {
		if len(l.entries) >= l.max || l.budget <= 0 {
			l.truncated = true
			return nil
		}
		var st unix.Stat_t
		if err := unix.Fstatat(fd, name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			continue // gone since the read: not listed
		}
		rel := path.Join(prefix, name)
		t := entryType(uint32(st.Mode))
		l.entries = append(l.entries, protocol.SandboxEntry{Path: rel, Type: t, Size: st.Size})
		l.budget -= len(rel) + 48
		if t != protocol.SandboxEntryTypeDir || depth <= 1 {
			continue
		}
		sub, err := openDirAt(fd, name)
		if err != nil {
			continue // replaced by a symlink or gone: not descended
		}
		err = l.walk(sub, rel, depth-1)
		_ = unix.Close(sub)
		if err != nil {
			return err
		}
	}
	return nil
}
