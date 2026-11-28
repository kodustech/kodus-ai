package dockergvisor

import (
	"context"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// F1-02: under claim limits the golden copies (a first boot's, a reset's
// restore) ran their helper with no cgroup parent, outside the claim's
// memory, CPU and pids budget; every other copy of a claim's data refuses
// that. Each copy now runs under the claim's parent.
func TestUnderClaimLimitsTheGoldenCopiesRunUnderTheClaimsParent(t *testing.T) {
	r := newGoldenRig(t, goldenCompose, goldenRecipe, func(c *Config) { c.ClaimLimits = &fakeClaimLimits{} })
	r.up(t)
	if err := r.d.Reset(context.Background(), r.ref, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	r.up(t)
	parent, err := r.d.parentFor(context.Background(), r.ref)
	if err != nil || parent == "" {
		t.Fatalf("the claim's parent %q: %v", parent, err)
	}
	r.docker.mu.Lock()
	copies, parents := len(r.docker.copies), append([]string(nil), r.docker.copyParents...)
	r.docker.mu.Unlock()
	if copies < 2 {
		t.Fatalf("copies %d, want the golden take and its restore", copies)
	}
	if len(parents) != copies {
		t.Fatalf("%d copies, %d under a parent: a helper ran outside the claim's budget", copies, len(parents))
	}
	for _, p := range parents {
		if p != parent {
			t.Fatalf("a copy ran under %q, not the claim's %q", p, parent)
		}
	}
}
