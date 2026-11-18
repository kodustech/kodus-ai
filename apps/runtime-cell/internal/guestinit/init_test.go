package guestinit

import (
	"encoding/json"
	"io/fs"
	"net/netip"
	"slices"
	"strings"
	"testing"
)

// bootKernel is the kernel as it hands over to init: the image's files and
// programs, no /proc until init mounts it, and no PATH anywhere but in what
// init gives a program.
type bootKernel struct {
	files   map[string][]byte
	bins    []string
	mounted map[string]bool
	ext4    map[string]bool
	ran     []string // resolved path and args of every program run or started
	started []Process
}

func newBootKernel(t *testing.T, p Profile, b Boot) *bootKernel {
	t.Helper()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	return &bootKernel{
		files: map[string][]byte{
			ProfilePath: raw, "/proc/cmdline": []byte("reboot=k panic=1 pci=off root=/dev/vda init=" + AgentPath + " " + b.Cmdline()),
			CgroupRoot + "/cgroup.controllers": []byte("cpuset cpu io memory pids\n"),
		},
		bins:    []string{AgentPath, "/usr/sbin/mkfs.ext4", "/usr/bin/dockerd"},
		mounted: map[string]bool{"/": true},
		ext4:    map[string]bool{},
	}
}

func (k *bootKernel) Mount(m Mount) error { k.mounted[m.Target] = true; return nil }

func (k *bootKernel) ReadFile(path string) ([]byte, error) {
	if strings.HasPrefix(path, "/proc/") && !k.mounted["/proc"] {
		return nil, fs.ErrNotExist
	}
	b, ok := k.files[path]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return b, nil
}

func (k *bootKernel) WriteFile(path string, data []byte) error { k.files[path] = data; return nil }
func (k *bootKernel) MkdirAll(string, fs.FileMode) error       { return nil }
func (k *bootKernel) Sethostname(string) error                 { return nil }
func (k *bootKernel) LinkUp(string) error                      { return nil }
func (k *bootKernel) HasExt4(dev string) (bool, error)         { return k.ext4[dev], nil }
func (k *bootKernel) IsExecutable(path string) bool            { return slices.Contains(k.bins, path) }

func (k *bootKernel) exec(p Process) error {
	path, err := p.Path(k.IsExecutable)
	if err != nil {
		return err
	}
	k.ran = append(k.ran, strings.Join(append([]string{path}, p.Args...), " "))
	return nil
}

func (k *bootKernel) Run(p Process) ([]byte, error) {
	if err := k.exec(p); err != nil {
		return nil, err
	}
	if p.Name == "mkfs.ext4" {
		k.ext4[p.Args[len(p.Args)-1]] = true
	}
	return nil, nil
}

func (k *bootKernel) Start(p Process) (int, error) {
	if err := k.exec(p); err != nil {
		return 0, err
	}
	k.started = append(k.started, p)
	return 100 + len(k.started), nil
}

// An environment machine comes up from what the kernel hands init: its
// blank data disk formatted, dockerd and the guest agent's server started
// as root. It used to die before any of it: the agent asked /proc/self/exe
// for its own path before /proc was mounted, and with that fixed it ran
// mkfs.ext4 by PID 1's PATH, which the kernel does not set.
func TestAnEnvironmentMachineComesUpFromAKernelThatGaveInitNoProcAndNoPath(t *testing.T) {
	b := Boot{Hostname: "kfc-0a1b", DNS: netip.MustParseAddr("10.212.255.1"), Port: 1024, TmpMB: 512}
	k := newBootKernel(t, EnvironmentProfile, b)
	m, err := Setup(k)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"/usr/sbin/mkfs.ext4 -q -F -L kody-data /dev/vdb",
		"/usr/bin/dockerd " + strings.Join(DockerdArgs(), " "),
		AgentPath + " -vsock 1024 -root /workspace",
	}
	if !slices.Equal(k.ran, want) {
		t.Fatalf("init ran\n%s\nwant\n%s", strings.Join(k.ran, "\n"), strings.Join(want, "\n"))
	}
	if m.ServerPID == 0 || m.Server.UID != 0 || !k.mounted[DataMount] || !k.mounted["/workspace"] {
		t.Fatalf("server %+v, mounts %v", m, k.mounted)
	}
	if got := string(k.files[ResolvPath]); !strings.Contains(got, "nameserver 10.212.255.1") {
		t.Fatalf("resolver file %q", got)
	}
	assertTheWorkloadIsFreezable(t, k)
}

// Everything init starts runs in the workload's cgroup, which delegates
// every controller to Docker's containers under it: a snapshot's freeze of
// that one cgroup stops the whole workload and leaves init.
func assertTheWorkloadIsFreezable(t *testing.T, k *bootKernel) {
	t.Helper()
	for _, p := range k.started {
		if p.Cgroup != AgentCgroup {
			t.Errorf("%s starts in cgroup %q, not the workload's", p.Name, p.Cgroup)
		}
	}
	for _, d := range []string{CgroupRoot, CgroupRoot + "/" + WorkloadCgroup} {
		if got := string(k.files[d+"/cgroup.subtree_control"]); got != "+cpuset +cpu +io +memory +pids" {
			t.Errorf("%s delegates %q", d, got)
		}
	}
	if !strings.Contains(strings.Join(DockerdArgs(), " "), "--cgroup-parent /"+DockerCgroup) {
		t.Errorf("dockerd's containers are not under the workload: %v", DockerdArgs())
	}
}

// A sandbox's server runs as its user with no_new_privs, and a data disk
// that already holds a file system keeps it: the next boot of an
// environment never formats it again.
func TestASandboxServesAsItsUserAndADataDiskIsFormattedOnlyOnce(t *testing.T) {
	b := Boot{Hostname: "kfc-0a1b", Port: 1024, WorkspaceMB: 256, TmpMB: 512}
	k := newBootKernel(t, SandboxProfile, b)
	m, err := Setup(k)
	if err != nil {
		t.Fatal(err)
	}
	if len(k.started) != 1 || m.Server.UID != 1000 || m.Server.GID != 1000 || !m.Server.NoNewPrivs || m.Server.Name != AgentPath {
		t.Fatalf("a sandbox started %+v", k.started)
	}
	assertTheWorkloadIsFreezable(t, k)
	env := newBootKernel(t, EnvironmentProfile, Boot{Hostname: "kfc-0a1b", Port: 1024, TmpMB: 512})
	env.ext4["/dev/vdb"] = true
	if _, err := Setup(env); err != nil {
		t.Fatal(err)
	}
	for _, r := range env.ran {
		if strings.Contains(r, "mkfs") {
			t.Fatalf("a formatted data disk was formatted again: %v", env.ran)
		}
	}
}

// A program init starts is found in the PATH init gives it, never in init's
// own environment, and a program the image does not have stops the boot
// naming it.
func TestAProgramIsFoundInThePathInitGivesIt(t *testing.T) {
	isExec := func(p string) bool { return p == "/usr/sbin/mkfs.ext4" }
	t.Setenv("PATH", "/usr/sbin") // init's own, which a program must not need
	if got, err := (Process{Name: "mkfs.ext4", Env: Env("/root")}).Path(isExec); err != nil || got != "/usr/sbin/mkfs.ext4" {
		t.Fatalf("with the PATH init gives: %q %v", got, err)
	}
	if _, err := (Process{Name: "mkfs.ext4"}).Path(isExec); err == nil {
		t.Fatal("found with no PATH of its own")
	}
	if _, err := (Process{Name: "dockerd", Env: Env("/root")}).Path(isExec); err == nil || !strings.Contains(err.Error(), "dockerd") {
		t.Fatalf("a missing program: %v", err)
	}
}
