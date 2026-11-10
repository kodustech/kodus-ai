package claimlimits

import (
	"context"
	"errors"
	"io/fs"
	"reflect"
	"strings"
	"testing"
)

type fakeSystemdBus struct {
	units                      map[string]systemdUnit
	root                       *fakeDirectory
	starts, stops              []string
	version                    string
	startErr, stopErr, listErr error
	alter                      func(*systemdUnit)
	closed                     bool
}

func fakeSystemd(t *testing.T) (*Systemd, *fakeSystemdBus, *fakeDirectory) {
	t.Helper()
	root := fakeRoot()
	root.files["cgroup.events"] = "populated 0\n"
	name := RootSliceName("cell-1")
	b := &fakeSystemdBus{units: map[string]systemdUnit{name: {Name: name, Description: RootSliceDescription("cell-1"), ControlGroup: "/" + name, ActiveState: "active"}}, root: root, version: "259.9"}
	m, err := newSystemd(b, root, name, "cell-1", func() error { return nil }, func(int) (string, error) {
		return "0::/" + name + "/" + strings.TrimSuffix(name, ".slice") + "-" + testKey + ".slice/docker-child\n", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return m, b, root
}
func (b *fakeSystemdBus) Version(context.Context) (string, error) { return b.version, nil }
func (b *fakeSystemdBus) Unit(_ context.Context, n string) (systemdUnit, error) {
	u, ok := b.units[n]
	if !ok {
		return u, fs.ErrNotExist
	}
	return u, nil
}
func (b *fakeSystemdBus) List(_ context.Context, _ string) ([]string, error) {
	if b.listErr != nil {
		return nil, b.listErr
	}
	var out []string
	for n := range b.units {
		out = append(out, n)
	}
	return out, nil
}
func (b *fakeSystemdBus) Start(_ context.Context, u systemdUnit) error {
	b.starts = append(b.starts, u.Name)
	if b.startErr != nil {
		return b.startErr
	}
	if b.alter != nil {
		b.alter(&u)
	}
	b.units[u.Name] = u
	g := fakeRoot()
	g.files["cgroup.events"] = "populated 0\n"
	l := Limits{MemoryBytes: int64(u.MemoryMax), CPUQuota: int64(u.CPUQuotaPerSecUSec) * int64(u.CPUQuotaPeriodUSec) / 1000000, CPUPeriod: int64(u.CPUQuotaPeriodUSec), Pids: int64(u.TasksMax)}
	vals, _ := l.values()
	for k, v := range vals {
		g.files[k] = v
	}
	b.root.dirs[u.Name] = g
	return nil
}
func (b *fakeSystemdBus) Stop(_ context.Context, n string) error {
	b.stops = append(b.stops, n)
	if b.stopErr != nil {
		return b.stopErr
	}
	delete(b.units, n)
	delete(b.root.dirs, n)
	return nil
}
func (b *fakeSystemdBus) Close() error { b.closed = true; return nil }

func TestSystemdCreatesOwnedSliceAndVerifiesKernelWithoutFilesystemWrites(t *testing.T) {
	m, b, r := fakeSystemd(t)
	got, err := m.Ensure(testKey, testLimits)
	if err != nil {
		t.Fatal(err)
	}
	want := strings.TrimSuffix(RootSliceName("cell-1"), ".slice") + "-" + testKey + ".slice"
	if got != want || len(b.starts) != 1 {
		t.Fatalf("parent=%q starts=%v", got, b.starts)
	}
	if err = m.Verify(testKey, 12); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Ensure(testKey, testLimits); err != nil {
		t.Fatal(err)
	}
	if len(b.starts) != 1 {
		t.Fatal("existing slice started twice")
	}
	if len(r.writes) != 0 || len(r.dirs[want].writes) != 0 {
		t.Fatal("controller wrote systemd cgroupfs")
	}
	if err = m.RequireEmpty(); err == nil {
		t.Fatal("fresh ledger accepted old managed unit")
	}
	if err = m.Remove(testKey); err != nil {
		t.Fatal(err)
	}
	if err = m.RequireEmpty(); err != nil {
		t.Fatal(err)
	}
	if err = m.Close(); err != nil || !b.closed {
		t.Fatalf("close=%v", err)
	}
}
func TestSystemdRefusesChangedCeilingsAndForeignUnitsBeforeMutation(t *testing.T) {
	changes := []func(*systemdUnit){func(u *systemdUnit) { u.Description = "foreign" }, func(u *systemdUnit) { u.Slice = "system.slice" }, func(u *systemdUnit) { u.MemoryMax++ }, func(u *systemdUnit) { u.MemorySwapMax = 1 }, func(u *systemdUnit) { u.TasksMax++ }, func(u *systemdUnit) { u.CPUQuotaPerSecUSec++ }, func(u *systemdUnit) { u.CPUQuotaPeriodUSec++ }, func(u *systemdUnit) { u.Transient = false }, func(u *systemdUnit) { u.Delegate = true }, func(u *systemdUnit) { u.MemoryAccounting = false }, func(u *systemdUnit) { u.StopWhenUnneeded = true }, func(u *systemdUnit) { u.ControlGroup = "/foreign" }}
	for i, change := range changes {
		t.Run(string(rune('a'+i)), func(t *testing.T) {
			m, b, _ := fakeSystemd(t)
			name, err := m.Ensure(testKey, testLimits)
			if err != nil {
				t.Fatal(err)
			}
			u := b.units[name]
			change(&u)
			b.units[name] = u
			before := len(b.starts)
			if _, err = m.Ensure(testKey, testLimits); err == nil {
				t.Fatal("changed/foreign unit accepted")
			}
			if len(b.starts) != before {
				t.Fatal("silently reconfigured existing slice")
			}
			if err = m.Remove(testKey); err == nil {
				t.Fatal("removed foreign/mismatched unit")
			}
		})
	}
}
func TestSystemdReadbackRootAndPopulatedRemovalFailClosed(t *testing.T) {
	m, b, r := fakeSystemd(t)
	name, err := m.Ensure(testKey, testLimits)
	if err != nil {
		t.Fatal(err)
	}
	r.dirs[name].files["cpu.max"] = "max 100000"
	if _, err = m.Ensure(testKey, testLimits); err == nil {
		t.Fatal("kernel mismatch accepted")
	}
	r.dirs[name].files["cpu.max"] = "50000 100000"
	r.dirs[name].files["cgroup.events"] = "populated 1\n"
	if err = m.Remove(testKey); err == nil || len(b.stops) != 0 {
		t.Fatal("stopped populated slice")
	}
	u := b.units[m.rootSlice]
	u.Description = "changed root"
	b.units[m.rootSlice] = u
	if _, err = m.Ensure(testKey, testLimits); err == nil {
		t.Fatal("root replacement accepted")
	}
}
func TestSystemdFailureAndPruningRemainScoped(t *testing.T) {
	m, b, r := fakeSystemd(t)
	b.startErr = errors.New("bus denied")
	if _, err := m.Ensure(testKey, testLimits); err == nil {
		t.Fatal("failed create became success")
	}
	b.startErr = nil
	name, err := m.Ensure(testKey, testLimits)
	if err != nil {
		t.Fatal(err)
	}
	b.units["unrelated.service"] = systemdUnit{Name: "unrelated.service"}
	if err = m.PruneEmpty(); err != nil {
		t.Fatal(err)
	}
	if _, ok := b.units["unrelated.service"]; !ok {
		t.Fatal("foreign unit pruned")
	}
	if !reflect.DeepEqual(b.stops, []string{name}) {
		t.Fatalf("stops=%v", b.stops)
	}
	if len(r.writes) > 0 {
		t.Fatal("direct resource writes")
	}
}
func TestDockerParentAllowsOnlyGeneratedSystemdNames(t *testing.T) {
	for _, n := range []string{"", "/delegated/cell/abc", strings.TrimSuffix(RootSliceName("cell-1"), ".slice") + "-" + testKey + ".slice"} {
		if err := ValidateDockerParent(n); err != nil {
			t.Fatalf("%q: %v", n, err)
		}
	}
	for _, n := range []string{"system.slice", "evil.slice", "kodus-" + testKey + ".slice", "/", "../x", "/a/../b", "kodusabcdef123456-" + testKey + ".slice/evil"} {
		if err := ValidateDockerParent(n); err == nil {
			t.Errorf("accepted %q", n)
		}
	}
}
