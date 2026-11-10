// Package tarball brings the repo into the cell without git (S-05): the SHA's
// tarball is downloaded through the Git API with the claim's download token,
// extracted by a process with no network that refuses links and paths
// outside the root, and the token is revoked right after, whatever happened.
package tarball

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
)

type Limits struct {
	// MaxFiles counts every entry, directories included: an archive of
	// empty directories would otherwise exhaust the cell's inodes.
	MaxFiles     int
	MaxTotal     int64 // uncompressed bytes
	MaxFileBytes int64
}

var DefaultLimits = Limits{MaxFiles: 200_000, MaxTotal: 4 << 30, MaxFileBytes: 1 << 30}

// RefusedError names the entry that made the whole extraction fail.
type RefusedError struct {
	Entry  string
	Reason string
}

func (e *RefusedError) Error() string {
	return fmt.Sprintf("tarball: refused %q: %s", e.Entry, e.Reason)
}

type Stats struct {
	Files int
	Dirs  int
	Bytes int64
	// Prefix is the single top-level directory the forge puts every entry
	// under (owner-repo-sha/), stripped on extraction.
	Prefix string
}

// Extract reads a gzip tarball and writes it under dest, which must be an
// empty directory. A symlink is kept only when it resolves inside dest
// (confinedSymlink, S-05); any other symlink, a hard link, a device, a path
// with "..", an absolute path or a .git entry refuses the whole archive and
// leaves dest empty.
func Extract(r io.Reader, dest string, lim Limits) (st Stats, err error) {
	if lim.MaxFiles == 0 {
		lim = DefaultLimits
	}
	entries, err := os.ReadDir(dest)
	if err != nil {
		return st, err
	}
	if len(entries) != 0 {
		return st, errors.New("tarball: destination is not empty")
	}
	root, err := os.OpenRoot(dest)
	if err != nil {
		return st, err
	}
	defer root.Close()
	defer func() {
		if err != nil {
			emptyDir(dest)
		}
	}()

	gz, err := gzip.NewReader(r)
	if err != nil {
		return st, fmt.Errorf("tarball: %w", err)
	}
	tr := tar.NewReader(gz)
	var links []string
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return st, fmt.Errorf("tarball: %w", err)
		}
		if h.Typeflag == tar.TypeXGlobalHeader {
			continue // GitHub's pax header with the commit id
		}
		rel, err := relativeName(h.Name, &st.Prefix)
		if err != nil {
			return st, err
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if rel == "" {
				continue
			}
			if st.Files+st.Dirs >= lim.MaxFiles {
				return st, &RefusedError{h.Name, "too many entries"}
			}
			if err := mkdirAll(root, rel); err != nil {
				return st, err
			}
			st.Dirs++
		case tar.TypeReg:
			if rel == "" {
				return st, &RefusedError{h.Name, "file at the archive root"}
			}
			if st.Files+st.Dirs >= lim.MaxFiles {
				return st, &RefusedError{h.Name, "too many entries"}
			}
			st.Files++
			if h.Size > lim.MaxFileBytes || st.Bytes+h.Size > lim.MaxTotal {
				return st, &RefusedError{h.Name, "archive too large"}
			}
			if dir := path.Dir(rel); dir != "." {
				if err := mkdirAll(root, dir); err != nil {
					return st, err
				}
			}
			// Executable bit kept, setuid, setgid and sticky never.
			mode := fs.FileMode(0o644)
			if h.Mode&0o111 != 0 {
				mode = 0o755
			}
			f, err := root.OpenFile(rel, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
			if err != nil {
				return st, fmt.Errorf("tarball: %s: %w", rel, err)
			}
			n, err := io.Copy(f, io.LimitReader(tr, h.Size))
			cerr := f.Close()
			if err != nil {
				return st, err
			}
			if cerr != nil {
				return st, cerr
			}
			st.Bytes += n
		case tar.TypeSymlink:
			// Repos keep links inside themselves (packages/prisma/.env ->
			// ../../.env). Where it points is checked once every entry is
			// on disk, since a later entry can be a link it goes through.
			if rel == "" {
				return st, &RefusedError{h.Name, "symlink at the archive root"}
			}
			if st.Files+st.Dirs >= lim.MaxFiles {
				return st, &RefusedError{h.Name, "too many entries"}
			}
			t := h.Linkname
			switch {
			case t == "" || len(t) > maxLinkTarget:
				return st, &RefusedError{h.Name, "symlink with an empty or too long target"}
			case strings.ContainsRune(t, 0) || strings.Contains(t, `\`):
				return st, &RefusedError{h.Name, "symlink target with NUL or backslash"}
			case strings.HasPrefix(t, "/"):
				return st, &RefusedError{h.Name, "symlink to an absolute path"}
			}
			if dir := path.Dir(rel); dir != "." {
				if err := mkdirAll(root, dir); err != nil {
					return st, err
				}
			}
			if err := root.Symlink(t, rel); err != nil {
				return st, fmt.Errorf("tarball: %s: %w", rel, err)
			}
			st.Files++
			links = append(links, rel)
		case tar.TypeLink:
			return st, &RefusedError{h.Name, "hard link"}
		default:
			return st, &RefusedError{h.Name, fmt.Sprintf("entry type %q", h.Typeflag)}
		}
	}
	for _, l := range links {
		if reason := confinedSymlink(root, l); reason != "" {
			return st, &RefusedError{st.Prefix + "/" + l, reason}
		}
	}
	return st, nil
}

// maxLinkTarget bounds a symlink's target; a forge never needs more.
const maxLinkTarget = 1024

// maxLinkHops bounds how many links one resolution follows (a cycle).
const maxLinkHops = 40

// confinedSymlink resolves the link at rel the way the kernel would, but
// one component at a time on disk and never above the root: every link on
// the way is followed by its own target, so a chain (a/b/z -> ../../k and
// a/b/q -> z/../../../x) that reads as inside but lands outside is caught.
// A component that does not exist is taken as written: the link may point
// at a file the app creates (an .env the repo leaves out). It also refuses
// a link to the root or to a directory that holds the link, a cycle for any
// tool that walks the tree. "" means the link stays inside.
func confinedSymlink(root *os.Root, rel string) string {
	target, err := root.Readlink(rel)
	if err != nil {
		return "symlink unreadable"
	}
	var cur []string
	if d := path.Dir(rel); d != "." {
		cur = strings.Split(d, "/")
	}
	queue := strings.Split(target, "/")
	hops := 0
	for len(queue) > 0 {
		c := queue[0]
		queue = queue[1:]
		switch c {
		case "", ".":
			continue
		case "..":
			if len(cur) == 0 {
				return "symlink to a path outside the root"
			}
			cur = cur[:len(cur)-1]
			continue
		case ".git":
			return "symlink into .git"
		}
		next := append(append([]string{}, cur...), c)
		// Every name in cur is a real directory (links were expanded, not
		// appended), so Lstat never follows a link on the way.
		fi, err := root.Lstat(strings.Join(next, "/"))
		if err != nil {
			cur = next
			continue
		}
		if fi.Mode()&fs.ModeSymlink == 0 {
			cur = next
			continue
		}
		if hops++; hops > maxLinkHops {
			return "symlink cycle"
		}
		t, err := root.Readlink(strings.Join(next, "/"))
		if err != nil || strings.HasPrefix(t, "/") {
			return "symlink through a link to an absolute path"
		}
		queue = append(strings.Split(t, "/"), queue...)
	}
	resolved := strings.Join(cur, "/")
	if resolved == "" || strings.HasPrefix(rel, resolved+"/") {
		return "symlink to a directory that holds it"
	}
	return ""
}

// relativeName strips the single top-level prefix and refuses any name that
// could land outside the root.
func relativeName(name string, prefix *string) (string, error) {
	switch {
	case name == "":
		return "", &RefusedError{name, "empty name"}
	case strings.ContainsRune(name, 0):
		return "", &RefusedError{name, "NUL in name"}
	case strings.Contains(name, `\`):
		return "", &RefusedError{name, "backslash in name"}
	case strings.HasPrefix(name, "/"):
		return "", &RefusedError{name, "absolute path"}
	}
	parts := strings.Split(strings.TrimSuffix(name, "/"), "/")
	for _, p := range parts {
		if p == ".." {
			return "", &RefusedError{name, "path outside the root"}
		}
		if p == ".git" {
			return "", &RefusedError{name, ".git entry (hooks, config)"}
		}
	}
	clean := path.Clean(name)
	if clean == "." || clean != strings.TrimSuffix(name, "/") {
		return "", &RefusedError{name, "non-canonical path"}
	}
	top, rest, _ := strings.Cut(clean, "/")
	if *prefix == "" {
		*prefix = top
	} else if top != *prefix {
		return "", &RefusedError{name, "more than one top-level directory"}
	}
	return rest, nil
}

func mkdirAll(root *os.Root, rel string) error {
	cur := ""
	for _, p := range strings.Split(rel, "/") {
		cur = path.Join(cur, p)
		err := root.Mkdir(cur, 0o755)
		if err == nil || errors.Is(err, fs.ErrExist) {
			fi, serr := root.Lstat(cur)
			if serr != nil {
				return serr
			}
			if !fi.IsDir() {
				return &RefusedError{rel, "a file is in the way of a directory"}
			}
			continue
		}
		return err
	}
	return nil
}

func emptyDir(dir string) {
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		_ = os.RemoveAll(dir + string(os.PathSeparator) + e.Name())
	}
}
