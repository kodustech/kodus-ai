package main

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"time"

	"golang.org/x/sys/unix"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
)

// diskOptions are the watchdog's settings beyond the floor.
type diskOptions struct {
	perRunGB  int
	outerPath string
	grace     time.Duration
	// trimPaths are the paths whose filesystems fstrim discards (the work
	// directory and Docker's data root, usually one filesystem).
	trimPaths []string
	// fstrim runs one fstrim and returns its output; nil: the fstrim binary.
	fstrim func(ctx context.Context, path string) (string, error)
}

// diskWatch is the free-disk watchdog of Docker's data root, nil when
// minFreeGB is zero.
func diskWatch(dataRoot string, minFreeGB int, opts ...diskOptions) *agent.DiskWatch {
	if minFreeGB <= 0 || dataRoot == "" {
		return nil
	}
	w := &agent.DiskWatch{Free: func() (uint64, error) { return freeBytes(dataRoot) }, MinFreeBytes: uint64(minFreeGB) << 30}
	for _, o := range opts {
		w.PerRunBytes = uint64(max(o.perRunGB, 0)) << 30 //nolint:gosec // G115: clamped at zero
		w.ReadyGrace = o.grace
		if o.outerPath != "" {
			outer := o.outerPath
			w.Outer = func() (uint64, error) { return freeBytes(outer) }
		}
		if len(o.trimPaths) > 0 {
			w.Trim = trimmer(o)
		}
	}
	return w
}

// trimmer discards the unused blocks of each distinct filesystem under
// o.trimPaths and sums what fstrim reports. A sparse build-state file only
// grows until its free blocks are discarded: fstrim returned 17 and 23 GB by
// hand on a full host. A path it cannot trim is an error after the others
// were trimmed.
func trimmer(o diskOptions) func(context.Context) (uint64, error) {
	run := o.fstrim
	if run == nil {
		run = runFstrim
	}
	return func(ctx context.Context) (uint64, error) {
		var total uint64
		var firstErr error
		seen := map[uint64]bool{}
		for _, p := range o.trimPaths {
			if p == "" {
				continue
			}
			var st unix.Stat_t
			if err := unix.Stat(p, &st); err == nil {
				id := uint64(st.Dev) //nolint:gosec,unconvert // G115: a device number
				if seen[id] {
					continue
				}
				seen[id] = true
			}
			out, err := run(ctx, p)
			if err != nil {
				if firstErr == nil {
					firstErr = fmt.Errorf("fstrim %s: %w", p, err)
				}
				continue
			}
			total += trimmedBytes(out)
		}
		return total, firstErr
	}
}

var trimmedRe = regexp.MustCompile(`\((\d+) bytes\) trimmed`)

// trimmedBytes reads the bytes from fstrim -v's "/mnt: 17 GiB (18253611008
// bytes) trimmed"; zero when the line is not there.
func trimmedBytes(out string) uint64 {
	m := trimmedRe.FindStringSubmatch(out)
	if m == nil {
		return 0
	}
	n, _ := strconv.ParseUint(m[1], 10, 64)
	return n
}

func runFstrim(ctx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	//nolint:gosec // G204: path is the work directory or Docker's data root from the cell's own flags
	out, err := exec.CommandContext(ctx, "fstrim", "-v", path).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%w: %s", err, out)
	}
	return string(out), nil
}

// freeBytes is what an unprivileged writer may still write under path.
func freeBytes(path string) (uint64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, err
	}
	return st.Bavail * uint64(st.Bsize), nil //nolint:gosec // G115: Bsize is a block size, positive
}
