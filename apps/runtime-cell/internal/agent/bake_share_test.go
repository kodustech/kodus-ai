//go:build unix

package agent

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

var sharedSample = []driver.SharedImage{{Fingerprint: strings.Repeat("f", 64), Digest: "sha256:" + strings.Repeat("d", 64)}}

func isImageShared(f any) bool { _, ok := f.(*protocol.ImageSharedBody); return ok }

func sharingHarness(t *testing.T, accepts ...string) *harness {
	t.Helper()
	h := newHarness(t, func(c *Config) {
		d := c.Driver.(*fake.Driver)
		d.ShareBakes, d.Shared = true, sharedSample
	})
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: accepts})
	return h
}

func bakeSetup(t *testing.T, h *harness) {
	t.Helper()
	readySetupClaim(t, h)
	if err := h.handle("claim-1", protocol.MessageTypeImageBake, &protocol.ImageBakeBody{OrgID: "org-a", EnvironmentID: "env-1", Sha: testSHA, RecipeSha: "r"}); err != nil {
		t.Fatal(err)
	}
	h.a.Wait()
}

// What a bake pushed to the org's registry reaches a hub that accepts
// bakeShare as image.shared, keyed as the image.bake was; the bake was told
// the setup claim's secret values (its download token among them), so no
// image carrying one is pushed.
func TestABakesSharedImagesReachAHubThatAcceptsThem(t *testing.T) {
	h := sharingHarness(t, protocol.FeatureBakeShare)
	bakeSetup(t, h)
	got := h.conn.next(t, isImageShared).(*protocol.ImageSharedBody)
	want := []protocol.ClaimAcquireBodySharedImagesItem{{Fingerprint: sharedSample[0].Fingerprint, Digest: sharedSample[0].Digest}}
	if got.OrgID != "org-a" || got.EnvironmentID != "env-1" || got.Sha != testSHA || got.RecipeSha != "r" || got.RefsDigest != nil || !slices.Equal(got.Images, want) {
		t.Fatalf("image.shared %+v", got)
	}
	if bakes := h.drv.BakesSnapshot(); len(bakes) != 1 || !slices.Contains(bakes[0].Secrets, "ghs_download") {
		t.Fatalf("the bake was not told the claim's secret values: %+v", bakes)
	}
}

// A hub older than bakeShare (its hello ack accepts none of it) never gets
// image.shared, which its strict decoder would refuse; the bake still stands.
func TestAnOlderHubNeverHearsImageShared(t *testing.T) {
	h := sharingHarness(t)
	bakeSetup(t, h)
	if n := h.conn.attempts(isImageShared); n != 0 || len(h.drv.BakesSnapshot()) != 1 {
		t.Fatalf("%d image.shared sent to an older hub", n)
	}
}

// sharedComposer keeps the shared images each Up was given.
type sharedComposer struct {
	mu   sync.Mutex
	asks [][]driver.SharedImage
}

func (c *sharedComposer) Up(_ context.Context, req driver.UpRequest) ([]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.asks = append(c.asks, req.SharedImages)
	return []string{"172.30.0.2"}, nil
}

// A Run's claim hands its builds the environment's shared images, by
// fingerprint and digest; a setup, which builds what the environment keeps,
// never takes another cell's image.
func TestAClaimsSharedImagesReachItsBuildsButNeverASetups(t *testing.T) {
	cp := &sharedComposer{}
	h := newHarness(t, func(c *Config) {
		c.Parts.Composer = cp
		c.Driver.(*fake.Driver).ShareBakes = true
	})
	items := []protocol.ClaimAcquireBodySharedImagesItem{{Fingerprint: sharedSample[0].Fingerprint, Digest: sharedSample[0].Digest}}
	for _, consumer := range []protocol.Consumer{protocol.ConsumerRuntime, protocol.ConsumerSetup} {
		b := h.acquireBody()
		b.Consumer, b.SharedImages = consumer, items
		b.HardExpiresAt = protocol.FormatTime(h.clk.Now().Add(40 * time.Minute))
		b.Expose = []protocol.Expose{{Service: "api", Port: 3000, Kind: protocol.ExposeKindHTTP}}
		if err := h.handle("claim-"+string(consumer), protocol.MessageTypeClaimAcquire, b); err != nil {
			t.Fatal(err)
		}
		h.conn.next(t, isReady)
	}
	cp.mu.Lock()
	defer cp.mu.Unlock()
	if len(cp.asks) != 2 || !slices.Equal(cp.asks[0], sharedSample) || len(cp.asks[1]) != 0 {
		t.Fatalf("ups were given %+v", cp.asks)
	}
}
