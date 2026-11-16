//go:build linux

package fcregress

import (
	"context"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

func machineSpec(claim string, n driver.ClaimNetwork, role driver.Role, mut func(*driver.MachineSpec)) driver.MachineSpec {
	now := time.Now()
	s := driver.MachineSpec{
		CellID: cellID, EnvironmentID: "env-fc", Role: role, OrgID: "org-fc", ClaimID: claim,
		ClaimGroupID: n.WorkloadGroupID, KMSKeyRef: "kms-org-fc", ExpiresAt: now.Add(10 * time.Minute), HardExpiresAt: now.Add(30 * time.Minute),
	}
	if mut != nil {
		mut(&s)
	}
	return s
}

func claimNet(t *testing.T, d interface {
	PrepareClaim(context.Context, driver.ClaimNetworkSpec) (driver.ClaimNetwork, error)
	ReleaseClaim(context.Context, driver.ClaimNetwork) error
}, claim string,
) driver.ClaimNetwork {
	t.Helper()
	n, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: cellID, OrgID: "org-fc", ClaimID: claim})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.ReleaseClaim(context.Background(), n) })
	return n
}

// answer dials the machine's guest agent until it answers a stat.
func answer(t *testing.T, dial func() (*guest.Client, error), within time.Duration) *guest.Client {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		c, err := dial()
		if err == nil {
			if r, err := c.Do(context.Background(), guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindStat}); err == nil && r.Ok {
				return c
			}
			_ = c.Close()
		}
		if time.Now().After(deadline) {
			t.Fatalf("the guest agent never answered: %v", err)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func run(t *testing.T, c *guest.Client, command string, timeoutMs int64) *protocol.SandboxExecResult {
	t.Helper()
	r, err := c.Do(context.Background(), guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &command, TimeoutMs: &timeoutMs})
	if err != nil || r.Exec == nil {
		t.Fatalf("exec %q: %+v %v", command, r, err)
	}
	return r.Exec
}

func pct(ms []float64, p float64) float64 {
	s := append([]float64(nil), ms...)
	sort.Float64s(s)
	i := int(p*float64(len(s)-1) + 0.5)
	return s[i]
}

// A sandbox restores from its template to the guest agent's first answer
// within the P3 exit (p95 under 300 ms), twenty times in a row; the times
// are logged with the split between the rebirth and the first answer.
func TestFirecrackerSandboxRestoreTimes(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	stamp := time.Now().Format("150405")
	n := claimNet(t, s.Driver, "fc-tpl-"+stamp)
	src, err := s.Driver.CreateSandbox(ctx, driver.SandboxRequest{Spec: machineSpec("fc-tpl-"+stamp, n, driver.RoleWorkload, func(m *driver.MachineSpec) { m.Setup = true })})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Driver.Destroy(context.Background(), src) })
	c := answer(t, func() (*guest.Client, error) {
		rw, err := s.Driver.DialGuest(ctx, src)
		if err != nil {
			return nil, err
		}
		return guest.NewClient(rw, cellID, "fc-tpl"), nil
	}, 30*time.Second)
	_ = c.Close()
	start := time.Now()
	snap, err := s.Driver.Snapshot(ctx, src, isolation.PurposeTemplate)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("sandbox template (1 GiB): %d ms, pause to published", time.Since(start).Milliseconds())
	t.Cleanup(func() { _ = s.Backend.Store().Remove(snap.Org, snap.ID) })
	var total, reborn []float64
	for i := range 20 {
		claim := "fc-rst-" + stamp + "-" + string(rune('a'+i))
		cn := claimNet(t, s.Driver, claim)
		start := time.Now()
		ref, err := s.Driver.CreateSandboxFrom(ctx, machineSpec(claim, cn, driver.RoleWorkload, nil), snap)
		if err != nil {
			t.Fatal(err)
		}
		r := time.Since(start)
		c := answer(t, func() (*guest.Client, error) {
			rw, err := s.Driver.DialGuest(ctx, ref)
			if err != nil {
				return nil, err
			}
			return guest.NewClient(rw, cellID, claim), nil
		}, 10*time.Second)
		all := time.Since(start)
		_ = c.Close()
		total = append(total, float64(all.Microseconds())/1000)
		reborn = append(reborn, float64(r.Microseconds())/1000)
		if err := s.Driver.Destroy(ctx, ref); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("sandbox restore to the first answer, 20 runs: p50 %.1f ms, p95 %.1f ms, max %.1f ms (to the rebirth's answer: p50 %.1f, p95 %.1f)",
		pct(total, 0.5), pct(total, 0.95), pct(total, 1), pct(reborn, 0.5), pct(reborn, 0.95))
	if p95 := pct(total, 0.95); p95 > 300 {
		t.Fatalf("p95 %.1f ms is over the P3 exit's 300 ms", p95)
	}
}

// An environment that runs Docker and a container with its own memory limit
// becomes a template; two machines restored from it run the same container
// and Docker answers, each with its own boot id, and the clock of the host.
func TestFirecrackerEnvironmentTemplateRestoresWithItsContainers(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	stamp := time.Now().Format("150405")
	n := claimNet(t, s.Driver, "fc-envt-"+stamp)
	src, err := s.Driver.Create(ctx, machineSpec("fc-envt-"+stamp, n, driver.RoleWorkload, func(m *driver.MachineSpec) {
		m.Setup, m.ImageID, m.ImageRef, m.ClaimSize = true, "environment", "environment", driver.ClaimSize{MemoryMB: 2048, CPUs: 2}
	}))
	if err != nil {
		t.Fatal(err)
	}
	// Gone once it is a template; a test that fails before must not leave it.
	t.Cleanup(func() { _ = s.Driver.Destroy(context.Background(), src) })
	c := answer(t, func() (*guest.Client, error) {
		rw, err := s.Driver.DialGuest(ctx, src)
		if err != nil {
			return nil, err
		}
		return guest.NewClient(rw, cellID, "fc-envt"), nil
	}, 60*time.Second)
	// A container of a static binary the image has (the guest agent, under
	// Docker's init so it is not PID 1 and serves instead of booting),
	// started with a memory limit: it lands under the workload's cgroup.
	prep := `set -e
for i in $(seq 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
tar -C /usr/local/bin -c kody-guest | docker import - kg:1 >/dev/null
docker run -d --init --name keep --memory 64m kg:1 /kody-guest -listen /kg.sock -root / >/dev/null
for i in $(seq 50); do [ "$(docker inspect -f '{{.State.Running}}' keep)" = true ] && break; sleep 0.2; done
if [ "$(docker inspect -f '{{.State.Running}}' keep)" != true ]; then
  docker inspect -f '{{.State.ExitCode}} {{.State.Error}}' keep >&2; docker logs keep >&2; exit 1
fi
cg=$(cut -d: -f3 /proc/$(docker inspect -f '{{.State.Pid}}' keep)/cgroup)
echo "$cg"
cat /sys/fs/cgroup$cg/memory.max
cat /proc/sys/kernel/random/boot_id`
	r := run(t, c, prep, 120_000)
	_ = c.Close()
	out := strings.Split(strings.TrimSpace(r.Stdout), "\n")
	if r.ExitCode != 0 || len(out) != 3 || !strings.HasPrefix(out[0], "/kody-workload/docker/") || out[1] != "67108864" {
		t.Fatalf("the container under the workload's cgroup: %d %q %q", r.ExitCode, r.Stdout, r.Stderr)
	}
	t.Logf("the template's container runs in %s with memory.max %s", out[0], out[1])
	tplBoot := out[2]
	start := time.Now()
	snap, err := s.Driver.Snapshot(ctx, src, isolation.PurposeTemplate)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("environment template (2 GiB, Docker and one container): %d ms", time.Since(start).Milliseconds())
	t.Cleanup(func() { _ = s.Backend.Store().Remove(snap.Org, snap.ID) })
	var boots []string
	for i, role := range []driver.Role{driver.RoleWorkload, driver.RolePool} {
		claim := "fc-envr-" + stamp + "-" + string(rune('a'+i))
		cn := claimNet(t, s.Driver, claim)
		start := time.Now()
		ref, err := s.Driver.CreateFrom(ctx, machineSpec(claim, cn, role, func(m *driver.MachineSpec) { m.ImageID, m.ImageRef = "environment", "environment" }), snap)
		if err != nil {
			t.Fatal(err)
		}
		restored := time.Since(start)
		c := answer(t, func() (*guest.Client, error) {
			rw, err := s.Driver.DialGuest(ctx, ref)
			if err != nil {
				return nil, err
			}
			return guest.NewClient(rw, cellID, claim), nil
		}, 30*time.Second)
		first := time.Since(start)
		before := time.Now()
		r := run(t, c, `date +%s%N; docker inspect -f '{{.State.Running}}' keep; docker info --format '{{.ServerVersion}}'; cat /proc/sys/kernel/random/boot_id`, 60_000)
		after := time.Now()
		_ = c.Close()
		t.Cleanup(func() { _ = s.Driver.Destroy(context.Background(), ref) })
		lines := strings.Split(strings.TrimSpace(r.Stdout), "\n")
		if r.ExitCode != 0 || len(lines) != 4 || lines[1] != "true" {
			t.Fatalf("the restored environment: %d %q %q", r.ExitCode, r.Stdout, r.Stderr)
		}
		var ns int64
		for _, ch := range lines[0] {
			ns = ns*10 + int64(ch-'0')
		}
		if g := time.Unix(0, ns); g.Before(before.Add(-50*time.Millisecond)) || g.After(after.Add(50*time.Millisecond)) {
			t.Errorf("the restored environment's clock is %v off the host's", g.Sub(before))
		}
		boots = append(boots, lines[3])
		t.Logf("environment restore %s: %d ms to the rebirth, %d ms to the first answer, docker %s, container running",
			ref.MachineID, restored.Milliseconds(), first.Milliseconds(), lines[2])
	}
	if boots[0] == boots[1] || boots[0] == tplBoot || boots[1] == tplBoot {
		t.Fatalf("boot ids: template %s, clones %v", tplBoot, boots)
	}
}
