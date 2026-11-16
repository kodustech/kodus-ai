package conformance

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/reaper"
)

// A machine past its hard ceiling is ended by the reaper alone, as the
// cell's out-of-process reaper runs it (no help from the cell's driver in
// this process), and what a cell that died mid-claim left of a machine with
// no record is ended by the reaper's orphan pass.
func theReaperAloneEndsAnExpiredMachineAndAnOrphan(t *testing.T, tg Target) {
	if tg.Reaper == nil {
		t.Skip(tg.Name + " has no out-of-process reaper")
	}
	b := newBoxWith(t, tg, "org-conf-a", func(s *driver.MachineSpec) {
		s.ExpiresAt, s.HardExpiresAt = time.Now().Add(3*time.Second), time.Now().Add(4*time.Second)
	})
	time.Sleep(5 * time.Second)
	rep, err := (&reaper.Reaper{CellID: tg.CellID, Driver: tg.Reaper, Orphans: tg.ReaperOrphans}).Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !slicesContains(rep.Terminated, b.ref.MachineID) {
		t.Fatalf("the reaper did not end %s past its ceiling: %+v", b.ref.MachineID, rep)
	}
	if left := tg.Leftovers(t, b.ref.MachineID); len(left) > 0 {
		t.Fatalf("the host keeps %v of the reaped machine", left)
	}
	if tg.Orphan == nil {
		t.Logf("%s: no orphan to make, the orphan pass is not shown", tg.Name)
		return
	}
	o := newBox(t, tg, "org-conf-a", driver.ClaimSize{}, driver.RoleWorkload)
	left := tg.Orphan(t, o.ref)
	if len(left()) == 0 {
		t.Fatal("the orphan leaves nothing on the host, so an empty list later would prove nothing")
	}
	rep, err = (&reaper.Reaper{CellID: tg.CellID, Driver: tg.Reaper, Orphans: tg.ReaperOrphans}).Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for len(left()) > 0 && time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
	}
	if l := left(); len(l) > 0 {
		t.Fatalf("the orphan pass left %v (removed %v)", l, rep.Orphans)
	}
	t.Logf("%s: the reaper ended %s past its ceiling; its orphan pass removed %v", tg.Name, b.ref.MachineID, rep.Orphans)
}

func slicesContains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func p95(ds []time.Duration) time.Duration {
	s := append([]time.Duration(nil), ds...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[(len(s)*95+99)/100-1]
}

var ddRate = regexp.MustCompile(`([0-9.]+) ([KMG]?B)/s`)

// A sandbox writing its disk and sending on its network as fast as it can
// does not starve another org's sandbox: the other one's guest agent and a
// small synced write keep answering within a bound of their own baseline.
// Where the target enforces the per-sandbox limits (Target.Limits), the
// noisy sandbox's disk and network stay inside them.
func aNoisyNeighbourDoesNotStarveAnotherOrgsSandbox(t *testing.T, tg Target) {
	if !tg.Boundary {
		t.Skip(tg.Name + " runs commands on the host: it limits nothing")
	}
	size := driver.ClaimSize{MemoryMB: 1024, CPUs: 1}
	noisy := newBox(t, tg, "org-conf-a", size, driver.RoleWorkload)
	quiet := newBox(t, tg, "org-conf-b", size, driver.RoleWorkload)
	probe := func() (time.Duration, time.Duration) {
		var ds []time.Duration
		for range 30 {
			start := time.Now()
			quiet.sh(t, "true")
			ds = append(ds, time.Since(start))
			time.Sleep(50 * time.Millisecond)
		}
		start := time.Now()
		quiet.sh(t, "dd if=/dev/zero of=probe bs=4k count=200 oflag=dsync 2>/dev/null; rm -f probe")
		return p95(ds), time.Since(start)
	}
	baseExec, baseWrite := probe()

	// The noise: 400 MB written and synced, and datagrams at the network's
	// resolver for as long; the machine's own interface counts what it sent.
	const seconds = 25
	disk := "dd if=/dev/zero of=fill bs=1M count=400 conv=fdatasync 2>&1 | tail -1; rm -f fill"
	flood := `import socket, time
dst = [l.split()[1] for l in open("/etc/resolv.conf") if l.startswith("nameserver")][0]
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
b, n, end = b"x" * 1400, 0, time.time() + ` + strconv.Itoa(seconds) + `
while time.time() < end:
    try:
        n += s.sendto(b, (dst, 9))
    except OSError:
        time.sleep(0.001)
print(n)`
	tx := func() int64 {
		r := noisy.sh(t, "cat /sys/class/net/eth0/statistics/tx_bytes 2>/dev/null || echo 0")
		n, _ := strconv.ParseInt(strings.TrimSpace(r.Stdout), 10, 64)
		return n
	}
	tx0, t0 := tx(), time.Now()
	var wg sync.WaitGroup
	var diskOut string
	run := func(cmd string, out *string) {
		defer wg.Done()
		c := noisy.dial(t)
		defer func() { _ = c.Close() }()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &cmd, TimeoutMs: ptr[int64](170_000)})
		if err == nil && r.Exec != nil && out != nil {
			*out = r.Exec.Stdout + r.Exec.Stderr
		}
	}
	wg.Add(2)
	go run(disk, &diskOut)
	go run("python3 -c "+shellQuote(flood), nil)
	time.Sleep(3 * time.Second)
	noisyExec, noisyWrite := probe()
	wg.Wait()
	netBps := float64(tx()-tx0) / time.Since(t0).Seconds()

	diskMBps := 0.0
	if m := ddRate.FindStringSubmatch(diskOut); m != nil {
		diskMBps, _ = strconv.ParseFloat(m[1], 64)
		switch m[2] {
		case "kB", "KB":
			diskMBps /= 1000
		case "GB":
			diskMBps *= 1000
		}
	}
	t.Logf("EVIDENCE %s noisy sandbox: disk %.1f MB/s, net %.1f Mbit/s; the other org's exec p95 %v -> %v, 200 synced 4k writes %v -> %v",
		tg.Name, diskMBps, netBps*8/1e6, baseExec, noisyExec, baseWrite, noisyWrite)
	if noisyExec > max(3*baseExec, baseExec+300*time.Millisecond) {
		t.Errorf("the other org's exec p95 went from %v to %v next to the noisy sandbox", baseExec, noisyExec)
	}
	if noisyWrite > max(3*baseWrite, baseWrite+2*time.Second) {
		t.Errorf("the other org's synced writes went from %v to %v next to the noisy sandbox", baseWrite, noisyWrite)
	}
	if tg.Limits == nil {
		return
	}
	// A sandbox's workspace is in its memory on every target (its memory
	// limit bounds it), so its disk rate is not the drives' (an
	// environment's is: fcregress); its network is. The buckets' one-time
	// burst (5 s at the rate) is in the average.
	r := tg.Limits.For(size.CPUs)
	if limit := float64(r.NetBps) * 8 / 1e6; r.NetBps > 0 && netBps*8/1e6 > 1.6*limit {
		t.Errorf("the noisy sandbox sent %.1f Mbit/s past its %.0f Mbit/s", netBps*8/1e6, limit)
	}
	if tg.DownloadURL == "" || tg.Egress == nil || r.NetBps <= 0 {
		return
	}
	// The way in: a large file from the allowed host, counted past the
	// first 6 s (a bucket's burst), lands at the limit's rate.
	if err := tg.Egress.Allow(context.Background(), noisy.claim, noisy.org, noisy.net, []string{noisy.ref.PrivateAddress}, []string{tg.AllowedHost}); err != nil {
		t.Fatalf("allow: %v", err)
	}
	download := `import sys, time, urllib.request
r = urllib.request.urlopen(sys.argv[1], timeout=30)
start = time.time(); n0 = n = 0; t0 = None
while time.time() - start < 26:
    b = r.read(1 << 16)
    if not b: break
    n += len(b)
    if t0 is None and time.time() - start >= 6: t0, n0 = time.time(), n
print(n - n0, time.time() - (t0 or start))`
	out := noisy.sh(t, "python3 -c "+shellQuote(download)+" "+shellQuote(tg.DownloadURL))
	var got, secs float64
	if _, err := fmt.Sscanf(strings.TrimSpace(out.Stdout), "%f %f", &got, &secs); err != nil || secs <= 0 {
		t.Fatalf("the download: %+v", out)
	}
	rate, limit := got*8/secs/1e6, float64(r.NetBps)*8/1e6
	t.Logf("EVIDENCE %s download into the noisy sandbox: %.1f Mbit/s (limit %.0f)", tg.Name, rate, limit)
	if rate > 1.3*limit || rate < 0.4*limit {
		t.Errorf("the download ran at %.1f Mbit/s, not near its %.0f Mbit/s limit", rate, limit)
	}
}
