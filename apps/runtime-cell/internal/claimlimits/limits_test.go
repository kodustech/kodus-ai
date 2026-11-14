package claimlimits

import (
	"errors"
	"io/fs"
	"strings"
	"sync"
	"syscall"
	"testing"
)

const testKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

var testLimits = Limits{MemoryBytes: 128 << 20, CPUQuota: 50000, CPUPeriod: 100000, Pids: 64}

type fakeDirectory struct {
	listErr   error
	listNames []string
	openErr   error
	onCreate  func(*fakeDirectory)
	writeErr  string
	files     map[string]string
	dirs      map[string]*fakeDirectory
	writes    []string
	readback  string
	removeErr error
}

func fakeRoot() *fakeDirectory {
	return &fakeDirectory{files: map[string]string{"cgroup.controllers": "cpu memory pids io", "cgroup.subtree_control": "cpu memory pids", "cgroup.procs": ""}, dirs: map[string]*fakeDirectory{}}
}
func (d *fakeDirectory) Read(name string) (string, error) {
	if v, ok := d.files[name]; ok {
		return v, nil
	}
	return "", fs.ErrNotExist
}
func (d *fakeDirectory) Write(name, value string) error {
	d.writes = append(d.writes, name+"="+value)
	if d.writeErr == name {
		return fs.ErrPermission
	}
	if d.readback == name {
		return nil
	}
	if name == "cgroup.subtree_control" {
		value = "cpu memory pids"
	}
	d.files[name] = value
	return nil
}
func (d *fakeDirectory) Mkdir(name string) error {
	if _, ok := d.dirs[name]; ok {
		return fs.ErrExist
	}
	n := fakeRoot()
	n.files["cgroup.subtree_control"] = ""
	n.files["cgroup.events"] = "populated 0\nfrozen 0\n"
	if d.onCreate != nil {
		d.onCreate(n)
	}
	d.dirs[name] = n
	return nil
}
func (d *fakeDirectory) Open(name string) (directory, error) {
	if d.openErr != nil {
		return nil, d.openErr
	}
	if n, ok := d.dirs[name]; ok {
		return n, nil
	}
	return nil, fs.ErrNotExist
}
func (d *fakeDirectory) Remove(name string) error {
	if d.removeErr != nil {
		return d.removeErr
	}
	if _, ok := d.dirs[name]; !ok {
		return fs.ErrNotExist
	}
	delete(d.dirs, name)
	return nil
}
func (d *fakeDirectory) Close() error { return nil }
func (d *fakeDirectory) List() ([]string, error) {
	if d.listErr != nil {
		return nil, d.listErr
	}
	if d.listNames != nil {
		return d.listNames, nil
	}
	names := make([]string, 0, len(d.dirs))
	for name := range d.dirs {
		names = append(names, name)
	}
	return names, nil
}
func testManager(t *testing.T) (*FS, *fakeDirectory) {
	t.Helper()
	r := fakeRoot()
	f, err := newFS(r, "/delegated/cell")
	if err != nil {
		t.Fatal(err)
	}
	return f, r
}

// Before aggregate limits, independent services had no verified shared ceiling.
func TestEnsureWritesAndVerifiesWholeParentBeforeReturning(t *testing.T) {
	f, r := testManager(t)
	parent, err := f.Ensure(testKey, testLimits)
	if err != nil {
		t.Fatal(err)
	}
	if parent != "/delegated/cell/"+testKey {
		t.Fatalf("parent %q", parent)
	}
	n := r.dirs[testKey]
	for k, v := range map[string]string{"memory.max": "134217728", "memory.swap.max": "0", "cpu.max": "50000 100000", "pids.max": "64", "cgroup.subtree_control": "cpu memory pids"} {
		if n.files[k] != v {
			t.Fatalf("%s=%q, want %q", k, n.files[k], v)
		}
	}
	writes := len(n.writes)
	if _, err = f.Ensure(testKey, testLimits); err != nil {
		t.Fatal(err)
	}
	if len(n.writes) != writes {
		t.Fatal("idempotent ensure rewrote live parent")
	}
}
func TestEnsureNeverChangesExistingBudget(t *testing.T) {
	f, r := testManager(t)
	if _, err := f.Ensure(testKey, testLimits); err != nil {
		t.Fatal(err)
	}
	n := r.dirs[testKey]
	writes := len(n.writes)
	bigger := testLimits
	bigger.MemoryBytes *= 2
	if _, err := f.Ensure(testKey, bigger); err == nil {
		t.Fatal("existing parent silently enlarged")
	}
	if len(n.writes) != writes {
		t.Fatal("existing ceiling was mutated")
	}
}
func TestRefusesInvalidKeyAndLimitsWithoutCreatingDirectory(t *testing.T) {
	for _, key := range []string{"", "../escape", strings.Repeat("A", 64), strings.Repeat("a", 63), testKey + "/x"} {
		t.Run(key, func(t *testing.T) {
			f, r := testManager(t)
			if _, err := f.Ensure(key, testLimits); err == nil {
				t.Fatal("accepted invalid key")
			}
			if len(r.dirs) > 0 {
				t.Fatal("created directory before validation")
			}
		})
	}
	f, r := testManager(t)
	for _, l := range []Limits{{}, {1, 1, 100000, 1}, {1, 1000, 1, 1}, {1, 1000, 100000, 0}} {
		if _, err := f.Ensure(testKey, l); err == nil {
			t.Fatalf("accepted %+v", l)
		}
	}
	if len(r.dirs) > 0 {
		t.Fatal("created invalid budget")
	}
}
func TestPreflightRequiresDelegatedControllersAndNoProcesses(t *testing.T) {
	for _, name := range []string{"cgroup.controllers", "cgroup.subtree_control", "cgroup.procs"} {
		t.Run(name, func(t *testing.T) {
			r := fakeRoot()
			r.files[name] = "cpu memory"
			if name == "cgroup.procs" {
				r.files[name] = "123\n"
			}
			if _, err := newFS(r, "/delegated/cell"); err == nil {
				t.Fatal("accepted undelegated or occupied parent")
			}
			if len(r.writes) > 0 {
				t.Fatal("modified ancestor")
			}
		})
	}
}
func TestRemoveOnlyEmptyOwnedGroups(t *testing.T) {
	f, r := testManager(t)
	if _, err := f.Ensure(testKey, testLimits); err != nil {
		t.Fatal(err)
	}
	r.dirs[testKey].files["cgroup.events"] = "populated 1\nfrozen 0\n"
	if err := f.Remove(testKey); err == nil {
		t.Fatal("removed live parent")
	}
	r.dirs[testKey].files["cgroup.events"] = "populated 0\nfrozen 0\n"
	r.removeErr = errors.New("busy child")
	if err := f.Remove(testKey); err == nil {
		t.Fatal("ignored remaining child")
	}
	r.removeErr = nil
	if err := f.Remove(testKey); err != nil {
		t.Fatal(err)
	}
	if err := f.Remove(testKey); err != nil {
		t.Fatal("non-idempotent remove", err)
	}
	if err := f.Remove("../elsewhere"); err == nil {
		t.Fatal("accepted invalid removal")
	}
}
func TestReadbackMismatchRefusesParent(t *testing.T) {
	f, r := testManager(t)
	if err := r.Mkdir(testKey); err != nil {
		t.Fatal(err)
	}
	n := r.dirs[testKey]
	n.files["memory.max"] = "max"
	if _, err := f.Ensure(testKey, testLimits); err == nil {
		t.Fatal("adopted unverified unlimited group")
	}
}

func TestValidateParentOptionalAndStrict(t *testing.T) {
	for _, p := range []string{"", "/kodus/cell-1", "/claim_1/a.b", "/system.slice/kody-owned.service/claims"} {
		if err := ValidateParent(p); err != nil {
			t.Errorf("refused %q: %v", p, err)
		}
	}
	for _, p := range []string{"/", "relative", "/x//y", "/x/../y", "/x/./y", "/x/", "/system.slice", "/x/a.scope", "/x/a\n", "/x/" + strings.Repeat("a", 256)} {
		if err := ValidateParent(p); err == nil {
			t.Errorf("accepted unsafe %q", p)
		}
	}
	r := fakeRoot()
	if _, err := newFS(r, ""); err == nil {
		t.Fatal("accepted empty delegated root")
	}
}
func TestProcessMembershipMustBeStrictDescendant(t *testing.T) {
	p := "/delegated/cell/" + testKey
	if err := verifyMembership(p, "0::"+p+"/docker/abcdef\n"); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"", "1:cpu:" + p + "/docker", "0::" + p, "0::" + p + "-neighbor/docker", "0::" + p + "/../other", "0::" + p + "//docker", "0::" + p + "/docker\n0::" + p + "/docker2"} {
		if err := verifyMembership(p, raw); err == nil {
			t.Errorf("accepted wrong unified membership %q", raw)
		}
	}
}
func TestVerifyRefusesInvalidPIDBeforeReadingHost(t *testing.T) {
	f, _ := testManager(t)
	for _, pid := range []int{0, -1} {
		if err := f.Verify(testKey, pid); err == nil {
			t.Errorf("accepted pid %d", pid)
		}
	}
	if err := f.Verify("../x", 1); err == nil {
		t.Fatal("accepted bad key")
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Verify(testKey, 1); err == nil {
		t.Fatal("closed manager verified")
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestPruneEmptyOnlyBeforeLaunchPreservesBusyAndForeignNames(t *testing.T) {
	f, r := testManager(t)
	if _, err := f.Ensure(testKey, testLimits); err != nil {
		t.Fatal(err)
	}
	busy := strings.Repeat("a", 64)
	if _, err := f.Ensure(busy, testLimits); err != nil {
		t.Fatal(err)
	}
	r.dirs[busy].files["cgroup.events"] = "populated 1\n"
	r.dirs["foreign-directory"] = fakeRoot()
	if err := f.PruneEmpty(); err != nil {
		t.Fatal(err)
	}
	if _, ok := r.dirs[testKey]; ok {
		t.Fatal("empty generated parent leaked")
	}
	if _, ok := r.dirs[busy]; !ok {
		t.Fatal("deleted live group")
	}
	if _, ok := r.dirs["foreign-directory"]; !ok {
		t.Fatal("deleted unmanaged group")
	}
}
func TestPruneEmptyPropagatesPermissionError(t *testing.T) {
	f, r := testManager(t)
	if _, err := f.Ensure(testKey, testLimits); err != nil {
		t.Fatal(err)
	}
	r.removeErr = fs.ErrPermission
	if err := f.PruneEmpty(); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("permission error hidden: %v", err)
	}
}

func TestNewParentFailureNeverReturnsLaunchAuthority(t *testing.T) {
	for _, mode := range []string{"write-denied", "readback-mismatch"} {
		t.Run(mode, func(t *testing.T) {
			f, r := testManager(t)
			r.onCreate = func(child *fakeDirectory) {
				if mode == "write-denied" {
					child.writeErr = "memory.max"
				} else {
					child.readback = "memory.max"
				}
			}
			parent, err := f.Ensure(testKey, testLimits)
			if err == nil || parent != "" {
				t.Fatalf("authority returned after setup failure %q: %v", parent, err)
			}
			if len(r.dirs) != 0 {
				t.Fatal("failed empty generated group not cleaned")
			}
		})
	}
}
func TestConcurrentEnsureKeepsOneImmutableParent(t *testing.T) {
	f, r := testManager(t)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := f.Ensure(testKey, testLimits); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if len(r.dirs) != 1 {
		t.Fatal("duplicate group")
	}
	if len(r.dirs[testKey].writes) != 5 {
		t.Fatalf("rewrote active ceiling %d times", len(r.dirs[testKey].writes))
	}
}
func TestPruneEmptyKeepsEmptyParentWithDockerChildren(t *testing.T) {
	f, r := testManager(t)
	if _, err := f.Ensure(testKey, testLimits); err != nil {
		t.Fatal(err)
	}
	r.removeErr = syscall.ENOTEMPTY
	if err := f.PruneEmpty(); err != nil {
		t.Fatal(err)
	}
	if len(r.dirs) != 1 {
		t.Fatal("recursively deleted child tree")
	}
}
func TestClosedManagerRefusesMutation(t *testing.T) {
	f, r := testManager(t)
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Ensure(testKey, testLimits); err == nil {
		t.Fatal("closed ensure")
	}
	if err := f.Remove(testKey); err == nil {
		t.Fatal("closed removal")
	}
	if err := f.PruneEmpty(); err == nil {
		t.Fatal("closed prune")
	}
	if len(r.dirs) != 0 {
		t.Fatal("closed manager mutated")
	}
}

func TestFailureOpeningNewGroupCleansOwnedDirectory(t *testing.T) {
	f, r := testManager(t)
	r.onCreate = func(_ *fakeDirectory) { r.openErr = fs.ErrPermission }
	if _, err := f.Ensure(testKey, testLimits); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("wrong open failure: %v", err)
	}
	if len(r.dirs) != 0 {
		t.Fatal("failed-open empty group leaked")
	}
}

// A restarted cell must not advertise an empty admission ledger while the
// delegated root still owns any old container budget, populated or not.
func TestRequireEmptyRefusesRetainedManagedBudgets(t *testing.T) {
	f, r := testManager(t)
	if err := f.RequireEmpty(); err != nil {
		t.Fatal(err)
	}
	r.dirs["unmanaged-name"] = fakeRoot()
	if err := f.RequireEmpty(); err != nil {
		t.Fatalf("unmanaged directory counted as resource budget: %v", err)
	}
	if _, err := f.Ensure(testKey, testLimits); err != nil {
		t.Fatal(err)
	}
	if err := f.RequireEmpty(); err == nil {
		t.Fatal("restart forgot a retained managed budget")
	}
	r.dirs[testKey].files["cgroup.events"] = "populated 1\n"
	if err := f.RequireEmpty(); err == nil {
		t.Fatal("restart forgot a live managed budget")
	}
	r.dirs[testKey].files["cgroup.events"] = "populated 0\n"
	if err := f.Remove(testKey); err != nil {
		t.Fatal(err)
	}
	if err := f.RequireEmpty(); err != nil {
		t.Fatalf("clean delegation refused restart: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.RequireEmpty(); err == nil {
		t.Fatal("closed manager reports available")
	}
}

func TestRequireEmptyFailsClosedOnUnreadableOrUnboundedListing(t *testing.T) {
	f, r := testManager(t)
	r.listErr = fs.ErrPermission
	if err := f.RequireEmpty(); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("unreadable delegation was treated empty: %v", err)
	}
	r.listErr = nil
	r.listNames = make([]string, 4097)
	for i := range r.listNames {
		r.listNames[i] = "unmanaged"
	}
	if err := f.RequireEmpty(); err == nil {
		t.Fatal("unbounded root listing accepted")
	}
}
