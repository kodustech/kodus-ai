package firecracker

import (
	"context"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// F2-02: a reset in place (and a round's own first restore) ends the machine
// before its new record is written. A snapshot sweep in that gap found the
// round's claim with no machine and, its round being older than a minute,
// removed it under the restore: the claim lost its machine and its round.
func TestASweepDuringARestoreInPlaceKeepsTheRound(t *testing.T) {
	b, _, _ := snapBackend(t)
	ctx := context.Background()
	claimSandbox(t, b, "kodus-run1-workload", "kodus-run1", "run1")
	late := time.Now().Add(time.Hour)
	swept := 0
	b.restoreGap = func() {
		swept++
		if _, err := b.SweepSnapshots(late); err != nil {
			t.Error(err)
		}
	}
	snap, _, err := b.SnapshotRound(ctx, "kodus-run1-workload")
	if err != nil {
		t.Fatalf("the round's first restore: %v", err)
	}
	if _, err := b.RestoreInPlace(ctx, "kodus-run1-workload", snap); err != nil {
		t.Fatalf("a reset whose round a sweep met mid-restore: %v", err)
	}
	if swept != 2 {
		t.Fatalf("the gap ran %d times", swept)
	}
	// Once the claim's machine is back, the round is the claim's again;
	// with no machine at all it goes, as before.
	if err := b.Destroy(ctx, "kodus-run1-workload", isolation.DestroyOptions{}); err != nil {
		t.Fatal(err)
	}
	b.restoreGap = nil
	if gone, err := b.SweepSnapshots(late); err != nil || len(gone) != 1 {
		t.Fatalf("an orphan round: gone %v, %v", gone, err)
	}
}
