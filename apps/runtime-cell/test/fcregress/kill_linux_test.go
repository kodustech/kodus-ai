//go:build linux

package fcregress

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/hostnet"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// S-49, the cell's half: twenty live claims the hub releases at once (what
// a runtime stop of the org sends) leave no machine, no jail and no claim
// network on the cell well inside two minutes. Their download tokens were
// revoked as each fetch ended (internal/tarball TestFetchRevokesOnEveryPath);
// the Run tokens are the control plane's.
func TestFirecrackerTwentyClaimsReleasedAtOnceLeaveNothingWithinTwoMinutes(t *testing.T) {
	s := open(t)
	p := startProtoCell(t, s)
	stamp := time.Now().Format("150405")
	claims := make([]string, 20)
	start := time.Now()
	for i := range claims {
		claims[i] = fmt.Sprintf("fc-kill-%s-%02d", stamp, i)
		p.sandbox(claims[i], func(b *protocol.SandboxAcquireBody) { b.Size = &protocol.MachineSize{MemoryMb: 512, Cpus: 1} })
	}
	booted := time.Since(start)
	ctx := context.Background()
	baseVMMs, baseLinks := len(firecrackers(t)), claimLinks()
	live, _ := s.Driver.List(ctx, map[string]string{driver.TagCell: cellID})
	if len(live) < len(claims) {
		t.Fatalf("the control failed: %d machines for %d claims", len(live), len(claims))
	}
	start = time.Now()
	var wg sync.WaitGroup
	for _, c := range claims {
		wg.Go(func() {
			if err := p.hub.Send(ctx, cellID, c, &protocol.ClaimReleaseBody{}); err != nil {
				t.Errorf("release %s: %v", c, err)
			}
		})
	}
	wg.Wait()
	for {
		left, err := s.Driver.List(ctx, map[string]string{driver.TagCell: cellID})
		if err != nil {
			t.Fatal(err)
		}
		if len(left) == 0 {
			break
		}
		if time.Since(start) > 2*time.Minute {
			t.Fatalf("%d machines left two minutes after the release", len(left))
		}
		time.Sleep(200 * time.Millisecond)
	}
	gone := time.Since(start)
	// What the twenty claims held: their VMMs and their bridges and taps
	// (whatever else the host holds stays as it was).
	jails, nets := leftovers(t, baseVMMs-len(claims), baseLinks-2*len(claims))
	if jails > baseVMMs-len(claims) || nets > baseLinks-2*len(claims) {
		t.Fatalf("after the release: %d VMM processes and %d claim links of %d and %d before", jails, nets, baseVMMs, baseLinks)
	}
	t.Logf("EVIDENCE S-49 %d sandboxes booted in %v; all released at once, no machine left in %v, no VMM or claim link after", len(claims), booted.Round(time.Millisecond), gone.Round(time.Millisecond))
}

// leftovers are the firecracker processes and the claim network links the host holds, once down to want or after 30 s.
func leftovers(t *testing.T, wantVMMs, wantLinks int) (vmms, links int) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		vmms = len(firecrackers(t))
		links = claimLinks()
		if vmms <= wantVMMs && links <= wantLinks || time.Now().After(deadline) {
			return vmms, links
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// claimLinks counts the claim bridges and taps on the host.
func claimLinks() int {
	ents, _ := os.ReadDir("/sys/class/net")
	n := 0
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), hostnet.BridgePrefix) || strings.HasPrefix(e.Name(), hostnet.TapPrefix) {
			n++
		}
	}
	return n
}
