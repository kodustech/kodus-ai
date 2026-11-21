//go:build linux

package fcregress

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
)

// S-35, the cell's half: a process the guest kernel kills for memory moves
// the machine's OOM counter (what makes a probe's vmHealth oom), a process
// that only uses memory does not (the control), and a machine whose VMM
// dies no longer runs (crashed). The gate's half (OOM on the PR side in
// every round is pr_destabilizes_machine) is apps/runtime's vm-health.spec.
func TestFirecrackerAnOOMInTheVMIsItsHealth(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	claim := "fc-oom-" + time.Now().Format("150405")
	n := claimNet(t, s.Driver, claim)
	ref, err := s.Driver.CreateSandbox(ctx, driver.SandboxRequest{Spec: machineSpec(claim, n, driver.RoleWorkload, func(m *driver.MachineSpec) {
		m.ClaimSize = driver.ClaimSize{MemoryMB: 512, CPUs: 1}
	})})
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
	health := func() driver.MachineHealth {
		t.Helper()
		h, err := s.Driver.MachineHealth(ctx, ref)
		if err != nil {
			t.Fatal(err)
		}
		return h
	}
	h0 := health()
	small := run(t, c, `python3 -c 'b = bytearray(64 << 20); print(len(b))'`, 60_000)
	h1 := health()
	big := run(t, c, `python3 -c 'b = [bytearray(64 << 20) for _ in range(64)]; print(len(b))'`, 120_000)
	h2 := health()
	if !h0.Running || h1.OOMKills != h0.OOMKills {
		t.Fatalf("the control moved the counter: %+v then %+v (exit %d)", h0, h1, small.ExitCode)
	}
	if h2.OOMKills <= h1.OOMKills || big.ExitCode == 0 {
		t.Fatalf("4 GiB in a 512 MiB VM: exit %d, health %+v then %+v", big.ExitCode, h1, h2)
	}
	// The VMM dies: the machine no longer runs.
	pid := vmmPID(t, ref.MachineID)
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second)
	cctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	h3, err := s.Driver.MachineHealth(cctx, ref)
	if err != nil || h3.Running {
		t.Fatalf("a machine whose VMM was killed: %+v %v", h3, err)
	}
	t.Logf("EVIDENCE S-35 oom_kill %d at boot, %d after 64 MiB (exit %d), %d after 4 GiB in 512 MiB (exit %d); VMM %d killed: running %v",
		h0.OOMKills, h1.OOMKills, small.ExitCode, h2.OOMKills, big.ExitCode, pid, h3.Running)
}

// vmmPID is the firecracker process whose --id is the machine's jail id.
func vmmPID(t *testing.T, machine string) int {
	t.Helper()
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		cmd, _ := os.ReadFile("/proc/" + e.Name() + "/cmdline")
		args := strings.Split(string(cmd), "\x00")
		if len(args) > 0 && strings.HasSuffix(args[0], "firecracker") && strings.Contains(string(cmd), machineJailID(machine)) {
			return pid
		}
	}
	t.Fatalf("no VMM for %s", machine)
	return 0
}

// machineJailID is the backend's jail id of a machine name (firecracker.idOf).
func machineJailID(name string) string {
	s := sha256.Sum256([]byte(name))
	return "kfc-" + hex.EncodeToString(s[:10])
}
