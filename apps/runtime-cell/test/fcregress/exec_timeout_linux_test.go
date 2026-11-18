//go:build linux

package fcregress

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// An exec past its timeout answers timed out (exit 124) and the stream to
// the guest agent stays open, even when the command is writing the VM's
// data disk at its full speed when the deadline comes; the next exec on the
// same stream answers. (S-09's disk fill under a 60 s timeout once ended
// with "the stream to the guest agent is closed" instead.)
func TestFirecrackerAnExecPastItsTimeoutWhileWritingTheDiskAnswersTimedOut(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	claim := "fc-tmo-" + time.Now().Format("150405")
	n := claimNet(t, s.Driver, claim)
	ref, err := s.Driver.Create(ctx, machineSpec(claim, n, driver.RoleWorkload, func(m *driver.MachineSpec) {
		m.ImageID, m.ImageRef, m.ClaimSize = "environment", "environment", driver.ClaimSize{MemoryMB: 2048, CPUs: 2}
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Driver.Destroy(context.WithoutCancel(ctx), ref) })
	c := answer(t, func() (*guest.Client, error) {
		rw, err := s.Driver.DialGuest(ctx, ref)
		if err != nil {
			return nil, err
		}
		return guest.NewClient(rw, cellID, claim), nil
	}, time.Minute)
	t.Cleanup(func() { _ = c.Close() })
	diagnose := func() {
		jail := filepath.Join(os.Getenv("KODY_E2E_FIRECRACKER_STATE"), "vm", "jail", "firecracker", machineJailID(ref.MachineID), "root")
		if b, err := os.ReadFile(filepath.Join(jail, "log")); err == nil {
			t.Logf("VMM log (tail):\n%s", tail(b, 3000))
		}
		if b, err := exec.Command("sh", "-c", "dmesg | tail -40").CombinedOutput(); err == nil {
			t.Logf("host dmesg (tail):\n%s", b)
		}
	}
	for i, round := range []struct {
		command string
		timeout int64
	}{
		{"dd if=/dev/zero of=/var/lib/kody-data/fill bs=4M oflag=direct 2>&1 | tail -1", 5_000},
		// Through the page cache, as S-09's fill: the deadline comes with dirty pages to write back.
		{"dd if=/dev/zero of=/var/lib/kody-data/fill bs=4M 2>&1 | tail -1", 15_000},
		{"df -B1 --output=size,avail /var/lib/kody-data | tail -1; fallocate -l 500G /var/lib/kody-data/fill 2>&1 || dd if=/dev/zero of=/var/lib/kody-data/fill bs=4M 2>&1 | tail -1; df -B1 --output=avail /var/lib/kody-data | tail -1; rm -f /var/lib/kody-data/fill", 30_000},
	} {
		command, timeout := round.command, round.timeout
		start := time.Now()
		r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &command, TimeoutMs: &timeout})
		took := time.Since(start)
		if err != nil || r.Exec == nil {
			diagnose()
			t.Fatalf("round %d: the exec past its %d ms timeout ended %v after %v: %+v", i, timeout, err, took, r)
		}
		if !r.Exec.TimedOut || r.Exec.ExitCode != 124 {
			t.Fatalf("round %d: exit %d timedOut %v after %v", i, r.Exec.ExitCode, r.Exec.TimedOut, took)
		}
		next := run(t, c, "rm -f /var/lib/kody-data/fill; df -B1 --output=avail /var/lib/kody-data | tail -1", 120_000)
		t.Logf("EVIDENCE exec timeout round %d: timed out (exit 124) %v after a %d ms deadline; next exec exit %d (%s)", i, took.Round(time.Millisecond), timeout, next.ExitCode, next.Stdout)
	}
}

func tail(b []byte, n int) string {
	if len(b) > n {
		b = b[len(b)-n:]
	}
	return string(b)
}

// An environment VM writing its data disk faster than the host's disk
// takes it keeps running, and its exec's deadline holds: its guest memory is all touched (the guest's page
// cache) and the host's page cache for its disk file is charged to its
// VMM's memory cgroup, which once OOM-killed the VMM mid-write (S-09 in the
// full fcregress run: "Memory cgroup out of memory: Killed process
// (firecracker)", anon 1.8 GiB + file 0.4 GiB of a 2176 MiB limit; the
// exec then ended with "the stream to the guest agent is closed"). The
// host's disk is made slow for that VMM alone (io.max on the state device)
// so the dirty pages pile up as they did.
func TestFirecrackerAnEnvironmentWritingFasterThanTheHostDiskKeepsItsVMM(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	claim := "fc-wb-" + time.Now().Format("150405")
	n := claimNet(t, s.Driver, claim)
	ref, err := s.Driver.Create(ctx, machineSpec(claim, n, driver.RoleWorkload, func(m *driver.MachineSpec) {
		m.ImageID, m.ImageRef, m.ClaimSize = "environment", "environment", driver.ClaimSize{MemoryMB: 2048, CPUs: 2}
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Driver.Destroy(context.WithoutCancel(ctx), ref) })
	c := answer(t, func() (*guest.Client, error) {
		rw, err := s.Driver.DialGuest(ctx, ref)
		if err != nil {
			return nil, err
		}
		return guest.NewClient(rw, cellID, claim), nil
	}, time.Minute)
	t.Cleanup(func() { _ = c.Close() })
	parent := "/sys/fs/cgroup/kodus-microvm"
	cg := filepath.Join(parent, machineJailID(ref.MachineID))
	if err := os.WriteFile(filepath.Join(parent, "cgroup.subtree_control"), []byte("+io"), 0o644); err != nil {
		t.Fatalf("io controller for the VMMs: %v", err)
	}
	var st syscall.Stat_t
	if err := syscall.Stat(os.Getenv("KODY_E2E_FIRECRACKER_STATE"), &st); err != nil {
		t.Fatal(err)
	}
	dev := fmt.Sprintf("%d:%d", unix.Major(st.Dev), unix.Minor(st.Dev))
	if err := os.WriteFile(filepath.Join(cg, "io.max"), []byte(dev+" wbps=10485760"), 0o644); err != nil {
		t.Fatalf("io.max %s: %v", dev, err)
	}
	limit, _ := os.ReadFile(filepath.Join(cg, "memory.max"))
	// S-09's fill: through the guest's page cache, which touches all of its
	// memory, while the VMM's dirty pages wait on the slow disk.
	command := "dd if=/dev/zero of=/var/lib/kody-data/fill bs=4M 2>&1 | tail -1; rm -f /var/lib/kody-data/fill"
	timeout := int64(60_000)
	start := time.Now()
	r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &command, TimeoutMs: &timeout})
	events, _ := os.ReadFile(filepath.Join(cg, "memory.events"))
	if err != nil || r.Exec == nil {
		out, _ := exec.Command("sh", "-c", "dmesg | grep -iE 'out of memory|oom-kill' | tail -5").CombinedOutput()
		t.Fatalf("the VM stopped answering %v into a full-disk write at 10 MB/s (memory.max %s): %v\nmemory.events:\n%s\nhost:\n%s", time.Since(start).Round(time.Second), strings.TrimSpace(string(limit)), err, events, out)
	}
	// The deadline holds though dd is in uninterruptible I/O when it comes:
	// the op answered after 7m46s for a 60 s timeout until the guest agent
	// stopped waiting for a killed process past its grace. What is left past
	// the deadline is the VM's own I/O on the slowed disk (the agent's answer
	// queues behind the writes on the same disk; at 1 MB/s on a direct-I/O
	// state disk that took 13 minutes): at 10 MB/s, under twice the timeout.
	if took := time.Since(start); !r.Exec.TimedOut || took > 2*time.Duration(timeout)*time.Millisecond {
		t.Fatalf("an exec of a %d ms timeout answered timedOut %v after %v", timeout, r.Exec.TimedOut, took)
	}
	if strings.Contains(string(events), "oom_kill 1") {
		t.Fatalf("the VMM's cgroup killed for memory: %s", events)
	}
	t.Logf("EVIDENCE a full-disk write at 10 MB/s on the host for %v: exit %d timedOut %v, memory.max %s, memory.events %s",
		time.Since(start).Round(time.Second), r.Exec.ExitCode, r.Exec.TimedOut, strings.TrimSpace(string(limit)), strings.ReplaceAll(strings.TrimSpace(string(events)), "\n", ", "))
}
