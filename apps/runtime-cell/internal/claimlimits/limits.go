// Package claimlimits enforces one cgroup v2 budget for a claim's container
// subtree. Pids limits host tasks (including the gVisor Sentry), not guest
// processes. Daemon, image loading and cell artifact processing remain host
// overhead outside this tree. Configuration is explicit and fail-closed.
package claimlimits

import (
	"errors"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// ErrUnavailable means the requested aggregate enforcement was not established.
var ErrUnavailable = errors.New("claimlimits: resource enforcement unavailable")
var errPopulated = errors.New("claimlimits: parent still populated")

const maxDirectoryEntries = 4096

// Limits are the aggregate ceiling, not a reservation or a per-container limit.
// CPUQuota and CPUPeriod are in microseconds. Pids counts host kernel tasks.
type Limits struct{ MemoryBytes, CPUQuota, CPUPeriod, Pids int64 }

// Manager owns an explicitly delegated subtree. Keys are generated identities,
// never a path from a checkout, hub message or Docker label.
type Manager interface {
	Ensure(key string, limits Limits) (string, error)
	Remove(key string) error
	Verify(key string, pid int) error
}

// FS uses the local kernel's cgroupfs v2 tree. New never creates/delegates its
// root or changes ancestors; an operator must supply a dedicated root first.
type FS struct {
	mu     sync.Mutex
	root   directory
	parent string
	closed bool
}

var _ Manager = (*FS)(nil)

// directory is the narrow filesystem port. The Linux implementation uses
// directory descriptors and O_NOFOLLOW; tests model controller semantics.
type directory interface {
	Read(name string) (string, error)
	Write(name, value string) error
	Mkdir(name string) error
	Open(name string) (directory, error)
	Remove(name string) error
	Close() error
	List() ([]string, error)
}

var keyPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var componentPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]*$`)

// ValidateParent accepts an empty disabled value or an absolute cgroupfs path,
// never a standalone systemd unit name. Ancestors may be systemd-owned
// when an operator explicitly delegates a child below that unit.
func ValidateParent(parent string) error {
	if parent == "" {
		return nil
	}
	if len(parent) < 2 || len(parent) > 4096 || parent[0] != '/' || path.Clean(parent) != parent {
		return fmt.Errorf("%w: invalid absolute parent", ErrUnavailable)
	}
	parts := strings.Split(parent[1:], "/")
	for i, part := range parts {
		unit := strings.HasSuffix(part, ".slice") || strings.HasSuffix(part, ".scope") || strings.HasSuffix(part, ".service")
		if len(part) > 255 || !componentPattern.MatchString(part) || part == "." || part == ".." || (i == len(parts)-1 && unit) {
			return fmt.Errorf("%w: invalid parent component", ErrUnavailable)
		}
	}
	return nil
}
func validKey(key string) error {
	if !keyPattern.MatchString(key) {
		return fmt.Errorf("%w: invalid generated key", ErrUnavailable)
	}
	return nil
}
func (l Limits) values() (map[string]string, error) {
	if l.MemoryBytes < 1 || l.CPUQuota < 1000 || l.CPUPeriod < 1000 || l.CPUPeriod > 1000000 || l.Pids < 1 {
		return nil, fmt.Errorf("%w: invalid resource ceiling", ErrUnavailable)
	}
	return map[string]string{"memory.max": strconv.FormatInt(l.MemoryBytes, 10), "memory.swap.max": "0", "cpu.max": fmt.Sprintf("%d %d", l.CPUQuota, l.CPUPeriod), "pids.max": strconv.FormatInt(l.Pids, 10)}, nil
}
func controllers(value string) bool {
	set := map[string]bool{}
	for _, v := range strings.Fields(value) {
		set[v] = true
	}
	return set["cpu"] && set["memory"] && set["pids"]
}
func emptyProcesses(d directory) error {
	value, err := d.Read("cgroup.procs")
	if err != nil {
		return err
	}
	if strings.TrimSpace(value) != "" {
		return fmt.Errorf("%w: parent has processes", ErrUnavailable)
	}
	return nil
}
func newFS(root directory, parent string) (*FS, error) {
	if parent == "" {
		return nil, fmt.Errorf("%w: dedicated root required", ErrUnavailable)
	}
	if err := ValidateParent(parent); err != nil {
		return nil, err
	}
	for _, name := range []string{"cgroup.controllers", "cgroup.subtree_control"} {
		value, err := root.Read(name)
		if err != nil {
			return nil, fmt.Errorf("%w: read delegated controllers: %w", ErrUnavailable, err)
		}
		if !controllers(value) {
			return nil, fmt.Errorf("%w: cpu memory pids must already be delegated", ErrUnavailable)
		}
	}
	if err := emptyProcesses(root); err != nil {
		return nil, fmt.Errorf("%w: delegated root: %w", ErrUnavailable, err)
	}
	return &FS{root: root, parent: parent}, nil
}

// Ensure establishes and reads back every controller before returning a parent.
// An existing parent's ceiling is immutable: mismatch refuses, never updates.
func (f *FS) Ensure(key string, limits Limits) (parent string, err error) {
	if err = validKey(key); err != nil {
		return "", err
	}
	if err = ValidateParent(path.Join(f.parent, key)); err != nil {
		return "", err
	}
	values, err := limits.values()
	if err != nil {
		return "", err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return "", fmt.Errorf("%w: closed", ErrUnavailable)
	}
	group, err := f.root.Open(key)
	created := false
	if errors.Is(err, fs.ErrNotExist) {
		err = f.root.Mkdir(key)
		if err != nil && !errors.Is(err, fs.ErrExist) {
			return "", fmt.Errorf("%w: create group: %w", ErrUnavailable, err)
		}
		created = err == nil
		group, err = f.root.Open(key)
	}
	if err != nil {
		if created {
			err = errors.Join(err, f.root.Remove(key))
		}
		return "", fmt.Errorf("%w: open group: %w", ErrUnavailable, err)
	}
	defer group.Close()
	if created {
		defer func() {
			if err != nil {
				err = errors.Join(err, f.root.Remove(key))
			}
		}()
	}
	if err = emptyProcesses(group); err != nil {
		return "", fmt.Errorf("%w: parent: %w", ErrUnavailable, err)
	}
	if created {
		value, e := group.Read("cgroup.controllers")
		if e != nil {
			return "", fmt.Errorf("%w: read child controllers: %w", ErrUnavailable, e)
		}
		if !controllers(value) {
			return "", fmt.Errorf("%w: child controllers missing", ErrUnavailable)
		}
		for _, name := range []string{"memory.max", "memory.swap.max", "cpu.max", "pids.max"} {
			if err = group.Write(name, values[name]); err != nil {
				return "", fmt.Errorf("%w: set %s: %w", ErrUnavailable, name, err)
			}
		}
		if err = group.Write("cgroup.subtree_control", "+cpu +memory +pids"); err != nil {
			return "", fmt.Errorf("%w: enable child controllers: %w", ErrUnavailable, err)
		}
	}
	for _, name := range []string{"memory.max", "memory.swap.max", "cpu.max", "pids.max"} {
		value, e := group.Read(name)
		if e != nil {
			return "", fmt.Errorf("%w: read back %s: %w", ErrUnavailable, name, e)
		}
		if strings.Join(strings.Fields(value), " ") != values[name] {
			return "", fmt.Errorf("%w: %s ceiling mismatch", ErrUnavailable, name)
		}
	}
	value, e := group.Read("cgroup.subtree_control")
	if e != nil {
		return "", fmt.Errorf("%w: read child controller state: %w", ErrUnavailable, e)
	}
	if !controllers(value) {
		return "", fmt.Errorf("%w: child controllers not enabled", ErrUnavailable)
	}
	return path.Join(f.parent, key), nil
}

// Remove removes only the named empty parent, without recursive deletion or
// cgroup.kill. Leftover Docker children remain a cleanup error for reconciliation.
func (f *FS) Remove(key string) error {
	if err := validKey(key); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return fmt.Errorf("%w: closed", ErrUnavailable)
	}
	group, err := f.root.Open(key)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%w: open removal: %w", ErrUnavailable, err)
	}
	value, err := group.Read("cgroup.events")
	cerr := group.Close()
	if err != nil || cerr != nil {
		return fmt.Errorf("%w: read group state: %w", ErrUnavailable, errors.Join(err, cerr))
	}
	empty := false
	for _, line := range strings.Split(value, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "populated" {
			empty = fields[1] == "0"
		}
	}
	if !empty {
		return fmt.Errorf("%w: %w", ErrUnavailable, errPopulated)
	}
	if err = f.root.Remove(key); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w: remove group: %w", ErrUnavailable, err)
	}
	return nil
}

// PruneEmpty reconciles empty generated parents only at exclusive cell startup,
// before any new workload can pass Ensure. It must not run as a background
// sweep: a newly configured parent is briefly empty before Docker starts.
func (f *FS) PruneEmpty() error {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return fmt.Errorf("%w: closed", ErrUnavailable)
	}
	names, err := f.root.List()
	f.mu.Unlock()
	if err != nil {
		return fmt.Errorf("%w: list parents: %w", ErrUnavailable, err)
	}
	var all []error
	for _, key := range names {
		if !keyPattern.MatchString(key) {
			continue
		}
		err = f.Remove(key)
		if errors.Is(err, errPopulated) || errors.Is(err, syscall.EBUSY) || errors.Is(err, syscall.ENOTEMPTY) {
			continue
		}
		if err != nil {
			all = append(all, err)
		}
	}
	return errors.Join(all...)
}

// RequireEmpty is a startup guard after PruneEmpty, before the cell advertises
// admission capacity or accepts work. Retained managed parents require explicit
// drain/reaper cleanup: this release cannot reconstruct live resource ownership
// from a crashed process into a fresh agent's admission ledger.
func (f *FS) RequireEmpty() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return fmt.Errorf("%w: closed", ErrUnavailable)
	}
	names, err := f.root.List()
	if err != nil {
		return fmt.Errorf("%w: inspect retained resource groups: %w", ErrUnavailable, err)
	}
	if len(names) > maxDirectoryEntries {
		return fmt.Errorf("%w: too many retained resource entries", ErrUnavailable)
	}
	for _, name := range names {
		if keyPattern.MatchString(name) {
			return fmt.Errorf("%w: retained managed resource groups require drain or reaper cleanup before restart", ErrUnavailable)
		}
	}
	return nil
}

// Verify proves a container PID belongs below this parent's local hierarchy.
// It catches a daemon on another host or a mount namespace mismatch before
// launching any untrusted workload in the parent.
func (f *FS) Verify(key string, pid int) error {
	if err := validKey(key); err != nil {
		return err
	}
	if pid <= 0 {
		return fmt.Errorf("%w: missing container pid", ErrUnavailable)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return fmt.Errorf("%w: closed", ErrUnavailable)
	}
	raw, err := readProcessCgroup(pid)
	if err != nil {
		return fmt.Errorf("%w: read container membership: %w", ErrUnavailable, err)
	}
	return verifyMembership(path.Join(f.parent, key), raw)
}
func verifyMembership(parent, raw string) error {
	found := false
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		fields := strings.SplitN(line, ":", 3)
		if len(fields) != 3 || fields[0] != "0" || fields[1] != "" {
			continue
		}
		if found {
			return fmt.Errorf("%w: duplicate unified membership", ErrUnavailable)
		}
		found = true
		if !strings.HasPrefix(fields[2], parent+"/") || path.Clean(fields[2]) != fields[2] {
			return fmt.Errorf("%w: container outside expected parent", ErrUnavailable)
		}
	}
	if !found {
		return fmt.Errorf("%w: unified membership absent", ErrUnavailable)
	}
	return nil
}

// Close releases the directory descriptor and its exclusive delegation lock;
// it never kills or removes work.
func (f *FS) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return nil
	}
	f.closed = true
	return f.root.Close()
}
