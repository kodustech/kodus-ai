//go:build unix

package vmsnap

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

// allocated is the disk the files under dir take (their blocks, not their
// apparent size: a data disk is sparse).
func allocated(dir string) int64 {
	var n int64
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if fi, ierr := d.Info(); ierr == nil {
				if st, ok := fi.Sys().(*syscall.Stat_t); ok {
					n += st.Blocks * 512
				}
			}
		}
		return nil // an entry gone since the listing counts nothing
	})
	return n
}

// digestFile is a snapshot file's digest: sha256 over each run of data (its
// offset, its length, its bytes) and the file's size, holes skipped, so a
// 40 GB data disk that holds 2 GB costs 2 GB to read. It names one file's
// content as laid out; the store never rewrites a published file.
func digestFile(f *os.File) (string, int64, error) {
	runs, size, err := dataRuns(f)
	if err != nil {
		return "", 0, err
	}
	h := sha256.New()
	for _, r := range runs {
		_, _ = fmt.Fprintf(h, "data %d %d\n", r.Offset, r.Length)
		if _, err := io.Copy(h, io.NewSectionReader(f, r.Offset, r.Length)); err != nil {
			return "", 0, err
		}
	}
	_, _ = fmt.Fprintf(h, "size %d\n", size)
	return hex.EncodeToString(h.Sum(nil)), size, nil
}

// Run is one run of data in a sparse file: what digestFile reads, and what
// an export carries (export.go).
type Run struct {
	Offset int64 `json:"offset"`
	Length int64 `json:"length"`
}

// dataRuns are f's runs of data, holes skipped, as the file system lays
// them out, and f's size. A file system without SEEK_DATA has one run.
func dataRuns(f *os.File) ([]Run, int64, error) {
	fi, err := f.Stat()
	if err != nil {
		return nil, 0, err
	}
	size := fi.Size()
	var runs []Run
	for off := int64(0); off < size; {
		data, err := f.Seek(off, unix.SEEK_DATA)
		if errors.Is(err, unix.ENXIO) {
			break // nothing but a hole to the end
		}
		if err != nil {
			data = off // a file system without SEEK_DATA: all of it is data
		}
		hole, err := f.Seek(data, unix.SEEK_HOLE)
		if err != nil || hole > size {
			hole = size
		}
		runs = append(runs, Run{Offset: data, Length: hole - data})
		off = hole
	}
	return runs, size, nil
}

// freeBytes is what the file system under dir has free for the cell.
func freeBytes(dir string) (int64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil //nolint:gosec // G115: a file system's counts fit an int64
}
