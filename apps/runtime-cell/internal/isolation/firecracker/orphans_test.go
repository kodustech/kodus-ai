package firecracker

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/hostnet"
)

// invNet is the fake network with the host's taps listed and removable.
type invNet struct {
	*fakeNet
	host, netns     []string
	removed, nsGone []string
}

func (n *invNet) HostNetns(context.Context) ([]string, error) { return n.netns, nil }
func (n *invNet) RemoveNetns(_ context.Context, name string) error {
	n.nsGone = append(n.nsGone, name)
	return nil
}
func (n *invNet) NetnsOf(machine string) string { return hostnet.NetnsName(machine) }

func (n *invNet) HostTaps(context.Context) ([]string, error) { return n.host, nil }
func (n *invNet) RemoveTap(_ context.Context, name string) error {
	n.removed = append(n.removed, name)
	return nil
}
func (n *invNet) TapOf(machine string) string { return hostnet.TapName(machine) }

// What a cell that died between steps leaves (a VMM, its cgroup, its jail,
// its states and its tap, with no record naming them) is ended by the orphan
// pass; a machine with a record keeps all of its own.
func TestTheOrphanPassEndsOnlyWhatNoRecordNames(t *testing.T) {
	vmm := &fakeVMM{t: t, state: map[string]string{}, args: map[string][]string{}}
	n := &invNet{fakeNet: &fakeNet{taps: map[string]hostnet.Attachment{}}}
	b := newBackend(t, vmm, n.fakeNet)
	b.cfg.Network = n
	ctx := context.Background()
	live, err := b.Create(ctx, isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-a-workload", Network: "kodus-a"})
	if err != nil {
		t.Fatal(err)
	}
	orphan := "kfc-00000000000000000001"
	for _, d := range []string{filepath.Join(b.jailDir(orphan), "root"), b.cgroupDir(orphan)} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(b.statesPath(orphan), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	n.host = []string{hostnet.TapName("kodus-a-workload"), hostnet.TapName("kodus-gone-workload")}
	n.netns = []string{hostnet.NetnsName("kodus-a-workload"), hostnet.NetnsName("kodus-gone-workload")}
	var proc *exec.Cmd
	if runtime.GOOS == "linux" {
		// A process the jailer would have started: argv[0] firecracker, --id of a jail no record names.
		proc = exec.Command("/bin/sh", "-c", "sleep 60; :")
		proc.Args = []string{"/firecracker", "-c", "sleep 60; :", "sh", "--id", "kfc-00000000000000000002"}
		if err := proc.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = proc.Process.Kill() })
	}
	gone, err := b.ReapOrphans(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("removed %v", gone)
	for _, p := range []string{b.jailDir(orphan), b.cgroupDir(orphan), b.statesPath(orphan)} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s is still there", p)
		}
	}
	if !slices.Equal(n.removed, []string{hostnet.TapName("kodus-gone-workload")}) {
		t.Errorf("taps removed %v", n.removed)
	}
	if !slices.Equal(n.nsGone, []string{hostnet.NetnsName("kodus-gone-workload")}) {
		t.Errorf("namespaces removed %v", n.nsGone)
	}
	if left := b.Remains("kodus-a-workload"); len(left) == 0 {
		t.Error("the live machine lost its own")
	}
	if _, err := os.Stat(b.jailDir(live.ID)); err != nil {
		t.Errorf("the live machine's jail: %v", err)
	}
	if proc != nil {
		done := make(chan error, 1)
		go func() { done <- proc.Wait() }()
		select {
		case err := <-done:
			if err == nil || !strings.Contains(err.Error(), "killed") {
				t.Errorf("the orphan VMM ended with %v, not killed", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("the orphan VMM still runs")
		}
	}
}

// A VMM SIGKILLed by the orphan pass can take a while to exit: a guest's
// memory is torn down first, and on a nested-virtualization host S-08 found
// the orphan's /proc entry still there, its SIGKILL pending, when the reaper
// had already returned. The pass returns only once each VMM it killed is
// gone. Here the "process" is a /proc entry that disappears 300 ms after the
// kill, the way a slow exit looks to the reaper.
func TestTheOrphanPassReturnsOnlyOnceTheVMMsItKilledAreGone(t *testing.T) {
	vmm := &fakeVMM{t: t, state: map[string]string{}, args: map[string][]string{}}
	n := &invNet{fakeNet: &fakeNet{taps: map[string]hostnet.Attachment{}}}
	b := newBackend(t, vmm, n.fakeNet)
	b.cfg.Network = n
	// A real process to receive the SIGKILL, listed in a fake /proc whose
	// entry outlives it by 300 ms.
	proc := exec.Command("sleep", "60")
	if err := proc.Start(); err != nil {
		t.Fatal(err)
	}
	waited := make(chan error, 1)
	go func() { waited <- proc.Wait() }()
	t.Cleanup(func() { _ = proc.Process.Kill() })
	b.cfg.ProcDir = t.TempDir()
	entry := filepath.Join(b.cfg.ProcDir, strconv.Itoa(proc.Process.Pid))
	if err := os.MkdirAll(entry, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(entry, "cmdline"), []byte("/firecracker\x00--id\x00kfc-00000000000000000003\x00"), 0o600); err != nil {
		t.Fatal(err)
	}
	go func() {
		<-waited
		time.Sleep(300 * time.Millisecond)
		_ = os.RemoveAll(entry)
	}()
	gone, err := b.ReapOrphans(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(gone, "process "+strconv.Itoa(proc.Process.Pid)+" kfc-00000000000000000003") {
		t.Fatalf("the orphan VMM was not ended: %v", gone)
	}
	if _, err := os.Stat(entry); !os.IsNotExist(err) {
		t.Fatal("the orphan pass returned while the VMM it killed was still there")
	}
}
