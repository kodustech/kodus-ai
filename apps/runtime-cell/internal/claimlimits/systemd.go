package claimlimits

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Lifecycle owns the controller's exclusive root as well as claim budgets.
// Startup must prune then require an empty managed tree before fresh admission.
type Lifecycle interface {
	Manager
	PruneEmpty() error
	RequireEmpty() error
	Close() error
}

var _ Lifecycle = (*FS)(nil)
var systemdParentPattern = regexp.MustCompile(`^kodus[0-9a-f]{12}-[0-9a-f]{64}\.slice$`)

// ValidateDockerParent accepts either a trusted cgroupfs path or the generated
// systemd slice name. ValidateParent remains the stricter filesystem validator.
func ValidateDockerParent(parent string) error {
	if systemdParentPattern.MatchString(parent) {
		return nil
	}
	return ValidateParent(parent)
}
func RootSliceName(cellID string) string {
	h := sha256.Sum256([]byte(cellID))
	return "kodus" + hex.EncodeToString(h[:6]) + ".slice"
}
func RootSliceDescription(cellID string) string { return "Kodus Runtime claim root " + cellID }

type systemdUnit struct {
	Name, Description, Slice, ControlGroup, ActiveState string
	Transient, Delegate, StopWhenUnneeded               bool
	CPUAccounting, MemoryAccounting, TasksAccounting    bool
	MemoryMax, MemorySwapMax, TasksMax                  uint64
	CPUQuotaPerSecUSec, CPUQuotaPeriodUSec              uint64
}
type systemdBus interface {
	Version(context.Context) (string, error)
	Unit(context.Context, string) (systemdUnit, error)
	List(context.Context, string) ([]string, error)
	Start(context.Context, systemdUnit) error
	Stop(context.Context, string) error
	Close() error
}

// Systemd configures resource units exclusively over one persistent D-Bus
// connection. Kernel descriptors are read-only, apart from their lifetime flock.
type Systemd struct {
	mu                        sync.Mutex
	bus                       systemdBus
	root                      directory
	rootSlice, cellID, parent string
	verifyRoot                func() error
	readPID                   func(int) (string, error)
	closed                    bool
}

var _ Lifecycle = (*Systemd)(nil)

const systemdOperationTimeout = 10 * time.Second

func newSystemd(bus systemdBus, root directory, rootSlice, cellID string, verifyRoot func() error, readPID func(int) (string, error)) (*Systemd, error) {
	if cellID == "" || len(cellID) > 128 || strings.ContainsAny(cellID, "\r\n\x00") || rootSlice != RootSliceName(cellID) {
		return nil, fmt.Errorf("%w: generated owned root slice required", ErrUnavailable)
	}
	m := &Systemd{bus: bus, root: root, rootSlice: rootSlice, cellID: cellID, parent: "/" + rootSlice, verifyRoot: verifyRoot, readPID: readPID}
	ctx, cancel := context.WithTimeout(context.Background(), systemdOperationTimeout)
	defer cancel()
	version, err := bus.Version(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: systemd version: %w", ErrUnavailable, err)
	}
	major := strings.FieldsFunc(version, func(r rune) bool { return r < '0' || r > '9' })
	if len(major) == 0 {
		return nil, fmt.Errorf("%w: unrecognized systemd version", ErrUnavailable)
	}
	v, err := strconv.Atoi(major[0])
	if err != nil || v < 244 {
		return nil, fmt.Errorf("%w: systemd 244 or newer required", ErrUnavailable)
	}
	if err = m.guard(ctx); err != nil {
		return nil, err
	}
	return m, nil
}
func (m *Systemd) guard(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if m.closed {
		return fmt.Errorf("%w: closed", ErrUnavailable)
	}
	if err := m.verifyRoot(); err != nil {
		return fmt.Errorf("%w: root identity changed: %w", ErrUnavailable, err)
	}
	u, err := m.bus.Unit(ctx, m.rootSlice)
	if err != nil {
		return fmt.Errorf("%w: root slice: %w", ErrUnavailable, err)
	}
	if u.Name != m.rootSlice || u.Description != RootSliceDescription(m.cellID) || u.ControlGroup != m.parent || u.ActiveState != "active" || u.Delegate {
		return fmt.Errorf("%w: foreign or inactive root slice", ErrUnavailable)
	}
	return emptyProcesses(m.root)
}
func (m *Systemd) name(key string) string {
	return strings.TrimSuffix(m.rootSlice, ".slice") + "-" + key + ".slice"
}
func (m *Systemd) description(key string, l Limits) string {
	h := sha256.Sum256([]byte(fmt.Sprintf("%d:%d:%d:%d", l.MemoryBytes, l.CPUQuota, l.CPUPeriod, l.Pids)))
	return RootSliceDescription(m.cellID) + " claim " + key + " budget " + hex.EncodeToString(h[:])
}
func (m *Systemd) expected(key string, l Limits) (systemdUnit, error) {
	if err := validKey(key); err != nil {
		return systemdUnit{}, err
	}
	if _, err := l.values(); err != nil {
		return systemdUnit{}, err
	}
	if l.CPUQuota > math.MaxInt64/1000000 || l.CPUQuota*1000000%l.CPUPeriod != 0 {
		return systemdUnit{}, fmt.Errorf("%w: CPU ceiling is not exactly representable", ErrUnavailable)
	}
	name := m.name(key)
	return systemdUnit{Name: name, Description: m.description(key, l), Slice: m.rootSlice, ControlGroup: path.Join(m.parent, name), ActiveState: "active", Transient: true, CPUAccounting: true, MemoryAccounting: true, TasksAccounting: true, MemoryMax: uint64(l.MemoryBytes), TasksMax: uint64(l.Pids), CPUQuotaPerSecUSec: uint64(l.CPUQuota * 1000000 / l.CPUPeriod), CPUQuotaPeriodUSec: uint64(l.CPUPeriod)}, nil
}
func sameSystemdUnit(u, want systemdUnit) bool { return u == want }
func limitsFromSystemd(u systemdUnit) (Limits, error) {
	if u.MemoryMax > math.MaxInt64 || u.TasksMax > math.MaxInt64 || u.CPUQuotaPerSecUSec > math.MaxInt64/1000000 || u.CPUQuotaPeriodUSec > 1000000 || u.CPUQuotaPeriodUSec < 1000 {
		return Limits{}, ErrUnavailable
	}
	q := u.CPUQuotaPerSecUSec * u.CPUQuotaPeriodUSec
	if q%1000000 != 0 || q/1000000 > math.MaxInt64 {
		return Limits{}, ErrUnavailable
	}
	l := Limits{MemoryBytes: int64(u.MemoryMax), CPUQuota: int64(q / 1000000), CPUPeriod: int64(u.CPUQuotaPeriodUSec), Pids: int64(u.TasksMax)}
	_, err := l.values()
	return l, err
}
func (m *Systemd) validateUnit(key string, u systemdUnit) (Limits, error) {
	l, err := limitsFromSystemd(u)
	if err != nil {
		return Limits{}, fmt.Errorf("%w: invalid persisted ceiling", ErrUnavailable)
	}
	want, err := m.expected(key, l)
	if err != nil {
		return Limits{}, err
	}
	if !sameSystemdUnit(u, want) {
		return Limits{}, fmt.Errorf("%w: foreign or changed resource unit", ErrUnavailable)
	}
	return l, nil
}
func (m *Systemd) readback(name string, l Limits) error {
	g, err := m.root.Open(name)
	if err != nil {
		return fmt.Errorf("%w: kernel child: %w", ErrUnavailable, err)
	}
	defer g.Close()
	if err = emptyProcesses(g); err != nil {
		return fmt.Errorf("%w: slice contains direct processes: %w", ErrUnavailable, err)
	}
	values, _ := l.values()
	for _, n := range []string{"memory.max", "memory.swap.max", "cpu.max", "pids.max"} {
		v, e := g.Read(n)
		if e != nil || strings.Join(strings.Fields(v), " ") != values[n] {
			return fmt.Errorf("%w: kernel %s mismatch: %w", ErrUnavailable, n, e)
		}
	}
	return nil
}
func (m *Systemd) Ensure(key string, l Limits) (string, error) {
	want, err := m.expected(key, l)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), systemdOperationTimeout)
	defer cancel()
	if err = m.guard(ctx); err != nil {
		return "", err
	}
	u, err := m.bus.Unit(ctx, want.Name)
	if errors.Is(err, fs.ErrNotExist) {
		if err = m.bus.Start(ctx, want); err != nil {
			return "", fmt.Errorf("%w: create slice: %w", ErrUnavailable, err)
		}
		u, err = m.bus.Unit(ctx, want.Name)
	}
	if err != nil {
		return "", fmt.Errorf("%w: inspect slice: %w", ErrUnavailable, err)
	}
	if !sameSystemdUnit(u, want) {
		return "", fmt.Errorf("%w: existing unit differs from requested ownership/ceiling", ErrUnavailable)
	}
	if err = m.readback(want.Name, l); err != nil {
		return "", err
	}
	return want.Name, nil
}
func (m *Systemd) Verify(key string, pid int) error {
	if err := validKey(key); err != nil {
		return err
	}
	if pid <= 0 {
		return fmt.Errorf("%w: missing container pid", ErrUnavailable)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), systemdOperationTimeout)
	defer cancel()
	if err := m.guard(ctx); err != nil {
		return err
	}
	u, err := m.bus.Unit(ctx, m.name(key))
	if err != nil {
		return fmt.Errorf("%w: inspect PID unit: %w", ErrUnavailable, err)
	}
	l, err := m.validateUnit(key, u)
	if err != nil {
		return err
	}
	if err = m.readback(u.Name, l); err != nil {
		return err
	}
	raw, err := m.readPID(pid)
	if err != nil {
		return fmt.Errorf("%w: PID membership: %w", ErrUnavailable, err)
	}
	return verifyMembership(u.ControlGroup, raw)
}
func (m *Systemd) Remove(key string) error {
	if err := validKey(key); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), systemdOperationTimeout)
	defer cancel()
	return m.removeLocked(ctx, key)
}
func (m *Systemd) removeLocked(ctx context.Context, key string) error {
	if err := m.guard(ctx); err != nil {
		return err
	}
	name := m.name(key)
	u, err := m.bus.Unit(ctx, name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%w: inspect removal: %w", ErrUnavailable, err)
	}
	l, err := m.validateUnit(key, u)
	if err != nil {
		return err
	}
	if err = m.readback(name, l); err != nil {
		return err
	}
	g, err := m.root.Open(name)
	if err != nil {
		return fmt.Errorf("%w: removal kernel state: %w", ErrUnavailable, err)
	}
	raw, e := g.Read("cgroup.events")
	cerr := g.Close()
	if e != nil || cerr != nil {
		return fmt.Errorf("%w: removal state: %w", ErrUnavailable, errors.Join(e, cerr))
	}
	if !unpopulated(raw) {
		return fmt.Errorf("%w: %w", ErrUnavailable, errPopulated)
	}
	if err = m.bus.Stop(ctx, name); err != nil {
		return fmt.Errorf("%w: stop empty slice: %w", ErrUnavailable, err)
	}
	_, err = m.bus.Unit(ctx, name)
	if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w: stopped slice not absent", ErrUnavailable)
	}
	return nil
}
func unpopulated(raw string) bool {
	for _, line := range strings.Split(raw, "\n") {
		p := strings.Fields(line)
		if len(p) == 2 && p[0] == "populated" {
			return p[1] == "0"
		}
	}
	return false
}
func (m *Systemd) managedNames(ctx context.Context) ([]string, error) {
	names, err := m.bus.List(ctx, strings.TrimSuffix(m.rootSlice, ".slice")+"-*.slice")
	if err != nil {
		return nil, err
	}
	if len(names) > maxDirectoryEntries {
		return nil, fmt.Errorf("%w: too many resource units", ErrUnavailable)
	}
	prefix := strings.TrimSuffix(m.rootSlice, ".slice") + "-"
	var out []string
	for _, name := range names {
		if strings.HasPrefix(name, prefix) && strings.HasSuffix(name, ".slice") && keyPattern.MatchString(strings.TrimSuffix(strings.TrimPrefix(name, prefix), ".slice")) {
			out = append(out, name)
		}
	}
	return out, nil
}
func (m *Systemd) PruneEmpty() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), systemdOperationTimeout)
	defer cancel()
	if err := m.guard(ctx); err != nil {
		return err
	}
	names, err := m.managedNames(ctx)
	if err != nil {
		return err
	}
	prefix := strings.TrimSuffix(m.rootSlice, ".slice") + "-"
	var all []error
	for _, name := range names {
		key := strings.TrimSuffix(strings.TrimPrefix(name, prefix), ".slice")
		if err := ctx.Err(); err != nil {
			return errors.Join(append(all, err)...)
		}
		e := m.removeLocked(ctx, key)
		if e != nil && !errors.Is(e, errPopulated) {
			all = append(all, e)
		}
	}
	return errors.Join(all...)
}
func (m *Systemd) RequireEmpty() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), systemdOperationTimeout)
	defer cancel()
	if err := m.guard(ctx); err != nil {
		return err
	}
	names, err := m.managedNames(ctx)
	if err != nil {
		return err
	}
	if len(names) > 0 {
		return fmt.Errorf("%w: surviving managed slices require drain/reaper before restart", ErrUnavailable)
	}
	raw, err := m.root.Read("cgroup.events")
	if err != nil || !unpopulated(raw) {
		return fmt.Errorf("%w: populated or unreadable root cannot start fresh admission: %w", ErrUnavailable, err)
	}
	return nil
}
func (m *Systemd) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil
	}
	m.closed = true
	return errors.Join(m.root.Close(), m.bus.Close())
}
