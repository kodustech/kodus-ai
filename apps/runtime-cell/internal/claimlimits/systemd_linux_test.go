//go:build linux

package claimlimits

import (
	"context"
	"errors"
	systemdbus "github.com/coreos/go-systemd/v22/dbus"
	dbus "github.com/godbus/dbus/v5"
	"testing"
)

func TestNativeSystemdJobNeedsCompletedJobBeforeSuccess(t *testing.T) {
	for _, result := range []string{"done", "failed", "cancelled", "timeout", "dependency", ""} {
		ch := make(chan string, 1)
		ch <- result
		err := awaitSystemdJob(context.Background(), ch)
		if (err == nil) != (result == "done") {
			t.Fatalf("result=%q err=%v", result, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := awaitSystemdJob(ctx, make(chan string)); !errors.Is(err, context.Canceled) {
		t.Fatalf("unbounded job wait: %v", err)
	}
}
func TestNativeSystemdRejectsForeignRootBeforeDialOrFilesystemAccess(t *testing.T) {
	if _, err := NewSystemd(context.Background(), "system.slice", "cell-1"); err == nil {
		t.Fatal("foreign system unit accepted")
	}
	for _, root := range []string{"/sys/fs/cgroup", "/tmp/kodus123456789abc.slice", "/sys/fs/cgroup/../evil", "/sys/fs/cgroup/system.slice", "/sys/fs/cgroup/kodus123456789abc.slice/descendant"} {
		if d, err := openSystemdRoot(root); err == nil {
			d.Close()
			t.Fatalf("accepted root %q", root)
		}
	}
}

func TestNativeSliceWritesOnlySupportedResourceProperties(t *testing.T) {
	m, _, _ := fakeSystemd(t)
	want, err := m.expected(testKey, testLimits)
	if err != nil {
		t.Fatal(err)
	}
	props := sliceProperties(want)
	values := map[string]any{}
	for _, p := range props {
		values[p.Name] = p.Value.Value()
	}
	for _, forbidden := range []string{"Slice", "Delegate", "Transient", "ControlGroup", "ActiveState"} {
		if _, ok := values[forbidden]; ok {
			t.Fatalf("unsupported/read-only property written: %s", forbidden)
		}
	}
	if len(values) != 10 || values["MemorySwapMax"] != uint64(0) || values["MemoryMax"] != uint64(testLimits.MemoryBytes) || values["CPUQuotaPerSecUSec"] != uint64(500000) || values["CPUQuotaPeriodUSec"] != uint64(testLimits.CPUPeriod) || values["TasksMax"] != uint64(testLimits.Pids) {
		t.Fatalf("properties=%v", values)
	}
}

type fakePropertyReader struct {
	common, resource map[string]any
	cpu              any
	hiddenReads      int
	fail             error
}

func (f *fakePropertyReader) GetUnitPropertiesContext(context.Context, string) (map[string]any, error) {
	return f.common, nil
}
func (f *fakePropertyReader) GetUnitTypePropertiesContext(_ context.Context, _ string, kind string) (map[string]any, error) {
	if kind != "Slice" {
		return nil, errors.New("wrong unit interface")
	}
	return f.resource, nil
}
func (f *fakePropertyReader) GetUnitTypePropertyContext(_ context.Context, _, kind, name string) (*systemdbus.Property, error) {
	f.hiddenReads++
	if f.fail != nil {
		return nil, f.fail
	}
	if kind != "Slice" || name != "CPUAccounting" {
		return nil, errors.New("wrong property")
	}
	return &systemdbus.Property{Name: name, Value: dbus.MakeVariant(f.cpu)}, nil
}
func TestNativeExplicitResourceInterfaceAndHiddenAccountingReadback(t *testing.T) {
	r := &fakePropertyReader{common: map[string]any{}, resource: map[string]any{}, cpu: true}
	for k, v := range systemdPropertiesFixture() {
		switch k {
		case "Id", "Description", "Transient", "StopWhenUnneeded", "ActiveState":
			r.common[k] = v
		default:
			r.resource[k] = v
		}
	}
	delete(r.resource, "CPUAccounting")
	p, err := readSystemdProperties(context.Background(), r, "owned.slice")
	if err != nil {
		t.Fatal(err)
	}
	u, err := decodeSystemdUnit(p)
	if err != nil || !u.CPUAccounting || r.hiddenReads != 1 {
		t.Fatalf("unit=%+v reads=%d err=%v", u, r.hiddenReads, err)
	}
	r.fail = errors.New("property unavailable")
	if _, err = readSystemdProperties(context.Background(), r, "owned.slice"); err == nil {
		t.Fatal("missing hidden accounting silently defaulted")
	}
	r.fail = nil
	r.cpu = "true"
	p, err = readSystemdProperties(context.Background(), r, "owned.slice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = decodeSystemdUnit(p); err == nil {
		t.Fatal("hidden accounting coerced")
	}
}
