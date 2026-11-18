//go:build linux

package fcregress

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/hostnet"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Round 3's open finding (the Firecracker spike): the first probe
// right after a round snapshot came back unreachable from the observer in
// 3 of 34 rounds, never after a memory reset. This repeats what a Run does
// at first ready on one demo-shop Run, both sides at once: a probe through
// the observer, the round, and the next probe at once; then the round goes
// (only the newest is kept). A first probe that fails is probed again every
// 250 ms until it answers, and the observer's and the workload's ARP and
// TCP tables, the host's bridge and a capture of the observer's link (ARP
// and port 3000, from before the round) are kept. Opt-in, as root, with
// the demo-shop checkouts and KODY_E2E_AGENT_LOG=info (probe.refused names
// the transport error):
//
//	KODY_E2E_ROUND_PROBES=N KODY_E2E_ROUND_PROBE_DIR=<dir> -run TestNestedSpikeRoundThenProbe
func TestNestedSpikeRoundThenProbe(t *testing.T) {
	n := envInt("KODY_E2E_ROUND_PROBES", 0)
	if n == 0 {
		t.Skip("KODY_E2E_ROUND_PROBES=N takes N rounds on each side of one Run")
	}
	out := os.Getenv("KODY_E2E_ROUND_PROBE_DIR")
	if out == "" {
		out = t.TempDir()
	}
	r := newSpikeRun(t, time.Now().Add(3*time.Hour))
	r.setupAndBake(t)
	stamp := time.Now().Format("150405")
	base, pr := "spk-rb-base-"+stamp, "spk-rb-pr-"+stamp
	t.Cleanup(func() { r.release(base); r.release(pr) })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	var wg sync.WaitGroup
	var errB, errP error
	wg.Go(func() { _, _, errB = r.acquire(ctx, base, protocol.SideBase, protocol.ConsumerRuntime, r.baseSHA) })
	wg.Go(func() { _, _, errP = r.acquire(ctx, pr, protocol.SidePr, protocol.ConsumerRuntime, r.prSHA) })
	wg.Wait()
	cancel()
	if errB != nil || errP != nil {
		t.Fatalf("the Run: %v %v", errB, errP)
	}
	rctx, rcancel := context.WithCancel(context.Background())
	defer rcancel()
	go func() {
		tick := time.NewTicker(time.Minute)
		defer tick.Stop()
		for {
			select {
			case <-rctx.Done():
				return
			case <-tick.C:
			}
			for _, c := range []string{base, pr} {
				_ = r.d.hub.Send(rctx, cellID, c, &protocol.ClaimRenewBody{LeaseExpiresAt: protocol.FormatTime(time.Now().Add(5 * time.Minute))})
			}
		}
	}()

	var mu sync.Mutex
	failed, rounds := 0, 0
	prev := map[string]string{}
	for i := range n {
		var iw sync.WaitGroup
		for _, claim := range []string{base, pr} {
			iw.Go(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
				defer cancel()
				if p, err := r.probe(ctx, claim, "/orders"); err != nil || p.HTTP.Status != 200 {
					t.Errorf("round %d %s: the probe before the round: %+v %v", i, claim, p, err)
					return
				}
				pcap := filepath.Join(out, fmt.Sprintf("round-%02d-%s.pcap", i, claim))
				stop := captureLink(t, hostnet.TapName(fmt.Sprintf("kodus-%s-observer", claim)), pcap)
				id, start := hubclient.NewID(), time.Now()
				res, err := r.step(ctx, claim, &protocol.ClaimSnapshotBody{StepID: id, Purpose: protocol.ClaimSnapshotBodyPurposeRound}, id)
				if err != nil || res.Snapshot == nil {
					stop(false)
					t.Errorf("round %d %s: %+v %v", i, claim, res, err)
					return
				}
				took := time.Since(start)
				back := time.Now()
				p, err := r.probe(ctx, claim, "/orders")
				ok := err == nil && p.HTTP.Status == 200
				first := time.Since(back)
				mu.Lock()
				rounds++
				if !ok {
					failed++
				}
				mu.Unlock()
				switch {
				case ok && first < slowFirstProbe:
					stop(false)
					t.Logf("SPIKE round-probe %d %s: round %d ms, first probe ok in %d ms", i, claim, took.Milliseconds(), first.Milliseconds())
				case ok:
					// Slow but answered: a probe answers in about 10 ms.
					t.Logf("SPIKE round-probe %d %s: round %d ms, first probe SLOW, ok in %d ms", i, claim, took.Milliseconds(), first.Milliseconds())
					roundDiagnostics(t, r, claim)
					stop(true)
					t.Logf("SPIKE round-probe %d %s: capture kept at %s", i, claim, pcap)
				default:
					t.Logf("SPIKE round-probe %d %s: round %d ms, FIRST PROBE FAILED after %d ms: %v", i, claim, took.Milliseconds(), first.Milliseconds(), err)
					recovered := time.Duration(-1)
					for again := time.Now(); time.Since(again) < 30*time.Second; time.Sleep(250 * time.Millisecond) {
						if p, err := r.probe(ctx, claim, "/orders"); err == nil && p.HTTP.Status == 200 {
							recovered = time.Since(back)
							break
						}
					}
					t.Logf("SPIKE round-probe %d %s: answered again %d ms after the round returned", i, claim, recovered.Milliseconds())
					roundDiagnostics(t, r, claim)
					stop(true)
					t.Logf("SPIKE round-probe %d %s: capture kept at %s", i, claim, pcap)
				}
				mu.Lock()
				old := prev[claim]
				prev[claim] = res.Snapshot.ID
				mu.Unlock()
				if old != "" {
					_ = r.s.Backend.Store().Remove(r.orgID, old)
				}
			})
		}
		iw.Wait()
	}
	t.Logf("SPIKE round-probe: %d of %d first probes after a round failed", failed, rounds)
	if failed > 0 {
		t.Errorf("%d of %d first probes after a round failed", failed, rounds)
	}
}

// slowFirstProbe is a first probe slow enough to keep its capture: one
// through a warm observer answers in about 10 ms.
const slowFirstProbe = 300 * time.Millisecond

// captureLink records ARP and port 3000 on a host link until stop; stop
// keeps the file only when asked (and prints it into the log then).
func captureLink(t *testing.T, link, path string) (stop func(keep bool)) {
	t.Helper()
	cmd := exec.Command("tcpdump", "-i", link, "-nn", "-U", "-w", path, "arp or tcp port 3000")
	if err := cmd.Start(); err != nil {
		t.Logf("SPIKE capture on %s: %v", link, err)
		return func(bool) {}
	}
	return func(keep bool) {
		_ = cmd.Process.Signal(syscall.SIGINT)
		_ = cmd.Wait()
		if !keep {
			_ = os.Remove(path)
			return
		}
		read, _ := exec.Command("tcpdump", "-nn", "-tttt", "-r", path).CombinedOutput()
		lines := strings.Split(strings.TrimSpace(string(read)), "\n")
		if len(lines) > 80 {
			lines = lines[len(lines)-80:]
		}
		t.Logf("SPIKE capture %s (last %d lines):\n%s", link, len(lines), strings.Join(lines, "\n"))
	}
}

// roundDiagnostics logs what the observer and the workload know of each
// other, and what the host's bridge has learnt.
func roundDiagnostics(t *testing.T, r *spikeRun, claim string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for _, role := range []driver.Role{driver.RoleObserver, driver.RoleWorkload} {
		refs, err := r.s.Driver.List(ctx, map[string]string{"kodus:claim": claim, "kodus:role": string(role)})
		if err != nil || len(refs) != 1 {
			t.Logf("SPIKE diag %s %s: %d machines %v", claim, role, len(refs), err)
			continue
		}
		res, err := r.s.Driver.Exec(ctx, refs[0], kodyexec.Request{Command: "cat /proc/net/arp; echo; cat /proc/net/tcp; echo; cat /proc/net/snmp | grep -E '^(Tcp|Ip):'", TimeoutMs: 10_000})
		t.Logf("SPIKE diag %s %s (%s): %v\n%s%s", claim, role, refs[0].PrivateAddress, err, res.Stdout, res.Stderr)
	}
	br := "kfb" + hexSum("kodus-"+claim)
	fdb, _ := exec.Command("bridge", "fdb", "show", "br", br).CombinedOutput()
	links, _ := exec.Command("ip", "-d", "link", "show", "master", br).CombinedOutput()
	t.Logf("SPIKE diag %s bridge %s:\n%s\n%s", claim, br, fdb, links)
}

func hexSum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:5])
}
