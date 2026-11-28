package toollayer

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Normalized modes: files lose every exec bit (the CLI runs as
// `<interpreter> <script>`, parity with the noexec workspace), directories
// stay searchable, symlinks have no mode of their own.
const (
	modeFile uint32 = 0o444
	modeDir  uint32 = 0o555
	modeLink uint32 = 0o777
)

const (
	maxNameBytes = 255
	maxPathBytes = 4096
)

// extraction is what a tar stream became: file contents in blobs/<sha256>
// under the staging directory, and the manifest. Nothing here is in the store
// yet, and nothing was ever written through a path the archive chose.
type extraction struct {
	entries []Entry // sorted by path
	bytes   int64
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// limitReader fails with too_large instead of io.EOF when the stream is longer than n.
type limitReader struct {
	r io.Reader
	n int64
}

func (l *limitReader) Read(p []byte) (int, error) {
	if l.n <= 0 {
		var one [1]byte
		if k, _ := l.r.Read(one[:]); k > 0 {
			return 0, refused("too_large", "tar stream longer than its cap")
		}
		return 0, io.EOF
	}
	if int64(len(p)) > l.n {
		p = p[:l.n]
	}
	n, err := l.r.Read(p)
	l.n -= int64(n)
	return n, err
}

// extract reads the archive into stage/blobs with Go code only, never tar(1).
// It refuses the whole layer on the first thing it dislikes.
func extract(ctx context.Context, r io.Reader, stage string, maxBytes int64, maxEntries int) (*extraction, error) {
	blobs := filepath.Join(stage, "blobs")
	if err := os.MkdirAll(blobs, 0o700); err != nil {
		return nil, err
	}
	// Headers and padding are bounded by the entry cap, content by maxBytes.
	raw := &limitReader{r: ctxReader{ctx, r}, n: maxBytes + int64(maxEntries)*2048 + 1<<20}
	tr := tar.NewReader(raw)

	byPath := map[string]*Entry{}
	explicit := map[string]bool{}
	var total int64
	headers := 0

	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if cerr := ctx.Err(); cerr != nil {
				return nil, cerr
			}
			var re *RefusalError
			if errors.As(err, &re) {
				return nil, err
			}
			return nil, refused("bad_archive", err.Error())
		}
		headers++
		if headers > maxEntries {
			return nil, refused("too_many_entries", "")
		}

		var typ string
		switch hdr.Typeflag {
		case tar.TypeReg:
			typ = "file"
		case tar.TypeDir:
			typ = "dir"
		case tar.TypeSymlink:
			typ = "symlink"
		case tar.TypeLink:
			return nil, refused("hardlink", hdr.Name)
		default:
			return nil, refused("unsupported_type", hdr.Name)
		}
		if hdr.Mode&0o7000 != 0 {
			return nil, refused("setid", hdr.Name)
		}

		segs, skip, err := splitName(hdr.Name, typ == "dir")
		if err != nil {
			return nil, err
		}
		if skip {
			continue
		}
		p := strings.Join(segs, "/")
		if explicit[p] {
			return nil, refused("duplicate", p)
		}

		// Every ancestor is a directory this archive made (or implies); a
		// symlink there would send a later entry somewhere else.
		for i := 1; i < len(segs); i++ {
			anc := strings.Join(segs[:i], "/")
			switch e := byPath[anc]; {
			case e == nil:
				byPath[anc] = &Entry{Path: anc, Type: "dir", Mode: modeDir}
			case e.Type == "symlink":
				return nil, refused("parent_symlink", p)
			case e.Type == "file":
				return nil, refused("parent_not_dir", p)
			}
		}
		if prev := byPath[p]; prev != nil && (typ != "dir" || prev.Type != "dir") {
			return nil, refused("duplicate", p)
		}
		explicit[p] = true

		switch typ {
		case "dir":
			byPath[p] = &Entry{Path: p, Type: "dir", Mode: modeDir}
		case "symlink":
			if err := checkLinkTarget(segs, hdr.Linkname); err != nil {
				return nil, err
			}
			byPath[p] = &Entry{Path: p, Type: "symlink", Mode: modeLink, Target: hdr.Linkname}
		case "file":
			if hdr.Size > maxBytes-total {
				return nil, refused("too_large", p)
			}
			sum, err := storeBlob(ctx, tr, blobs)
			if err != nil {
				return nil, err
			}
			total += hdr.Size
			byPath[p] = &Entry{Path: p, Type: "file", Mode: modeFile, Size: hdr.Size, SHA256: sum}
		}
	}

	ex := &extraction{bytes: total}
	for _, e := range byPath {
		ex.entries = append(ex.entries, *e)
	}
	sort.Slice(ex.entries, func(i, j int) bool { return ex.entries[i].Path < ex.entries[j].Path })
	return ex, nil
}

// splitName validates a tar name and returns its segments; skip is true for
// the archive root ("./"), which the store has already.
func splitName(name string, isDir bool) (segs []string, skip bool, err error) {
	if strings.IndexByte(name, 0) >= 0 {
		return nil, false, refused("invalid_path", "NUL in a name")
	}
	if strings.HasPrefix(name, "/") {
		return nil, false, refused("absolute_path", name)
	}
	name = strings.TrimPrefix(name, "./")
	if name == "." || name == "" {
		if isDir {
			return nil, true, nil
		}
		return nil, false, refused("invalid_path", name)
	}
	if isDir {
		name = strings.TrimSuffix(name, "/")
	}
	if len(name) > maxPathBytes {
		return nil, false, refused("path_too_long", "")
	}
	segs = strings.Split(name, "/")
	for _, s := range segs {
		switch {
		case s == "..":
			return nil, false, refused("dotdot", name)
		case s == "" || s == ".":
			return nil, false, refused("invalid_path", name)
		case len(s) > maxNameBytes:
			return nil, false, refused("name_too_long", "")
		}
	}
	return segs, false, nil
}

// checkLinkTarget refuses a symlink that could leave the layer root when the
// review sandbox resolves it (a link to /workspace/... would run the PR's
// JavaScript as part of the CLI). Only leading ".." segments are allowed:
// one after a name would be resolved through whatever that name links to,
// which a lexical check cannot know.
func checkLinkTarget(linkSegs []string, target string) error {
	if target == "" || strings.IndexByte(target, 0) >= 0 {
		return refused("symlink_escape", "empty or invalid target")
	}
	if strings.HasPrefix(target, "/") {
		return refused("symlink_absolute", target)
	}
	ups, named := 0, false
	for _, s := range strings.Split(target, "/") {
		switch s {
		case "", ".":
		case "..":
			if named {
				return refused("symlink_escape", target)
			}
			ups++
		default:
			named = true
		}
	}
	if ups > len(linkSegs)-1 {
		return refused("symlink_escape", target)
	}
	return nil
}

// storeBlob writes one file's content to blobs/<sha256> and returns the sha256.
func storeBlob(ctx context.Context, src io.Reader, blobs string) (string, error) {
	f, err := os.CreateTemp(blobs, ".tmp-")
	if err != nil {
		return "", err
	}
	tmp := f.Name()
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), src)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = ctx.Err()
	}
	if err != nil {
		_ = os.Remove(tmp) // best-effort: the write error is what the caller needs
		return "", err
	}
	sum := hex.EncodeToString(h.Sum(nil))
	dst := filepath.Join(blobs, sum)
	if _, statErr := os.Lstat(dst); statErr == nil {
		return sum, os.Remove(tmp)
	}
	if err := os.Chmod(tmp, 0o444); err != nil { //nolint:gosec // G302: blobs are read-only (0444) on purpose, inside a 0700 store dir, and the sandbox user must read them
		_ = os.Remove(tmp) // best-effort: the write error is what the caller needs
		return "", err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp) // best-effort: the write error is what the caller needs
		return "", err
	}
	return sum, nil
}
