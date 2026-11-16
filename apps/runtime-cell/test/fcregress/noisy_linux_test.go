//go:build linux

package fcregress

import (
	"context"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/firecracker"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/hostnet"
)

// The noisy neighbour's limits in this test: low enough that the state disk
// and the host's network stack are never what bounds the noisy VM.
const (
	noisyDiskMBps = 20 // per vCPU: 40 MB/s for a 2-vCPU VM
	noisyNetMbps  = 50 // per vCPU: 100 Mbit/s each way
)

func p95(ds []time.Duration) time.Duration {
	s := append([]time.Duration(nil), ds...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[(len(s)*95+99)/100-1]
}

// One VM writing its disk and flooding its NIC as fast as it can stays
// inside its token buckets, and another claim's VM keeps answering: its
// guest agent's p95 and a small synced write stay bounded (Firecracker's
// rate_limiter on each drive and the NIC, io.max on the VMM's cgroup).
func TestFirecrackerANoisyNeighbourStaysInsideItsLimits(t *testing.T) {
	s := open(t, func(f *microvm.Firecracker) {
		f.Limits = firecracker.Limits{DiskMBps: noisyDiskMBps, NetMbps: noisyNetMbps}
	})
	ctx := context.Background()
	stamp := time.Now().Format("150405")
	boot := func(claim string) driver.MachineRef {
		t.Helper()
		n := claimNet(t, s.Driver, claim) //nolint:contextcheck // the helper makes and releases a claim network on its own context, as the other tests'.
		ref, err := s.Driver.Create(ctx, machineSpec(claim, n, driver.RoleWorkload, func(m *driver.MachineSpec) {
			m.ImageID, m.ImageRef, m.ClaimSize = "environment", "environment", driver.ClaimSize{MemoryMB: 1024, CPUs: 2}
		}))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = s.Driver.Destroy(context.WithoutCancel(ctx), ref) })
		return ref
	}
	sh := func(ref driver.MachineRef, cmd string, timeoutMs int64) string {
		t.Helper()
		r, err := s.Driver.Exec(ctx, ref, kodyexec.Request{Command: cmd, TimeoutMs: timeoutMs})
		if err != nil {
			t.Fatalf("%q in %s: %v", cmd, ref.MachineID, err)
		}
		return r.Stdout + r.Stderr
	}
	noisy, quiet := boot("fc-noisy-"+stamp), boot("fc-quiet-"+stamp)
	ready := "for i in $(seq 120); do mountpoint -q /var/lib/kody-data && exit 0; sleep 0.5; done; exit 1"
	sh(noisy, ready, 90_000)
	sh(quiet, ready, 90_000)
	// The quiet VM's answers: 40 execs of true, then a 200-block synced write.
	probe := func() (time.Duration, time.Duration) {
		var ds []time.Duration
		for range 40 {
			start := time.Now()
			sh(quiet, "true", 10_000)
			ds = append(ds, time.Since(start))
			time.Sleep(50 * time.Millisecond)
		}
		start := time.Now()
		sh(quiet, "dd if=/dev/zero of=/var/lib/kody-data/probe bs=4k count=200 oflag=dsync status=none; rm -f /var/lib/kody-data/probe", 60_000)
		return p95(ds), time.Since(start)
	}
	baseExec, baseWrite := probe()

	// The noise: a direct write of the whole data disk and a UDP flood at the
	// gateway (the host drops it; the tap still carries every byte).
	tap := hostnet.TapName(noisy.MachineID)
	rx := func() int64 {
		raw, _ := os.ReadFile("/sys/class/net/" + tap + "/statistics/rx_bytes")
		n, _ := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
		return n
	}
	var wg sync.WaitGroup
	var diskOut string
	wg.Add(2)
	go func() {
		defer wg.Done()
		r, err := s.Driver.Exec(ctx, noisy, kodyexec.Request{Command: "dd if=/dev/zero of=/var/lib/kody-data/fill bs=1M count=1600 oflag=direct 2>&1 | tail -1; rm -f /var/lib/kody-data/fill", TimeoutMs: 180_000})
		if err == nil {
			diskOut = r.Stdout + r.Stderr
		}
	}()
	go func() {
		defer wg.Done()
		_, _ = s.Driver.Exec(ctx, noisy, kodyexec.Request{Command: `gw=$(ip route | awk '/default/{print $3}'); timeout 30 bash -c "dd if=/dev/zero bs=1400 count=999999999 > /dev/udp/$gw/9" 2>/dev/null; true`, TimeoutMs: 60_000})
	}()
	// Past the buckets' one-time burst (5 s at the rate), the steady rate.
	time.Sleep(10 * time.Second)
	rx0, t0 := rx(), time.Now()
	noisyExec, noisyWrite := probe()
	netBps := float64(rx()-rx0) / time.Since(t0).Seconds()
	wg.Wait()

	diskMBps := 0.0
	if m := regexp.MustCompile(`copied, ([0-9.]+) s, ([0-9.]+) MB/s`).FindStringSubmatch(diskOut); m != nil {
		diskMBps, _ = strconv.ParseFloat(m[2], 64)
	}
	t.Logf("EVIDENCE noisy VM: disk %.1f MB/s (limit %d, burst included), net %.1f Mbit/s (limit %d); quiet VM exec p95 %v -> %v, 200 synced 4k writes %v -> %v",
		diskMBps, 2*noisyDiskMBps, netBps*8/1e6, 2*noisyNetMbps, baseExec, noisyExec, baseWrite, noisyWrite)
	if diskMBps == 0 || diskMBps > 1.6*2*noisyDiskMBps {
		t.Errorf("the noisy VM wrote at %.1f MB/s past its %d MB/s bucket: %q", diskMBps, 2*noisyDiskMBps, diskOut)
	}
	if netBps*8/1e6 > 1.3*2*noisyNetMbps {
		t.Errorf("the noisy VM sent %.1f Mbit/s past its %d Mbit/s bucket", netBps*8/1e6, 2*noisyNetMbps)
	}
	if noisyExec > max(3*baseExec, baseExec+300*time.Millisecond) {
		t.Errorf("the quiet VM's exec p95 went from %v to %v next to the noisy one", baseExec, noisyExec)
	}
	if noisyWrite > max(3*baseWrite, baseWrite+2*time.Second) {
		t.Errorf("the quiet VM's synced writes went from %v to %v next to the noisy one", baseWrite, noisyWrite)
	}
}
