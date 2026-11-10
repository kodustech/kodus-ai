package agent

import (
	"archive/tar"
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// canaryComposer keeps what each Up was handed: the compose file and the
// decoys on its context.
type canaryComposer struct {
	mu       sync.Mutex
	file     []byte
	canaries []driver.Canary
}

func (c *canaryComposer) Up(ctx context.Context, _ driver.MachineRef, file []byte, _ string) ([]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.file, c.canaries = file, driver.CanariesFrom(ctx)
	return []string{"172.30.0.2"}, nil
}

const (
	configCanary = "kdx_live_0123456789abcdef0123456789abcdef"
	npmrcCanary  = "npm_0123456789abcdef0123456789abcdef"
)

func canaryAcquire(b *protocol.ClaimAcquireBody) {
	b.Expose = []protocol.Expose{{Service: "api", Port: 3000, Kind: protocol.ExposeKindHTTP}}
	b.Canaries = []protocol.ClaimAcquireBodyCanariesItem{
		{Slot: protocol.ClaimAcquireBodyCanariesItemSlotConfig, Value: configCanary},
		{Slot: protocol.ClaimAcquireBodyCanariesItemSlotNpmrc, Value: npmrcCanary},
	}
}

func canaryHarness(t *testing.T) (*harness, *canaryComposer) {
	t.Helper()
	srv := repoServerWith(t, func(tw *tar.Writer) {
		const compose = "services:\n  api:\n    image: alpine:3.20\n    environment: { KODUS_DEPLOY_KEY: from-the-pr }\n"
		_ = tw.WriteHeader(&tar.Header{Name: "o-r-0123/compose.yaml", Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(compose))})
		_, _ = tw.Write([]byte(compose))
	})
	cp := &canaryComposer{}
	h := newHarness(t, func(c *Config) {
		c.Composer = cp
		c.Repo = func(protocol.ClaimAcquireBody) (string, error) { return srv + "/tarball", nil }
	})
	return h, cp
}

// S-29/S-48: a Run's claim plants its decoys. They used to be checked by
// the worker and never planted anywhere a compromised PR could find them,
// so no sighting could ever come. The config slot goes into every
// service's env, over whatever the checkout set under that name; the
// driver gets them all for the credentials file.
func TestARunsClaimPlantsItsCanaries(t *testing.T) {
	h, cp := canaryHarness(t)
	h.ready("claim-pr", func(b *protocol.ClaimAcquireBody) {
		b.Side = protocol.SidePr
		canaryAcquire(b)
	})
	cp.mu.Lock()
	defer cp.mu.Unlock()
	if !strings.Contains(string(cp.file), "KODUS_DEPLOY_KEY: "+configCanary) || strings.Contains(string(cp.file), "from-the-pr") {
		t.Fatalf("the config canary is not the services' env: %s", cp.file)
	}
	if len(cp.canaries) != 2 || driver.CanaryFileOf(cp.canaries) != "//registry.npmjs.org/:_authToken="+npmrcCanary+"\n" {
		t.Fatalf("the driver got %v", cp.canaries)
	}
	// Nothing the cell sent carries one, nor its log.
	h.conn.mu.Lock()
	sent, _ := json.Marshal(h.conn.frames)
	h.conn.mu.Unlock()
	for _, v := range []string{configCanary, npmrcCanary} {
		if strings.Contains(string(sent), v) || strings.Contains(h.logs.String(), v) {
			t.Fatalf("a frame or the log carries a canary")
		}
	}
}

// A setup's workload may become the environment's (a bake): a decoy in it
// would reach every later claim, so a setup plants none, whatever it asks.
func TestASetupPlantsNoCanary(t *testing.T) {
	h, cp := canaryHarness(t)
	h.ready("claim-setup", func(b *protocol.ClaimAcquireBody) {
		b.Consumer, b.Side, b.HardExpiresAt = protocol.ConsumerSetup, protocol.SideSetup, protocol.FormatTime(h.clk.Now().Add(40*time.Minute))
		canaryAcquire(b)
	})
	cp.mu.Lock()
	defer cp.mu.Unlock()
	if strings.Contains(string(cp.file), configCanary) || cp.canaries != nil {
		t.Fatalf("a setup planted a canary: %v %s", cp.canaries, cp.file)
	}
}
