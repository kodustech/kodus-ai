package agent

import (
	"archive/tar"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

func identityHarness(t *testing.T) (*harness, *canaryComposer) {
	t.Helper()
	srv := repoServerWith(t, func(tw *tar.Writer) {
		const compose = "services:\n  api:\n    image: alpine:3.20\n    environment: { KODUS_RUN_USER: from-the-pr }\n  db:\n    image: postgres:16\n    hostname: db-own\n"
		_ = tw.WriteHeader(&tar.Header{Name: "o-r-0123/compose.yaml", Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(compose))})
		_, _ = tw.Write([]byte(compose))
	})
	cp := &canaryComposer{}
	h := newHarness(t, func(c *Config) {
		c.Parts.Composer = cp
		c.Repo = func(protocol.ClaimAcquireBody) (string, error) { return srv + "/tarball", nil }
	})
	return h, cp
}

func identityAcquire(b *protocol.ClaimAcquireBody) {
	b.Expose = []protocol.Expose{{Service: "api", Port: 3000, Kind: protocol.ExposeKindHTTP}}
	b.Identity = &protocol.ClaimAcquireBodyIdentity{Hostname: "kr-3f9a1c0b", User: "u3f9a1c0b7d", Domain: "d7e2b9a41c.test"}
}

// S-36: a Run's drawn identifiers reach every service's env, over whatever
// the checkout set under those names, so a recipe's seed reads the Run's
// values and a PR cannot pin them; a service that names no hostname gets
// the drawn one, one that names its own keeps it.
func TestARunsClaimSetsItsDrawnIdentity(t *testing.T) {
	h, cp := identityHarness(t)
	h.ready("claim-pr", func(b *protocol.ClaimAcquireBody) {
		b.Side = protocol.SidePr
		identityAcquire(b)
	})
	cp.mu.Lock()
	defer cp.mu.Unlock()
	file := string(cp.file)
	for _, want := range []string{"KODUS_RUN_HOSTNAME: kr-3f9a1c0b", "KODUS_RUN_USER: u3f9a1c0b7d", "KODUS_RUN_DOMAIN: d7e2b9a41c.test", "hostname: kr-3f9a1c0b", "hostname: db-own"} {
		if !strings.Contains(file, want) {
			t.Fatalf("compose lacks %q:\n%s", want, file)
		}
	}
	if strings.Contains(file, "from-the-pr") || strings.Count(file, "KODUS_RUN_USER: u3f9a1c0b7d") != 2 {
		t.Fatalf("the drawn user is not every service's:\n%s", file)
	}
}

// A setup's workload may become the environment's image: a Run's values
// baked into it would be every later Run's, so a setup sets none.
func TestASetupSetsNoDrawnIdentity(t *testing.T) {
	h, cp := identityHarness(t)
	h.ready("claim-setup", func(b *protocol.ClaimAcquireBody) {
		b.Consumer, b.Side, b.HardExpiresAt = protocol.ConsumerSetup, protocol.SideSetup, protocol.FormatTime(h.clk.Now().Add(40*time.Minute))
		identityAcquire(b)
	})
	cp.mu.Lock()
	defer cp.mu.Unlock()
	if strings.Contains(string(cp.file), "kr-3f9a1c0b") || strings.Contains(string(cp.file), "KODUS_RUN_DOMAIN") {
		t.Fatalf("a setup set a Run's identity:\n%s", cp.file)
	}
}
