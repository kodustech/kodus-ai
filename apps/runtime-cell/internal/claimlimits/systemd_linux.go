//go:build linux

package claimlimits

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	systemdbus "github.com/coreos/go-systemd/v22/dbus"
	dbus "github.com/godbus/dbus/v5"
	"golang.org/x/sys/unix"
)

type nativeSystemdBus struct {
	conn   *systemdbus.Conn
	raw    *dbus.Conn
	cancel context.CancelFunc
}

// NewSystemd opens an explicitly provisioned owned root. It creates no root,
// changes no daemon and holds the kernel root inode lock until Close.
func NewSystemd(ctx context.Context, rootSlice, cellID string) (Lifecycle, error) {
	if rootSlice != RootSliceName(cellID) {
		return nil, fmt.Errorf("%w: generated root slice required", ErrUnavailable)
	}
	b, err := connectSystemd(ctx)
	if err != nil {
		return nil, err
	}
	closeBus := true
	defer func() {
		if closeBus {
			b.Close()
		}
	}()
	deadline, cancel := context.WithTimeout(ctx, systemdOperationTimeout)
	defer cancel()
	u, err := b.Unit(deadline, rootSlice)
	if err != nil || u.Name != rootSlice || u.Description != RootSliceDescription(cellID) || u.ControlGroup != "/"+rootSlice || u.ActiveState != "active" || u.Delegate {
		return nil, fmt.Errorf("%w: owned root slice not active: %w", ErrUnavailable, err)
	}
	rootPath := cgroupMount + u.ControlGroup
	d, err := openSystemdRoot(rootPath)
	if err != nil {
		return nil, err
	}
	closeRoot := true
	defer func() {
		if closeRoot {
			d.Close()
		}
	}()
	if err = lockRoot(d); err != nil {
		return nil, err
	}
	verify := func() error {
		current, e := openSystemdRoot(rootPath)
		if e != nil {
			return e
		}
		defer current.Close()
		old, e := d.file.Stat()
		if e != nil {
			return e
		}
		now, e := current.file.Stat()
		if e != nil {
			return e
		}
		if !os.SameFile(old, now) {
			return errors.New("root inode replaced")
		}
		return nil
	}
	m, err := newSystemd(b, d, rootSlice, cellID, verify, readProcessCgroup)
	if err != nil {
		return nil, err
	}
	closeRoot = false
	closeBus = false
	return m, nil
}

func openSystemdRoot(root string) (*localDirectory, error) {
	if filepath.Clean(root) != root || !strings.HasPrefix(root, cgroupMount+"/kodus") || filepath.Dir(root) != cgroupMount {
		return nil, ErrUnavailable
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range strings.Split(strings.TrimPrefix(root, "/"), "/") {
		next, e := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		unix.Close(fd)
		if e != nil {
			return nil, fmt.Errorf("%w: open systemd kernel root: %w", ErrUnavailable, e)
		}
		fd = next
	}
	d := &localDirectory{os.NewFile(uintptr(fd), "claimlimits-systemd-root")}
	var st unix.Statfs_t
	var owner unix.Stat_t
	if unix.Fstatfs(fd, &st) != nil || uint64(st.Type) != uint64(unix.CGROUP2_SUPER_MAGIC) || unix.Fstat(fd, &owner) != nil || owner.Mode&0022 != 0 || owner.Uid != 0 {
		d.Close()
		return nil, fmt.Errorf("%w: root-owned cgroup v2 directory required", ErrUnavailable)
	}
	return d, nil
}

func connectSystemd(parent context.Context) (*nativeSystemdBus, error) {
	lifetime, cancel := context.WithCancel(parent)
	out := make(chan *nativeSystemdBus)
	errs := make(chan error, 1)
	go func() {
		var raw *dbus.Conn
		conn, err := systemdbus.NewConnection(func() (*dbus.Conn, error) {
			c, e := dbus.SystemBusPrivate(dbus.WithContext(lifetime))
			if e != nil {
				return nil, e
			}
			if e = c.Auth([]dbus.Auth{dbus.AuthExternal(strconv.Itoa(os.Getuid()))}); e == nil {
				e = c.Hello()
			}
			if e != nil {
				c.Close()
				return nil, e
			}
			if raw == nil {
				raw = c
			}
			return c, nil
		})
		if err != nil {
			errs <- err
			return
		}
		b := &nativeSystemdBus{conn: conn, raw: raw, cancel: cancel}
		select {
		case <-lifetime.Done():
			b.Close()
		case out <- b:
		}
	}()
	timer := time.NewTimer(systemdOperationTimeout)
	defer timer.Stop()
	select {
	case b := <-out:
		return b, nil
	case err := <-errs:
		cancel()
		return nil, fmt.Errorf("%w: system D-Bus: %w", ErrUnavailable, err)
	case <-parent.Done():
		cancel()
		return nil, parent.Err()
	case <-timer.C:
		cancel()
		return nil, fmt.Errorf("%w: system D-Bus connection timed out", ErrUnavailable)
	}
}
func (b *nativeSystemdBus) Close() error { b.cancel(); b.conn.Close(); return nil }
func (b *nativeSystemdBus) Version(ctx context.Context) (string, error) {
	var v dbus.Variant
	err := b.raw.Object("org.freedesktop.systemd1", "/org/freedesktop/systemd1").CallWithContext(ctx, "org.freedesktop.DBus.Properties.Get", 0, "org.freedesktop.systemd1.Manager", "Version").Store(&v)
	if err != nil {
		return "", err
	}
	s, ok := v.Value().(string)
	if !ok {
		return "", ErrUnavailable
	}
	return s, nil
}
func (b *nativeSystemdBus) Unit(ctx context.Context, name string) (systemdUnit, error) {
	p, err := readSystemdProperties(ctx, b.conn, name)
	if err != nil {
		var e dbus.Error
		if errors.As(err, &e) && (e.Name == "org.freedesktop.systemd1.NoSuchUnit" || e.Name == "org.freedesktop.DBus.Error.UnknownObject") {
			return systemdUnit{}, fs.ErrNotExist
		}
		return systemdUnit{}, err
	}
	return decodeNativeSystemdUnit(name, p)
}

type systemdPropertyReader interface {
	GetUnitPropertiesContext(context.Context, string) (map[string]any, error)
	GetUnitTypePropertiesContext(context.Context, string, string) (map[string]any, error)
	GetUnitTypePropertyContext(context.Context, string, string, string) (*systemdbus.Property, error)
}

func readSystemdProperties(ctx context.Context, r systemdPropertyReader, name string) (map[string]any, error) {
	common, err := r.GetUnitPropertiesContext(ctx, name)
	if err != nil {
		return nil, err
	}
	resource, err := r.GetUnitTypePropertiesContext(ctx, name, "Slice")
	if err != nil {
		return nil, err
	}
	merged := make(map[string]any, len(common)+len(resource)+1)
	for k, v := range common {
		merged[k] = v
	}
	for k, v := range resource {
		merged[k] = v
	}
	// Newer managers hide the deprecated always-on CPUAccounting property from
	// GetAll. Read it individually rather than assuming accounting was enabled.
	if _, ok := merged["CPUAccounting"]; !ok {
		property, err := r.GetUnitTypePropertyContext(ctx, name, "Slice", "CPUAccounting")
		if err != nil {
			return nil, err
		}
		if property == nil {
			return nil, ErrUnavailable
		}
		merged["CPUAccounting"] = property.Value.Value()
	}
	return merged, nil
}

func (b *nativeSystemdBus) List(ctx context.Context, pattern string) ([]string, error) {
	units, err := b.conn.ListUnitsByPatternsContext(ctx, nil, []string{pattern})
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(units))
	for _, u := range units {
		out = append(out, u.Name)
	}
	return out, nil
}
func sliceProperties(u systemdUnit) []systemdbus.Property {
	props := []systemdbus.Property{}
	for _, p := range []struct {
		name  string
		value any
	}{
		{"Description", u.Description}, {"StopWhenUnneeded", false},
		{"CPUAccounting", true}, {"MemoryAccounting", true}, {"TasksAccounting", true},
		{"MemoryMax", u.MemoryMax}, {"MemorySwapMax", uint64(0)}, {"TasksMax", u.TasksMax},
		{"CPUQuotaPerSecUSec", u.CPUQuotaPerSecUSec}, {"CPUQuotaPeriodUSec", u.CPUQuotaPeriodUSec},
	} {
		props = append(props, systemdbus.Property{Name: p.name, Value: dbus.MakeVariant(p.value)})
	}
	return props
}

func (b *nativeSystemdBus) Start(ctx context.Context, u systemdUnit) error {
	done := make(chan string, 1)
	if _, err := b.conn.StartTransientUnitContext(ctx, u.Name, "fail", sliceProperties(u), done); err != nil {
		return err
	}
	return awaitSystemdJob(ctx, done)
}
func (b *nativeSystemdBus) Stop(ctx context.Context, name string) error {
	done := make(chan string, 1)
	if _, err := b.conn.StopUnitContext(ctx, name, "replace", done); err != nil {
		return err
	}
	if err := awaitSystemdJob(ctx, done); err != nil {
		return err
	}
	// Transient units may remain loaded briefly after their stop job finishes.
	timer := time.NewTicker(10 * time.Millisecond)
	defer timer.Stop()
	for {
		if _, err := b.Unit(ctx, name); errors.Is(err, fs.ErrNotExist) {
			return nil
		} else if err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
}
func awaitSystemdJob(ctx context.Context, done <-chan string) error {
	select {
	case result := <-done:
		if result != "done" {
			return fmt.Errorf("systemd job did not complete: %s", result)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
