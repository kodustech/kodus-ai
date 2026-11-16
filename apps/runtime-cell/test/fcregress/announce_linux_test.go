//go:build linux

package fcregress

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// A machine restored in its place announces its address (a gratuitous ARP
// when its rebirth brings eth0 up), so a peer that kept sending to it while
// it was gone knows where it is at once. Round 3's open finding: the
// observer kept retransmitting to the workload during the round snapshot
// (a minute or more), its neighbour entry for the workload cycled through
// unanswered ARP requests, and a first probe whose SYN waited on a cycle's
// last request got "no route to host" when that entry failed, 3 times in
// 34 rounds; the rest waited up to a second for the next request
// (spike-firecracker-2026-11.md). Here the peer's entry for the machine is
// failed on purpose while the machine is a snapshot; once it is restored,
// the peer's entry names the machine's MAC without the peer sending
// anything to it.
func TestFirecrackerARestoredMachineAnnouncesItsAddress(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	claim := "fc-arp-" + time.Now().Format("150405")
	n := claimNet(t, s.Driver, claim)
	spec := func(name string) isolation.Spec {
		return isolation.Spec{
			Shape: isolation.ShapeSandbox, Image: "sandbox", Name: "kodus-" + claim + "-" + name, Network: n.WorkloadGroupID,
			Labels: map[string]string{"kodus:cell": cellID, "kodus:claim": claim}, Memory: "512m", CPUs: "1",
			WorkspaceSize: "256m", TmpSize: "128m", Org: "org-fc", Claim: claim,
		}
	}
	boot := func(sp isolation.Spec) (string, *guest.Client) {
		m, err := s.Backend.Create(context.Background(), sp)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = s.Backend.Destroy(context.Background(), sp.Name, isolation.DestroyOptions{}) })
		c := answer(t, func() (*guest.Client, error) {
			rw, err := s.Backend.DialGuest(context.Background(), sp.Name)
			if err != nil {
				return nil, err
			}
			return guest.NewClient(rw, cellID, claim), nil
		}, 30*time.Second)
		t.Cleanup(func() { _ = c.Close() })
		return m.Addresses[n.WorkloadGroupID], c
	}
	_, peer := boot(spec("peer"))
	target := spec("target")
	ip, tc := boot(target)
	_ = tc.Close()
	mac := macOfIP(ip)
	// entry is the peer's ARP entry for the target: its flags and MAC.
	entry := func() string {
		r := run(t, peer, "cat /proc/net/arp", 10_000)
		for _, l := range strings.Split(r.Stdout, "\n") {
			if f := strings.Fields(l); len(f) >= 4 && f[0] == ip {
				return f[2] + " " + f[3]
			}
		}
		return "none"
	}
	reach := fmt.Sprintf(`python3 -c 'import socket
s = socket.socket(); s.settimeout(1)
try: s.connect((%q, 9))
except OSError as e: print(e)'`, ip)
	run(t, peer, reach, 10_000)
	if got := entry(); got != "0x2 "+mac {
		t.Fatalf("the peer's entry for the target before the round: %q", got)
	}

	snap, err := s.Backend.Snapshot(ctx, target.Name, isolation.SnapshotRequest{Purpose: isolation.PurposeRound, Org: "org-fc"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Backend.Store().Remove("org-fc", snap.ID) })
	// The target is a snapshot: the peer keeps sending to it until its entry
	// for the target has gone through stale, probe and failed (its
	// reachable time is 15-45 s), then waits for its last ARP request to go
	// unanswered.
	run(t, peer, fmt.Sprintf(`python3 -c 'import socket, time
end = time.time() + 90
while time.time() < end:
    s = socket.socket(); s.settimeout(1)
    try: s.connect((%q, 9))
    except OSError: pass
    if any(l.split()[0] == %q and l.split()[2] == "0x0" for l in open("/proc/net/arp").readlines()[1:]):
        break
    time.sleep(0.5)
time.sleep(4)'`, ip, ip), 120_000)
	if got := entry(); !strings.HasPrefix(got, "0x0 ") {
		t.Fatalf("the peer's entry for the gone target is %q, not unresolved", got)
	}

	// The announcement is a broadcast ARP from the target for its own
	// address; the claim's bridge on the host sees every broadcast.
	pcap := filepath.Join(t.TempDir(), "announce.pcap")
	dump := exec.Command("tcpdump", "-i", "kfb"+hexSum(n.WorkloadGroupID), "-nn", "-U", "-w", pcap,
		fmt.Sprintf("arp and arp[6:2] == 1 and arp[14:4] == %s and arp[24:4] == %s", hexIP(ip), hexIP(ip)))
	if err := dump.Start(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	target.Address = ip
	start := time.Now()
	if _, err := s.Backend.Restore(ctx, snap, target); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Backend.Destroy(context.Background(), target.Name, isolation.DestroyOptions{}) })
	var got string
	for time.Since(start) < 2*time.Second {
		if got = entry(); got == "0x2 "+mac {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	time.Sleep(time.Second)
	_ = dump.Process.Signal(syscall.SIGINT)
	_ = dump.Wait()
	read, _ := exec.Command("tcpdump", "-nn", "-r", pcap).CombinedOutput()
	announced := strings.Contains(string(read), "who-has "+ip+" tell "+ip)
	t.Logf("gratuitous ARP from the restored target on its bridge: %v\n%s", announced, read)
	if !announced {
		t.Fatal("the restored target did not announce its address")
	}
	if got != "0x2 "+mac {
		t.Fatalf("the peer's entry for the restored target is %q, want 0x2 %s", got, mac)
	}
	t.Logf("the peer knew the restored target %d ms after the restore began", time.Since(start).Milliseconds())
	if r := run(t, peer, reach, 10_000); !strings.Contains(r.Stdout, "refused") {
		t.Fatalf("the peer reaching the restored target: %q %q", r.Stdout, r.Stderr)
	}
}

// hexIP is an IPv4 address as the hex number tcpdump compares a field to.
func hexIP(ip string) string {
	var b [4]int
	_, _ = fmt.Sscanf(ip, "%d.%d.%d.%d", &b[0], &b[1], &b[2], &b[3])
	return fmt.Sprintf("0x%02x%02x%02x%02x", b[0], b[1], b[2], b[3])
}

// macOfIP is hostnet's MAC for a machine address (06:00:a.b.c.d).
func macOfIP(ip string) string {
	var b [4]int
	_, _ = fmt.Sscanf(ip, "%d.%d.%d.%d", &b[0], &b[1], &b[2], &b[3])
	return fmt.Sprintf("06:00:%02x:%02x:%02x:%02x", b[0], b[1], b[2], b[3])
}
