package guestinit

import (
	"encoding/json"
	"net/netip"
	"strings"
	"testing"
)

// The boot values the cell writes on the kernel command line read back the
// same in the guest, whatever kernel parameters surround them.
func TestTheCommandLineTheCellWritesReadsBackAsTheSameBootValues(t *testing.T) {
	want := Boot{Hostname: "kfc-0a1b2c3d", DNS: netip.MustParseAddr("10.212.255.1"), Port: 1024, WorkspaceMB: 1024, TmpMB: 512}
	line := "console=ttyS0 reboot=k panic=1 ip=10.213.4.130::10.213.4.1:255.255.255.0::eth0:off " + want.Cmdline() + " ro"
	got, err := ParseCmdline(line)
	if err != nil || got != want {
		t.Fatalf("got %+v %v", got, err)
	}
	noWayOut := Boot{Hostname: "kfc-1", Port: 1024, TmpMB: 64}
	if got, err := ParseCmdline(noWayOut.Cmdline()); err != nil || got != noWayOut || Resolv(got) != "" {
		t.Fatalf("a machine with no resolver: %+v %v", got, err)
	}
}

// A kody parameter init does not know, or one given twice, stops the boot:
// only the cell writes them.
func TestAnUnknownOrRepeatedParameterIsRefused(t *testing.T) {
	base := Boot{Hostname: "kfc-1", Port: 1024, TmpMB: 64}.Cmdline()
	for _, line := range []string{
		base + " kody.user=0",
		base + " kody.port=2048",
		"kody.hostname=Bad_Name kody.port=1024 kody.tmp=64",
		"kody.hostname=kfc-1 kody.port=0 kody.tmp=64",
		"kody.hostname=kfc-1 kody.port=1024 kody.tmp=64 kody.dns=fd00::1",
	} {
		if _, err := ParseCmdline(line); err == nil {
			t.Errorf("accepted %q", line)
		}
	}
}

func mountAt(ms []Mount, target string) (Mount, bool) {
	for _, m := range ms {
		if m.Target == target {
			return m, true
		}
	}
	return Mount{}, false
}

// A sandbox writes only to memory it was given: /workspace and /tmp are
// tmpfs of the sizes the cell set, /workspace owned by the sandbox's user,
// and nothing it can write runs set-id or holds devices.
func TestASandboxWritesOnlyToBoundedMemoryOwnedByItsUser(t *testing.T) {
	ms := SandboxProfile.Mounts(Boot{Hostname: "kfc-1", Port: 1024, WorkspaceMB: 256, TmpMB: 512})
	ws, ok := mountAt(ms, "/workspace")
	if !ok || ws.FSType != "tmpfs" || !strings.Contains(ws.Data, "size=256m") || !strings.Contains(ws.Data, "uid=1000,gid=1000") {
		t.Fatalf("/workspace: %+v", ws)
	}
	tmp, ok := mountAt(ms, "/tmp")
	if !ok || tmp.FSType != "tmpfs" || !strings.Contains(tmp.Data, "size=512m") {
		t.Fatalf("/tmp: %+v", tmp)
	}
	for _, m := range ms {
		if m.FSType == "tmpfs" && (!m.Has("nosuid") || !m.Has("nodev")) {
			t.Errorf("%s can hold set-id files or devices: %+v", m.Target, m)
		}
		if m.FSType == "ext4" || m.Has("bind") {
			t.Errorf("a sandbox mounts a disk: %+v", m)
		}
	}
	if !SandboxProfile.ReadOnlyRoot || !SandboxProfile.NoNewPrivs || SandboxProfile.UID == 0 {
		t.Fatalf("a sandbox runs with privileges: %+v", SandboxProfile)
	}
}

// An environment keeps Docker's state and its workspace on its data disk,
// not in memory, and runs Docker.
func TestAnEnvironmentKeepsDockerAndItsWorkspaceOnItsDataDisk(t *testing.T) {
	ms := EnvironmentProfile.Mounts(Boot{Hostname: "kfc-1", Port: 1024, TmpMB: 512})
	data, ok := mountAt(ms, DataMount)
	if !ok || data.Source != "/dev/vdb" || data.FSType != "ext4" {
		t.Fatalf("data disk: %+v", data)
	}
	ws, ok := mountAt(ms, "/workspace")
	if !ok || ws.Source != DataMount+"/workspace" || !ws.Has("bind") {
		t.Fatalf("/workspace: %+v", ws)
	}
	if c, ok := mountAt(ms, "/var/lib/containerd"); !ok || !strings.HasPrefix(c.Source, DataMount) {
		t.Fatalf("containerd: %+v", c)
	}
	if args := strings.Join(DockerdArgs(), " "); !strings.Contains(args, "--data-root "+DataMount+"/docker") {
		t.Fatalf("dockerd: %s", args)
	}
	if !EnvironmentProfile.Docker {
		t.Fatal("an environment starts no Docker")
	}
}

// A profile file is one of the cell's two exactly: a sandbox profile that
// asks for root, or an unknown field, is refused.
func TestAProfileThatIsNotOneOfTheCellsIsRefused(t *testing.T) {
	good, _ := json.Marshal(SandboxProfile)
	if p, err := ParseProfile(good); err != nil || p != SandboxProfile {
		t.Fatalf("the sandbox profile: %+v %v", p, err)
	}
	root := SandboxProfile
	root.UID = 0
	bad, _ := json.Marshal(root)
	for _, b := range [][]byte{bad, []byte(`{"name":"sandbox","uid":1000,"gid":1000,"noNewPrivs":true,"readOnlyRoot":true,"extra":1}`), []byte(`{"name":"vm"}`)} {
		if _, err := ParseProfile(b); err == nil {
			t.Errorf("accepted %s", b)
		}
	}
}
