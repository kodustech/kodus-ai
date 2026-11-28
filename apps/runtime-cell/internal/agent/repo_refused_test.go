package agent

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
)

type failingExtractor struct{ err error }

func (e failingExtractor) Extract(context.Context, string, string) (tarball.Stats, error) {
	return tarball.Stats{}, e.err
}

// An archive the extractor refuses is the repository's to change
// (toolchain, repo_refused); any other extraction failure is the platform's,
// even when the text of it names a refusal (a path can say anything).
func TestARefusedArchiveIsTheRepositorysToChange(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		kind protocol.BlockerKind
		sig  string
	}{
		{"refused", fmt.Errorf("tarball: extractor: %w", &tarball.RefusedError{Entry: "p/.git/config", Reason: ".git entry (hooks, config)"}), protocol.BlockerKindToolchain, "repo_refused"},
		{"only says refused", errors.New(`tarball: p/tarball: refused "x"/a: no space left on device`), protocol.BlockerKindPlatform, "repo_fetch"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, func(c *Config) { c.Extractor = failingExtractor{tc.err} })
			if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, h.acquireBody()); err != nil {
				t.Fatal(err)
			}
			f := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
			if f.Kind != tc.kind || f.Signature != tc.sig {
				t.Fatalf("claim.failed %s/%s, want %s/%s", f.Kind, f.Signature, tc.kind, tc.sig)
			}
		})
	}
}
