// Package buildfingerprint is the identity of one image build as the cell
// can see it: Of hashes the context BuildKit would send, the Dockerfile, the
// target, the args and the builder image. A driver that reuses a baked image
// compares fingerprints; it holds no state and knows no backend.
package buildfingerprint

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"syscall"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
)

// Limits past which a build has no fingerprint: it is built every time,
// never reused, rather than the cell reading an unbounded checkout.
const (
	maxFingerprintFiles = 200_000
	maxFingerprintBytes = 4 << 30
)

// ErrNone: the build cannot be fingerprinted (too large, unreadable).
var ErrNone = errors.New("buildfingerprint: build has no fingerprint")

// fingerprintVersion changes whenever what the fingerprint covers does, so
// an image baked under the old rules is never taken for a new build. v2:
// the entries the context's ignore file leaves out are not covered.
const fingerprintVersion = "kodus-build-v2"

// fingerprint is what a build's result depends on, as far as the cell can
// see it: every entry of the context BuildKit sends (path, type, mode, and
// content or link target), the Dockerfile and ignore file, the Dockerfile
// name, the target, the args and the builder image.
// Two builds with the same fingerprint run the same steps on the same
// input, so one's image stands for the other's. A base image that moved
// upstream under the same tag is the one input it cannot see, as any build
// cache.
//
// An entry the ignore file leaves out never reaches the build (BuildKit
// does not send it), so a PR that only touches such entries (docs, a
// README, tests kept out of the image) keeps the fingerprint and takes the
// baked image. See exclusions for when nothing is left out.
//
// The context is the PR's checkout: nothing is followed (a symlink hashes
// its target string), and only regular files are opened, without following
// and without blocking, so a planted FIFO or device cannot hang the cell.
func Of(b sandbox.Build, builderImage string) (string, error) {
	h := sha256.New()
	write := func(parts ...string) {
		for _, p := range parts {
			fmt.Fprintf(h, "%d:%s", len(p), p)
		}
	}
	write(fingerprintVersion, builderImage, b.Dockerfile, b.Target)
	keys := make([]string, 0, len(b.Args))
	for k := range b.Args {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		write("arg", k, b.Args[k])
	}
	ex := contextExclusions(b)
	write("excludes", ex.source)
	for _, d := range ex.definition {
		write("definition", d.name, d.sum)
	}
	filter := newContextFilter(ex.matcher)

	files, total := 0, int64(0)
	err := filepath.WalkDir(b.Context, func(path string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(b.Context, path)
		if err != nil {
			return err
		}
		if files++; files > maxFingerprintFiles {
			return ErrNone
		}
		rel = filepath.ToSlash(rel)
		if sent, err := filter.admit(rel, e, write); !sent || err != nil {
			return err
		}
		return hashEntry(path, rel, e, &total, write)
	})
	if err != nil {
		if errors.Is(err, ErrNone) {
			return "", err
		}
		return "", fmt.Errorf("%w: %v", ErrNone, err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// hashEntry hashes one entry the build is sent; total counts the bytes of
// regular files so far.
func hashEntry(path, rel string, e fs.DirEntry, total *int64, write func(...string)) error {
	info, err := e.Info()
	if err != nil {
		return err
	}
	mode := info.Mode()
	switch {
	case mode.IsDir():
		write("dir", rel, mode.Perm().String())
	case mode&fs.ModeSymlink != 0:
		target, err := os.Readlink(path)
		if err != nil {
			return err
		}
		write("link", rel, target)
	case mode.IsRegular():
		if *total += info.Size(); *total > maxFingerprintBytes {
			return ErrNone
		}
		sum, err := fileSum(path)
		if err != nil {
			return err
		}
		write("file", rel, mode.Perm().String(), sum)
	default:
		// A FIFO, socket or device: its presence and name, never its content.
		write("other", rel, mode.Type().String())
	}
	return nil
}

func fileSum(path string) (string, error) {
	f, err := openRegular(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// openRegular opens a file of the checkout without following a link and
// without blocking, and refuses anything but a regular file: a FIFO or
// device planted in the PR cannot hang the cell.
func openRegular(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	// Swapped for something else between the walk and the open: refuse.
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		f.Close()
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	return f, nil
}
