package vmsnap

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// A machine that was handed the org's secrets, a credential or canaries
// never becomes a snapshot of any kind; a template comes only from a
// setup's machine that never ran a PR's code; a pooled machine never; and
// the org is the machine's own, never the caller's.
func TestOnlyACleanSetupMachineOfTheOrgBecomesATemplate(t *testing.T) {
	setup := Facts{Org: "org-a", Setup: true}
	if err := Admit(setup, isolation.PurposeTemplate, "org-a"); err != nil {
		t.Fatalf("a clean setup machine: %v", err)
	}
	for name, c := range map[string]struct {
		f       Facts
		purpose Purpose
		org     string
	}{
		"secrets, template":     {Facts{Org: "org-a", Setup: true, Taints: []isolation.Taint{isolation.TaintSecrets}}, isolation.PurposeTemplate, "org-a"},
		"secrets, session":      {Facts{Org: "org-a", Taints: []isolation.Taint{isolation.TaintSecrets}}, isolation.PurposeSession, "org-a"},
		"credentials, session":  {Facts{Org: "org-a", Taints: []isolation.Taint{isolation.TaintCredentials}}, isolation.PurposeSession, "org-a"},
		"canaries, session":     {Facts{Org: "org-a", Taints: []isolation.Taint{isolation.TaintCanaries}}, isolation.PurposeSession, "org-a"},
		"PR code, template":     {Facts{Org: "org-a", Setup: true, Taints: []isolation.Taint{isolation.TaintPRCode}}, isolation.PurposeTemplate, "org-a"},
		"not a setup, template": {Facts{Org: "org-a"}, isolation.PurposeTemplate, "org-a"},
		"pooled, session":       {Facts{Org: "org-a", Pool: true}, isolation.PurposeSession, "org-a"},
		"another org":           {setup, isolation.PurposeTemplate, "org-b"},
		"no org":                {Facts{Setup: true}, isolation.PurposeTemplate, ""},
		"unknown purpose":       {setup, "fork", "org-a"},
	} {
		if err := Admit(c.f, c.purpose, c.org); !errors.Is(err, ErrRefused) {
			t.Errorf("%s: admitted (%v)", name, err)
		}
	}
	if err := Admit(Facts{Org: "org-a", Taints: []isolation.Taint{isolation.TaintPRCode}}, isolation.PurposeSession, "org-a"); err != nil {
		t.Fatalf("a PR's machine set aside for itself: %v", err)
	}
}

// The fingerprint changes with the CPU, its microcode, the host kernel or
// the VMM, and reads only the first processor.
func TestTheHostFingerprintChangesWithWhatFirecrackerNeedsTheSame(t *testing.T) {
	cpu := "processor\t: 0\nvendor_id\t: GenuineIntel\nmodel name\t: Xeon 6975P-C\nmicrocode\t: 0x1\nflags\t\t: fpu vmx\ncpu MHz\t\t: 2400.1\n\nprocessor\t: 1\nmodel name\t: Other\n"
	base := HostFingerprint([]byte(cpu), "7.0.0-1014-aws", "b33f")
	if HostFingerprint([]byte(strings.Replace(cpu, "2400.1", "3100.0", 1)), "7.0.0-1014-aws", "b33f") != base {
		t.Fatal("the clock speed changed the fingerprint")
	}
	if HostFingerprint([]byte(strings.Replace(cpu, "Other", "Changed", 1)), "7.0.0-1014-aws", "b33f") != base {
		t.Fatal("the second processor changed the fingerprint")
	}
	for name, fp := range map[string]string{
		"microcode": HostFingerprint([]byte(strings.Replace(cpu, "0x1", "0x2", 1)), "7.0.0-1014-aws", "b33f"),
		"flags":     HostFingerprint([]byte(strings.Replace(cpu, "fpu vmx", "fpu", 1)), "7.0.0-1014-aws", "b33f"),
		"kernel":    HostFingerprint([]byte(cpu), "6.8.0", "b33f"),
		"vmm":       HostFingerprint([]byte(cpu), "7.0.0-1014-aws", "c44a"),
	} {
		if fp == base {
			t.Errorf("a new %s keeps the fingerprint", name)
		}
	}
}

func stage(t *testing.T, s *Store, org string, shape isolation.Shape, purpose Purpose) Manifest {
	t.Helper()
	id, dir, err := s.Stage(org)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range filesOf(shape) {
		body := []byte("state of " + id)
		if name == FileMem {
			body = make([]byte, 128<<20)
			body[0] = 1
		}
		if err := os.WriteFile(filepath.Join(dir, name), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	m, err := s.Publish(dir, Manifest{
		ID: id, Org: org, Purpose: purpose, Shape: shape, Created: time.Now().UTC(), Source: "kodus-c-workload",
		MemoryMB: 128, VCPUs: 1, Kit: "sha256:kit", Host: "host-1", RootBase: "base-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.Chown = func(string, int, int) error { return nil }
	return s
}

// A published snapshot opens for its org only, under its own id, with its
// memory file readable by the VMM users and nothing else writable; a
// directory without a manifest is no snapshot.
func TestASnapshotOpensOnlyForItsOrg(t *testing.T) {
	s := newStore(t)
	m := stage(t, s, "org-a", isolation.ShapeSandbox, isolation.PurposeTemplate)
	got, dir, err := s.Open("org-a", m.ID)
	if err != nil || got.ID != m.ID || got.Files[FileMem].Size != 128<<20 {
		t.Fatalf("open: %+v %v", got, err)
	}
	if fi, _ := os.Stat(filepath.Join(dir, FileMem)); fi.Mode().Perm() != 0o444 {
		t.Fatalf("memory file mode %v", fi.Mode())
	}
	if fi, _ := os.Stat(filepath.Join(dir, FileState)); fi.Mode().Perm() != 0o400 {
		t.Fatalf("state file mode %v", fi.Mode())
	}
	if _, _, err := s.Open("org-b", m.ID); !errors.Is(err, ErrRefused) {
		t.Fatalf("another org opened it: %v", err)
	}
	if _, _, err := s.Open("org-a", "../"+m.ID); !errors.Is(err, ErrRefused) {
		t.Fatalf("a path for an id: %v", err)
	}
	id, _, err := s.Stage("org-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Open("org-a", id); !errors.Is(err, ErrRefused) {
		t.Fatalf("an unfinished snapshot opened: %v", err)
	}
}

// A file changed after it was published is refused: the state file is read
// back every time, the memory file by its size and time, and by its digest
// on the first open of a process that did not publish it.
func TestASnapshotWhoseFilesChangedIsRefused(t *testing.T) {
	s := newStore(t)
	m := stage(t, s, "org-a", isolation.ShapeEnvironment, isolation.PurposeTemplate)
	_, dir, err := s.Open("org-a", m.ID)
	if err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(dir, FileState)
	fi, _ := os.Stat(state)
	_ = os.Chmod(state, 0o600)
	body := []byte(strings.Repeat("x", int(fi.Size())))
	if err := os.WriteFile(state, body, 0o600); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(state, fi.ModTime(), fi.ModTime())
	if _, _, err := s.Open("org-a", m.ID); !errors.Is(err, ErrRefused) {
		t.Fatalf("a rewritten state file of the same size and time: %v", err)
	}

	m = stage(t, s, "org-a", isolation.ShapeSandbox, isolation.PurposeTemplate)
	mem := filepath.Join(s.Dir(), OrgKey("org-a"), m.ID, FileMem)
	fi, _ = os.Stat(mem)
	_ = os.Chmod(mem, 0o600)
	f, _ := os.OpenFile(mem, os.O_WRONLY, 0)
	_, _ = f.WriteAt([]byte{9}, 4096)
	_ = f.Close()
	_ = os.Chtimes(mem, fi.ModTime(), fi.ModTime())
	if _, _, err := s.Open("org-a", m.ID); err != nil {
		t.Fatalf("the process that published it trusts its own digest: %v", err)
	}
	restarted, _ := NewStore(s.Dir())
	if _, _, err := restarted.Open("org-a", m.ID); !errors.Is(err, ErrRefused) {
		t.Fatalf("a cell that restarted restored a changed memory file: %v", err)
	}
	_ = os.Chtimes(mem, time.Now(), time.Now())
	if _, _, err := s.Open("org-a", m.ID); !errors.Is(err, ErrRefused) {
		t.Fatalf("a memory file touched since it was published: %v", err)
	}
}

// A session restores once: the second claim finds nothing, and a template
// is never claimed (it stays for every restore).
func TestASessionRestoresOnce(t *testing.T) {
	s := newStore(t)
	m := stage(t, s, "org-a", isolation.ShapeSandbox, isolation.PurposeSession)
	if _, _, err := s.Claim("org-a", m.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Claim("org-a", m.ID); !errors.Is(err, ErrRefused) {
		t.Fatalf("claimed twice: %v", err)
	}
	if _, _, err := s.Open("org-a", m.ID); !errors.Is(err, ErrRefused) {
		t.Fatalf("a claimed session opened: %v", err)
	}
	tpl := stage(t, s, "org-a", isolation.ShapeSandbox, isolation.PurposeTemplate)
	if _, _, err := s.Claim("org-a", tpl.ID); !errors.Is(err, ErrRefused) {
		t.Fatalf("a template claimed: %v", err)
	}
	if _, _, err := s.Open("org-a", tpl.ID); err != nil {
		t.Fatalf("a template after a refused claim: %v", err)
	}
}

// A snapshot restores only on the kit, host and base it was taken on, and
// into a machine of its shape.
func TestASnapshotRestoresOnlyWhereItWasTaken(t *testing.T) {
	m := Manifest{ID: "ksn-1", Shape: isolation.ShapeSandbox, Kit: "k1", Host: "h1", RootBase: "b1"}
	here := Here{Kit: "k1", Host: "h1", Bases: []string{"b1"}}
	if err := m.Restorable(here, isolation.ShapeSandbox); err != nil {
		t.Fatal(err)
	}
	for name, h := range map[string]Here{"kit": {Kit: "k2", Host: "h1", Bases: []string{"b1"}}, "host": {Kit: "k1", Host: "h2", Bases: []string{"b1"}}, "base": {Kit: "k1", Host: "h1", Bases: []string{"b2"}}} {
		if err := m.Restorable(h, isolation.ShapeSandbox); !errors.Is(err, ErrRefused) {
			t.Errorf("another %s: %v", name, err)
		}
	}
	if err := m.Restorable(here, isolation.ShapeEnvironment); !errors.Is(err, ErrRefused) {
		t.Fatal("a sandbox's snapshot restored as an environment")
	}
}

// Sweep removes old sessions and templates, unfinished snapshots, what
// another kit or host took, and the oldest over a bound; Room refuses a
// snapshot that would take an org over its bound.
func TestSweepKeepsTheStoreWithinItsPolicy(t *testing.T) {
	s := newStore(t)
	old := stage(t, s, "org-a", isolation.ShapeSandbox, isolation.PurposeSession)
	keep := stage(t, s, "org-a", isolation.ShapeSandbox, isolation.PurposeTemplate)
	other := stage(t, s, "org-b", isolation.ShapeSandbox, isolation.PurposeTemplate)
	_, partial, _ := s.Stage("org-a")
	past := time.Now().Add(-time.Hour)
	_ = os.Chtimes(partial, past, past)
	now := time.Now().Add(2 * time.Hour)
	gone, err := s.Sweep(now, Policy{SessionTTL: time.Hour, TemplateTTL: 24 * time.Hour, Here: Here{Kit: "sha256:kit", Host: "host-1"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(gone) != 2 || !contains(gone, old.ID) || !contains(gone, filepath.Base(partial)) {
		t.Fatalf("gone %v", gone)
	}
	if _, _, err := s.Open("org-a", keep.ID); err != nil {
		t.Fatalf("a fresh template went: %v", err)
	}
	gone, _ = s.Sweep(now, Policy{Here: Here{Kit: "sha256:new-kit"}})
	if len(gone) != 2 || !contains(gone, keep.ID) || !contains(gone, other.ID) {
		t.Fatalf("a new kit retired %v", gone)
	}

	a1 := stage(t, s, "org-a", isolation.ShapeSandbox, isolation.PurposeTemplate)
	a2 := stage(t, s, "org-a", isolation.ShapeSandbox, isolation.PurposeTemplate)
	used, _ := s.Usage("org-a")
	if used <= 0 {
		t.Skip("this file system reports no blocks")
	}
	if err := s.Room("org-a", used, Policy{MaxOrgBytes: used + used/4}); !errors.Is(err, ErrRefused) {
		t.Fatalf("an org over its bytes: %v", err)
	}
	if err := s.Room("org-b", used/4, Policy{MaxOrgBytes: used}); err != nil {
		t.Fatalf("another org counted: %v", err)
	}
	gone, _ = s.Sweep(time.Now(), Policy{MaxOrgBytes: used * 3 / 4})
	if len(gone) != 1 || gone[0] != a1.ID {
		t.Fatalf("over its bytes, the oldest goes first: %v (a1 %s a2 %s)", gone, a1.ID, a2.ID)
	}
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// A sparse disk is read for its data only, and a byte written into one of
// its holes since it was published is still refused.
func TestASparseDiskWrittenInAHoleIsRefused(t *testing.T) {
	s := newStore(t)
	m := stage(t, s, "org-a", isolation.ShapeEnvironment, isolation.PurposeTemplate)
	dir := filepath.Join(s.Dir(), OrgKey("org-a"), m.ID)
	data := filepath.Join(dir, FileData)
	_ = os.Chmod(data, 0o600)
	if err := os.Truncate(data, 1<<30); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(filepath.Join(dir, manifestName))
	m, err := s.Publish(dir, m)
	if err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(data)
	_ = os.Chmod(data, 0o600)
	f, _ := os.OpenFile(data, os.O_WRONLY, 0)
	_, _ = f.WriteAt([]byte{1}, 512<<20)
	_ = f.Close()
	_ = os.Chtimes(data, fi.ModTime(), fi.ModTime())
	restarted, _ := NewStore(s.Dir())
	if _, _, err := restarted.Open("org-a", m.ID); !errors.Is(err, ErrRefused) {
		t.Fatalf("a byte in a hole of the data disk: %v", err)
	}
}

// A round may hold what its claim was handed (it never leaves the claim),
// but a pooled machine and a machine of no claim take none, and the org is
// still the machine's own.
func TestARoundIsTheClaimsOwnWhateverItWasHanded(t *testing.T) {
	all := []isolation.Taint{isolation.TaintSecrets, isolation.TaintCredentials, isolation.TaintCanaries, isolation.TaintPRCode}
	if err := Admit(Facts{Org: "org-a", Claim: "run1", Taints: all}, isolation.PurposeRound, "org-a"); err != nil {
		t.Fatalf("a claim's round: %v", err)
	}
	for name, f := range map[string]Facts{
		"pooled":      {Org: "org-a", Claim: "run1", Pool: true},
		"no claim":    {Org: "org-a"},
		"another org": {Org: "org-b", Claim: "run1"},
	} {
		if err := Admit(f, isolation.PurposeRound, "org-a"); !errors.Is(err, ErrRefused) {
			t.Errorf("%s: %v", name, err)
		}
	}
	m := Manifest{
		Schema: Schema, ID: "ksn-0123456789abcdef0123456789abcdef", Org: "org-a", Purpose: isolation.PurposeRound, Shape: isolation.ShapeSandbox, MemoryMB: 128, VCPUs: 1, Kit: "k", Host: "h", RootBase: "b",
		Files: map[string]File{FileState: {Size: 1, SHA256: strings.Repeat("a", 64)}, FileMem: {Size: 128 << 20, SHA256: strings.Repeat("b", 64)}},
	}
	if err := m.Check("org-a", m.ID); !errors.Is(err, ErrRefused) {
		t.Fatalf("a round of no claim: %v", err)
	}
	m.Claim, m.Key = "run1", "repo:a"
	if err := m.Check("org-a", m.ID); !errors.Is(err, ErrRefused) {
		t.Fatalf("a round with a template's key: %v", err)
	}
}

// A snapshot the file system cannot hold is refused before anything is
// written: on the KVM host a round's create ran out of space halfway and
// ended the claim's machine ("No space left on device").
func TestASnapshotTheDiskCannotHoldIsRefusedFirst(t *testing.T) {
	s := newStore(t)
	s.Free = func() (int64, error) { return 5 << 30, nil }
	if err := s.Room("org-a", 4<<30, Policy{}); !errors.Is(err, ErrRefused) {
		t.Fatalf("4 GiB on 5 GiB free: %v", err)
	}
	if err := s.Room("org-a", 1<<30, Policy{}); err != nil {
		t.Fatalf("1 GiB on 5 GiB free: %v", err)
	}
}
