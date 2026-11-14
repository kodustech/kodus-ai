package claimlimits

import (
	"context"
	"errors"
	"io/fs"
	"strings"
	"testing"
)

func systemdPropertiesFixture() map[string]any {
	return map[string]any{
		"Id": "kodus0123456789ab.slice", "Description": "owned", "Slice": "-.slice", "ControlGroup": "/kodus0123456789ab.slice", "ActiveState": "active",
		"Transient": false, "StopWhenUnneeded": false, "CPUAccounting": true, "MemoryAccounting": true, "TasksAccounting": true,
		"MemoryMax": uint64(1024), "MemorySwapMax": uint64(0), "TasksMax": uint64(10), "CPUQuotaPerSecUSec": uint64(500000), "CPUQuotaPeriodUSec": uint64(100000),
	}
}
func TestSystemdPropertiesRequireExactTypesAndAllResourceCeilings(t *testing.T) {
	p := systemdPropertiesFixture()
	got, err := decodeSystemdUnit(p)
	if err != nil || got.Name != p["Id"] || got.MemoryMax != 1024 || got.Delegate {
		t.Fatalf("unit=%+v err=%v", got, err)
	}
	for k := range p {
		t.Run(k, func(t *testing.T) {
			q := systemdPropertiesFixture()
			delete(q, k)
			if _, err := decodeSystemdUnit(q); err == nil {
				t.Fatal("omitted property accepted")
			}
			q[k] = struct{}{}
			if _, err := decodeSystemdUnit(q); err == nil {
				t.Fatal("wrong type accepted")
			}
		})
	}
	p["MemoryMax"] = int64(1024)
	if _, err := decodeSystemdUnit(p); err == nil {
		t.Fatal("numeric coercion accepted")
	}
	p = systemdPropertiesFixture()
	p["Delegate"] = "false"
	if _, err := decodeSystemdUnit(p); err == nil {
		t.Fatal("malformed optional delegation accepted")
	}
	p["Delegate"] = true
	got, err = decodeSystemdUnit(p)
	if err != nil || !got.Delegate {
		t.Fatal("delegation lost before ownership validation")
	}
}
func TestSystemdLifecycleRefusesLostRootClosedBusWrongMembershipAndUnsupportedVersion(t *testing.T) {
	m, b, r := fakeSystemd(t)
	m.verifyRoot = func() error { return errors.New("root inode changed") }
	if _, err := m.Ensure(testKey, testLimits); err == nil || len(b.starts) != 0 {
		t.Fatal("changed kernel root reached mutation")
	}
	m.verifyRoot = func() error { return nil }
	name, err := m.Ensure(testKey, testLimits)
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"", "0::/unrelated/child\n", "0::" + b.units[name].ControlGroup + "\n", "0::" + b.units[name].ControlGroup + "-foreign/child\n"} {
		m.readPID = func(int) (string, error) { return raw, nil }
		if err = m.Verify(testKey, 23); err == nil {
			t.Fatalf("accepted membership %q", raw)
		}
	}
	r.dirs[name].files["cgroup.procs"] = "12\n"
	if err = m.Remove(testKey); err == nil || len(b.stops) != 0 {
		t.Fatal("stopped slice with direct processes")
	}
	if err = m.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Ensure(testKey, testLimits); err == nil {
		t.Fatal("closed manager accepted ensure")
	}
	if err = m.RequireEmpty(); err == nil {
		t.Fatal("closed manager accepted startup")
	}
	for _, v := range []string{"243", "garbage"} {
		b.version = v
		if _, err := newSystemd(b, r, RootSliceName("cell-1"), "cell-1", func() error { return nil }, nil); err == nil {
			t.Fatalf("accepted version %q", v)
		}
	}
}
func TestSystemdPruneRetainsPopulatedClaimsAndReportsBusFailure(t *testing.T) {
	m, b, r := fakeSystemd(t)
	name, err := m.Ensure(testKey, testLimits)
	if err != nil {
		t.Fatal(err)
	}
	r.dirs[name].files["cgroup.events"] = "populated 1\n"
	if err = m.PruneEmpty(); err != nil || len(b.stops) != 0 {
		t.Fatalf("prune=%v stops=%v", err, b.stops)
	}
	if err = m.RequireEmpty(); err == nil {
		t.Fatal("startup ignored populated old claim")
	}
	r.dirs[name].files["cgroup.events"] = "populated 0\n"
	b.stopErr = errors.New("bus offline")
	if err = m.PruneEmpty(); err == nil {
		t.Fatal("stop failure ignored")
	}
	b.listErr = errors.New("list failed")
	if err = m.PruneEmpty(); err == nil {
		t.Fatal("list failure ignored")
	}
	if err = m.RequireEmpty(); err == nil {
		t.Fatal("startup ignored list failure")
	}
	b.listErr = nil
	b.stopErr = nil
	if _, err = m.Ensure(strings.Repeat("f", 64), Limits{MemoryBytes: 1, CPUQuota: 1001, CPUPeriod: 3000, Pids: 1}); err == nil {
		t.Fatal("unrepresentable exact CPU quota accepted")
	}
	// Native operations must share one bounded startup context.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err = m.removeLocked(ctx, testKey); err == nil { // Fake bus does not honor context; kernel guard below tests it explicitly.
		// removeLocked must refuse before any call when deadline already expired.
		t.Fatal("expired startup operation executed")
	}
}

func TestSystemdStartupRefusesUnexpectedPopulatedDescendant(t *testing.T) {
	m, _, r := fakeSystemd(t)
	r.files["cgroup.events"] = "populated 1\n"
	if err := m.RequireEmpty(); err == nil {
		t.Fatal("fresh admission ignored populated foreign descendant")
	}
}

// systemd materializes inactive implicit slices when their object is read.
// This is not an existing configured/transient unit that Ensure may overwrite.
func TestNativeImplicitSliceIsAbsentButConfiguredForeignUnitsRemain(t *testing.T) {
	name := "kodus0123456789ab-" + testKey + ".slice"
	fixture := func() map[string]any {
		p := systemdPropertiesFixture()
		p["Id"] = name
		p["ActiveState"] = "inactive"
		p["Transient"] = false
		p["ControlGroup"] = ""
		p["FragmentPath"] = ""
		p["SourcePath"] = ""
		p["DropInPaths"] = []string{}
		p["LoadState"] = "loaded"
		return p
	}
	if _, err := decodeNativeSystemdUnit(name, fixture()); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("implicit slice cannot be created: %v", err)
	}
	for _, change := range []func(map[string]any){
		func(p map[string]any) { p["FragmentPath"] = "/etc/systemd/system/foreign.slice" },
		func(p map[string]any) { p["SourcePath"] = "/run/generated/foreign" },
		func(p map[string]any) { p["DropInPaths"] = []string{"/run/systemd/system/unit.d/resource.conf"} },
		func(p map[string]any) { p["ActiveState"] = "active" },
		func(p map[string]any) { p["Transient"] = true },
		func(p map[string]any) { p["ControlGroup"] = "/foreign" },
		func(p map[string]any) { p["LoadState"] = "error" },
		func(p map[string]any) { delete(p, "FragmentPath") },
		func(p map[string]any) { p["DropInPaths"] = "" },
		func(p map[string]any) { p["Id"] = "another.slice" },
	} {
		p := fixture()
		change(p)
		if _, err := decodeNativeSystemdUnit(name, p); errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("foreign or unknown unit treated absent: %v", p)
		}
	}
	if _, err := decodeNativeSystemdUnit("foreign.slice", fixture()); errors.Is(err, fs.ErrNotExist) {
		t.Fatal("nongenerated unit treated as owned implicit unit")
	}
}
