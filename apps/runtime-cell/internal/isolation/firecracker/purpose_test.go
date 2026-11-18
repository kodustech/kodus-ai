package firecracker

import (
	"context"
	"errors"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/vmsnap"
)

// F2-03: Restore chose Claim or Open from the caller's purpose and never
// compared it with the manifest's, so a session id given as a template
// restored without being claimed, as often as asked, into other claims.
func TestASnapshotRestoresOnlyAsWhatItIs(t *testing.T) {
	b, _, _ := snapBackend(t)
	ctx := context.Background()
	if _, err := b.Create(ctx, isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-a-workload", Network: "kodus-a", Memory: "128m", Org: "org-a"}); err != nil {
		t.Fatal(err)
	}
	session, err := b.Snapshot(ctx, "kodus-a-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeSession, Org: "org-a"})
	if err != nil {
		t.Fatal(err)
	}
	asTemplate := session
	asTemplate.Purpose = isolation.PurposeTemplate
	for i, name := range []string{"kodus-b-workload", "kodus-c-workload"} {
		if _, err := clone(t, b, asTemplate, name, "kodus-"+string(rune('b'+i)), "org-a"); !errors.Is(err, vmsnap.ErrRefused) {
			t.Fatalf("a session restored as a template (%d): %v", i, err)
		}
	}
	// Still the one restore it was taken for.
	if _, err := clone(t, b, session, "kodus-d-workload", "kodus-d", "org-a"); err != nil {
		t.Fatalf("the session's own restore: %v", err)
	}
}

// A template restores only as its environment's when the restore names one.
func TestATemplateRestoresOnlyIntoItsEnvironmentWhenOneIsNamed(t *testing.T) {
	b, _, _ := snapBackend(t)
	ctx := context.Background()
	setupSandbox(t, b, "kodus-a-workload", "kodus-a")
	tpl, err := b.Snapshot(ctx, "kodus-a-workload", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate, Org: "org-a", Key: "env-1"})
	if err != nil {
		t.Fatal(err)
	}
	other := tpl
	other.Key = "env-2"
	if _, err := clone(t, b, other, "kodus-b-workload", "kodus-b", "org-a"); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("another environment's template restored: %v", err)
	}
	own := tpl
	own.Key = "env-1"
	if _, err := clone(t, b, own, "kodus-c-workload", "kodus-c", "org-a"); err != nil {
		t.Fatalf("its own environment's: %v", err)
	}
}
