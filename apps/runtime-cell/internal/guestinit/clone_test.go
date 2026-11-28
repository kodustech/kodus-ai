package guestinit

import (
	"bytes"
	"errors"
	"io/fs"
	"net/netip"
	"slices"
	"strings"
	"testing"
	"time"
)

// cloneKernel records what init asks, in order, and plays a guest whose
// boot_id reads the file bound over it.
type cloneKernel struct {
	calls  []string
	files  map[string]string
	binds  map[string]string
	procs  []Proc
	frozen bool
	clock  int64
	seed   []byte
	fail   string
}

func newCloneKernel() *cloneKernel {
	return &cloneKernel{
		files: map[string]string{BootIDPath: "6b3c2d1e-0000-4000-8000-000000000000\n", MachineIDPath: "", systemdSeedFile: "old seed"},
		binds: map[string]string{},
	}
}

func (k *cloneKernel) did(s string) error {
	k.calls = append(k.calls, s)
	if k.fail != "" && strings.HasPrefix(s, k.fail) {
		return errors.New("refused by the kernel")
	}
	return nil
}

func (k *cloneKernel) AddEntropy(b []byte) error  { k.seed = b; return k.did("entropy") }
func (k *cloneKernel) SetClock(ns int64) error    { k.clock = ns; return k.did("clock") }
func (k *cloneKernel) Now() int64                 { return k.clock }
func (k *cloneKernel) Sethostname(n string) error { return k.did("hostname " + n) }
func (k *cloneKernel) Exists(p string) bool       { _, ok := k.files[p]; return ok }
func (k *cloneKernel) Remove(p string) error      { delete(k.files, p); return k.did("remove " + p) }
func (k *cloneKernel) Processes() ([]Proc, error) { return k.procs, nil }
func (k *cloneKernel) WriteInPlace(p string, d []byte) error {
	k.files[p] = string(d)
	return k.did("write " + p)
}

func (k *cloneKernel) Bind(src, dst string) error {
	k.binds[dst] = src
	return k.did("bind " + dst)
}

func (k *cloneKernel) ReadFile(p string) ([]byte, error) {
	if src, ok := k.binds[p]; ok {
		p = src
	}
	v, ok := k.files[p]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return []byte(v), nil
}

func (k *cloneKernel) ConfigureNet(iface string, n NetConfig) error {
	return k.did("net " + iface + " " + n.MAC + " " + n.IP.String())
}

func (k *cloneKernel) Freeze(cg string, frozen bool) error {
	if err := k.did(map[bool]string{true: "freeze ", false: "thaw "}[frozen] + cg); err != nil {
		return err
	}
	k.frozen = frozen
	return nil
}

func rebirth() Rebirth {
	return Rebirth{
		Seed: bytes.Repeat([]byte{7}, SeedBytes), UnixNano: time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC).UnixNano(),
		Hostname: "kfc-1a2b", BootID: "0f1e2d3c-4b5a-4968-8776-655443322110", MachineID: strings.Repeat("ab", 16),
		Net: &NetConfig{MAC: "06:00:0a:d5:04:81", IP: netip.MustParseAddr("10.213.4.129"), Prefix: 24, Gateway: netip.MustParseAddr("10.213.4.1")},
		DNS: netip.MustParseAddr("10.212.255.1"),
	}
}

func newClone(k *cloneKernel, p Profile) (*Clone, *string) {
	var resolv string
	return &Clone{K: k, Profile: p, ServerPID: func() int { return 40 }, Resolv: func(b []byte) error { resolv = string(b); return nil }}, &resolv
}

// A restored machine takes the host's randomness before anything else,
// then the host's clock, its own names, its own address and resolver, and
// only then its workload runs again: no process of the workload ever runs
// on the snapshot's random state, clock or address. Its boot_id reads the
// new one even though the snapshot's kernel had generated its own.
func TestARestoredMachineReseedsAndTakesItsIDsBeforeItsWorkloadRuns(t *testing.T) {
	k := newCloneKernel()
	c, resolv := newClone(k, SandboxProfile)
	if rep := c.Handle(ControlRequest{Op: OpPrepare, Purpose: "template"}, time.Now()); !rep.OK || !k.frozen {
		t.Fatalf("prepare: %+v frozen %v", rep, k.frozen)
	}
	if k.Exists(systemdSeedFile) {
		t.Fatal("the init system's seed file went into the snapshot")
	}
	k.calls = nil
	r := rebirth()
	readAt := time.Now().Add(-30 * time.Millisecond)
	rep := c.Handle(ControlRequest{Op: OpRebirth, Rebirth: &r}, readAt)
	if !rep.OK || rep.BootID != r.BootID {
		t.Fatalf("rebirth: %+v", rep)
	}
	want := []string{
		"entropy", "clock", "hostname kfc-1a2b",
		"write " + BootIDFile, "bind " + BootIDPath, "write " + MachineIDFile, "bind " + MachineIDPath,
		"net eth0 06:00:0a:d5:04:81 10.213.4.129", "thaw " + WorkloadCgroup,
	}
	if !slices.Equal(k.calls, want) {
		t.Fatalf("init did\n%s\nwant\n%s", strings.Join(k.calls, "\n"), strings.Join(want, "\n"))
	}
	if !bytes.Equal(k.seed, r.Seed) || k.frozen {
		t.Fatalf("seed %x frozen %v", k.seed, k.frozen)
	}
	if lag := time.Duration(k.clock - r.UnixNano); lag < 30*time.Millisecond || lag > time.Second {
		t.Fatalf("the clock was set %v after the host's, not the time since the request was read", lag)
	}
	if got, _ := k.ReadFile(BootIDPath); strings.TrimSpace(string(got)) != r.BootID {
		t.Fatalf("boot_id reads %q", got)
	}
	if !strings.Contains(*resolv, "nameserver 10.212.255.1") {
		t.Fatalf("resolver %q", *resolv)
	}
}

// A rebirth that cannot reseed, set the clock or take its address leaves
// the workload frozen: the cell ends a machine that answers with an error,
// and nothing ran on the snapshot's state meanwhile.
func TestARebirthThatFailsLeavesTheWorkloadFrozen(t *testing.T) {
	for _, step := range []string{"entropy", "clock", "net"} {
		k := newCloneKernel()
		c, _ := newClone(k, SandboxProfile)
		_ = c.Handle(ControlRequest{Op: OpPrepare, Purpose: "template"}, time.Now())
		k.fail = step
		r := rebirth()
		if rep := c.Handle(ControlRequest{Op: OpRebirth, Rebirth: &r}, time.Now()); rep.OK || !k.frozen {
			t.Errorf("%s failed: %+v, frozen %v", step, rep, k.frozen)
		}
	}
}

// A sandbox becomes a template only while nothing of its workload runs:
// a process left behind by a command would carry its own random state into
// every machine restored from it. The refusal names it and leaves the
// sandbox running. A session, restored once, keeps its processes; an
// environment runs its system by design.
func TestASandboxWithAWorkloadProcessIsNeverSnapshotted(t *testing.T) {
	k := newCloneKernel()
	k.procs = []Proc{{PID: 1}, {PID: 2}, {PID: 9, PPID: 2, Comm: "kworker/0:1"}, {PID: 40, PPID: 1, Comm: "kody-guest"}, {PID: 77, PPID: 1, Comm: "python3"}}
	c, _ := newClone(k, SandboxProfile)
	rep := c.Handle(ControlRequest{Op: OpPrepare, Purpose: "template"}, time.Now())
	if rep.OK || !strings.Contains(rep.Error, "python3(77)") || k.frozen {
		t.Fatalf("prepare with a workload process: %+v frozen %v", rep, k.frozen)
	}
	for _, p := range []string{"session", "round"} {
		if rep := c.Handle(ControlRequest{Op: OpPrepare, Purpose: p}, time.Now()); !rep.OK || !k.frozen {
			t.Fatalf("a %s keeps its processes: %+v", p, rep)
		}
		_ = c.Handle(ControlRequest{Op: OpThaw}, time.Now())
	}
	if rep := c.Handle(ControlRequest{Op: OpPrepare}, time.Now()); rep.OK {
		t.Fatal("a prepare for no purpose")
	}
	env, _ := newClone(k, EnvironmentProfile)
	if rep := env.Handle(ControlRequest{Op: OpPrepare, Purpose: "template"}, time.Now()); !rep.OK || !k.frozen {
		t.Fatalf("an environment's prepare: %+v", rep)
	}
	if rep := env.Handle(ControlRequest{Op: OpThaw}, time.Now()); !rep.OK || k.frozen {
		t.Fatalf("thaw: %+v", rep)
	}
}

// A rebirth init could not apply as given is refused before it touches
// anything.
func TestARebirthOutOfShapeIsRefused(t *testing.T) {
	for name, mut := range map[string]func(*Rebirth){
		"short seed":         func(r *Rebirth) { r.Seed = r.Seed[:16] },
		"no clock":           func(r *Rebirth) { r.UnixNano = 0 },
		"hostname":           func(r *Rebirth) { r.Hostname = "Bad_Host" },
		"boot id":            func(r *Rebirth) { r.BootID = "not-a-uuid" },
		"machine id":         func(r *Rebirth) { r.MachineID = "xyz" },
		"multicast MAC":      func(r *Rebirth) { r.Net.MAC = "01:00:0a:d5:04:81" },
		"gateway off subnet": func(r *Rebirth) { r.Net.Gateway = netip.MustParseAddr("10.9.9.1") },
		"IPv6 resolver":      func(r *Rebirth) { r.DNS = netip.MustParseAddr("::1") },
	} {
		k := newCloneKernel()
		c, _ := newClone(k, SandboxProfile)
		r := rebirth()
		mut(&r)
		if rep := c.Handle(ControlRequest{Op: OpRebirth, Rebirth: &r}, time.Now()); rep.OK || len(k.calls) != 0 {
			t.Errorf("%s: %+v after %v", name, rep, k.calls)
		}
	}
}

// One control message is a bounded line of known fields, either way.
func TestControlMessagesAreBoundedLinesOfKnownFields(t *testing.T) {
	var buf bytes.Buffer
	r := rebirth()
	if err := WriteControl(&buf, ControlRequest{Op: OpRebirth, Rebirth: &r}); err != nil {
		t.Fatal(err)
	}
	var got ControlRequest
	if err := ReadControl(&buf, &got); err != nil || got.Rebirth == nil || got.Rebirth.BootID != r.BootID || !bytes.Equal(got.Rebirth.Seed, r.Seed) || got.Rebirth.Net.IP != r.Net.IP {
		t.Fatalf("read back %+v %v", got, err)
	}
	if err := ReadControl(strings.NewReader(`{"op":"prepare","extra":1}`+"\n"), &got); err == nil {
		t.Fatal("an unknown field was read")
	}
	if err := ReadControl(strings.NewReader(`{"op":"`+strings.Repeat("x", maxControl)+`"}`+"\n"), &got); err == nil {
		t.Fatal("an unbounded message was read")
	}
}

// /proc/<pid>/stat is read from its last parenthesis: a command's name may
// carry spaces and parentheses.
func TestAProcessNameWithParenthesesIsRead(t *testing.T) {
	p, ok := parseStat(77, "77 (evil) 1 (x) S 1 77 77 0 -1")
	if !ok || p.PPID != 1 || p.Comm != "evil) 1 (x" {
		t.Fatalf("%+v %v", p, ok)
	}
}
