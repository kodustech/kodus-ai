package agent

import (
	"archive/tar"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/yamlbound"
)

// A PR's compose file past the cap fails the claim with the compose_load
// blocker and says why, before the cell parses it (review #3).
func TestAComposeFileOverTheCapFailsTheClaimWithItsBlocker(t *testing.T) {
	srv := repoServerWith(t, func(tw *tar.Writer) {
		compose := "services:\n  api:\n    image: alpine:3.20\n" + strings.Repeat("#", yamlbound.MaxFileBytes)
		_ = tw.WriteHeader(&tar.Header{Name: "o-r-0123/compose.yaml", Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(compose))})
		_, _ = tw.Write([]byte(compose))
	})
	h := newHarness(t, func(c *Config) {
		c.Parts.Composer = &canaryComposer{}
		c.Repo = func(protocol.ClaimAcquireBody) (string, error) { return srv + "/tarball", nil }
	})
	b := h.acquireBody()
	b.Expose = []protocol.Expose{{Service: "api", Port: 3000, Kind: protocol.ExposeKindHTTP}}
	if err := h.handle("claim-big", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	f := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
	if f.Kind != protocol.BlockerKindRecipeOutdated || f.Signature != "compose_load" || !strings.Contains(f.Reason, "over 1 MiB") {
		t.Fatalf("claim.failed %+v", f)
	}
}
