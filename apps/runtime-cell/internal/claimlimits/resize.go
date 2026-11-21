package claimlimits

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// Resizer lowers a budget's memory ceiling and reads what its subtree uses.
// A claim is counted at its whole ceiling while it builds; once ready the
// cell lowers the ceiling to what the claim uses plus room and counts that
// (drivers/dockergvisor settle.go). Lower never raises and never touches CPU
// or pids, so the enforced ceiling is never above what admission counts.
// Ensure stays exact: after a Lower, a launch names the lowered ceiling.
type Resizer interface {
	Lower(key string, memoryBytes int64) error
	Usage(key string) (Usage, error)
}

var (
	_ Resizer = (*FS)(nil)
	_ Resizer = (*Systemd)(nil)
)

// Usage is a budget's memory.current, the file and shmem lines of its
// memory.stat, and the oom_kill count of its memory.events (hierarchical:
// every container below it).
type Usage struct {
	CurrentBytes, FileBytes, ShmemBytes int64
	OOMKills                            uint64
}

// WorkingSetBytes is what the subtree holds that the kernel cannot reclaim
// by dropping file cache: memory.current less the file pages that are not
// shmem. shmem stays: with no swap it cannot be reclaimed, and the gVisor
// Sentry's memory file is shmem.
func (u Usage) WorkingSetBytes() int64 {
	return max(u.CurrentBytes-max(u.FileBytes-u.ShmemBytes, 0), 0)
}

func readUsage(g directory) (Usage, error) {
	var u Usage
	raw, err := g.Read("memory.current")
	if err != nil {
		return Usage{}, fmt.Errorf("%w: read memory.current: %w", ErrUnavailable, err)
	}
	if u.CurrentBytes, err = strconv.ParseInt(strings.TrimSpace(raw), 10, 64); err != nil || u.CurrentBytes < 0 {
		return Usage{}, fmt.Errorf("%w: memory.current is not a byte count", ErrUnavailable)
	}
	stat, err := g.Read("memory.stat")
	if err != nil {
		return Usage{}, fmt.Errorf("%w: read memory.stat: %w", ErrUnavailable, err)
	}
	fields := keyed(stat)
	file, okFile := fields["file"]
	shmem, okShmem := fields["shmem"]
	if !okFile || !okShmem {
		return Usage{}, fmt.Errorf("%w: memory.stat has no file or shmem line", ErrUnavailable)
	}
	u.FileBytes, u.ShmemBytes = int64(min(file, 1<<62)), int64(min(shmem, 1<<62))
	events, err := g.Read("memory.events")
	if err != nil {
		return Usage{}, fmt.Errorf("%w: read memory.events: %w", ErrUnavailable, err)
	}
	u.OOMKills = keyed(events)["oom_kill"]
	return u, nil
}

// keyed reads a cgroup "name value" file; lines it cannot read are skipped.
func keyed(raw string) map[string]uint64 {
	out := map[string]uint64{}
	for _, line := range strings.Split(raw, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok {
			continue
		}
		if n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64); err == nil {
			out[k] = n
		}
	}
	return out
}

func memoryMax(g directory) (int64, error) {
	raw, err := g.Read("memory.max")
	if err != nil {
		return 0, fmt.Errorf("%w: read memory.max: %w", ErrUnavailable, err)
	}
	n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || n < 1 {
		// "max" included: a budget this package made always has a number.
		return 0, fmt.Errorf("%w: memory.max is not a ceiling this manager set", ErrUnavailable)
	}
	return n, nil
}

func validLower(key string, memoryBytes int64) error {
	if err := validKey(key); err != nil {
		return err
	}
	if memoryBytes < 1 {
		return fmt.Errorf("%w: invalid memory ceiling", ErrUnavailable)
	}
	return nil
}

// Lower writes a smaller memory.max and reads it back. The kernel reclaims
// down to it (and kills in the group if it cannot): the caller picks a
// ceiling above what the group holds.
func (f *FS) Lower(key string, memoryBytes int64) error {
	if err := validLower(key, memoryBytes); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return fmt.Errorf("%w: closed", ErrUnavailable)
	}
	group, err := f.root.Open(key)
	if err != nil {
		return fmt.Errorf("%w: open group: %w", ErrUnavailable, err)
	}
	defer func() { _ = group.Close() }()
	current, err := memoryMax(group)
	if err != nil {
		return err
	}
	if memoryBytes > current {
		return fmt.Errorf("%w: a budget's memory ceiling is only lowered", ErrUnavailable)
	}
	if memoryBytes == current {
		return nil
	}
	if err = group.Write("memory.max", strconv.FormatInt(memoryBytes, 10)); err != nil {
		return fmt.Errorf("%w: set memory.max: %w", ErrUnavailable, err)
	}
	if got, err := memoryMax(group); err != nil || got != memoryBytes {
		return fmt.Errorf("%w: memory.max ceiling mismatch: %w", ErrUnavailable, err)
	}
	return nil
}

func (f *FS) Usage(key string) (Usage, error) {
	if err := validKey(key); err != nil {
		return Usage{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return Usage{}, fmt.Errorf("%w: closed", ErrUnavailable)
	}
	group, err := f.root.Open(key)
	if err != nil {
		return Usage{}, fmt.Errorf("%w: open group: %w", ErrUnavailable, err)
	}
	defer func() { _ = group.Close() }()
	return readUsage(group)
}

// Lower sets the slice's MemoryMax over D-Bus (systemd stays the single
// writer of its cgroupfs), then verifies the unit and the kernel file.
func (m *Systemd) Lower(key string, memoryBytes int64) error {
	if err := validLower(key, memoryBytes); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), systemdOperationTimeout)
	defer cancel()
	l, err := m.verifiedLocked(ctx, key)
	if err != nil {
		return err
	}
	if memoryBytes > l.MemoryBytes {
		return fmt.Errorf("%w: a budget's memory ceiling is only lowered", ErrUnavailable)
	}
	if memoryBytes == l.MemoryBytes {
		return nil
	}
	if err = m.bus.SetMemoryMax(ctx, m.name(key), uint64(memoryBytes)); err != nil { //nolint:gosec // G115: validLower refused a size under 1
		return fmt.Errorf("%w: set MemoryMax: %w", ErrUnavailable, err)
	}
	got, err := m.verifiedLocked(ctx, key)
	if err != nil {
		return err
	}
	want := l
	want.MemoryBytes = memoryBytes
	if got != want {
		return fmt.Errorf("%w: slice ceiling mismatch after lowering", ErrUnavailable)
	}
	return nil
}

func (m *Systemd) Usage(key string) (Usage, error) {
	if err := validKey(key); err != nil {
		return Usage{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), systemdOperationTimeout)
	defer cancel()
	if _, err := m.verifiedLocked(ctx, key); err != nil {
		return Usage{}, err
	}
	g, err := m.root.Open(m.name(key))
	if err != nil {
		return Usage{}, fmt.Errorf("%w: kernel child: %w", ErrUnavailable, err)
	}
	defer func() { _ = g.Close() }()
	return readUsage(g)
}

// verifiedLocked is the slice's ceiling once the root, the unit and the
// kernel files all agree on it.
func (m *Systemd) verifiedLocked(ctx context.Context, key string) (Limits, error) {
	if err := m.guard(ctx); err != nil {
		return Limits{}, err
	}
	u, err := m.bus.Unit(ctx, m.name(key))
	if err != nil {
		return Limits{}, fmt.Errorf("%w: inspect slice: %w", ErrUnavailable, err)
	}
	l, err := m.validateUnit(key, u)
	if err != nil {
		return Limits{}, err
	}
	if err = m.readback(u.Name, l); err != nil {
		return Limits{}, err
	}
	return l, nil
}
