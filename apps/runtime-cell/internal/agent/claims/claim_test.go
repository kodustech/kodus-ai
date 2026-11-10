package claims

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// The acquire's approved hosts are the claim's allowlist from the start, so
// the policy pushed before the build has them; any egress.policy, whenever
// the hub issued it, replaces them.
func TestNewStartsWithTheAcquireAllowlist(t *testing.T) {
	c := New("claim-1", protocol.ClaimAcquireBody{EgressAllow: []string{"dl-cdn.alpinelinux.org"}}, slog.Default(), time.Now())
	allow, _, ok := c.PendingAllow()
	if !ok || !slices.Equal(allow, []string{"dl-cdn.alpinelinux.org"}) {
		t.Fatalf("pending %v %v", allow, ok)
	}
	if stale, ok := c.SetAllow([]string{"registry.npmjs.org"}, time.Unix(1, 0)); stale || !ok {
		t.Fatalf("an egress.policy is never stale against the acquire's list: %v %v", stale, ok)
	}
	if allow, _, _ := c.PendingAllow(); !slices.Equal(allow, []string{"registry.npmjs.org"}) {
		t.Fatalf("replaced %v", allow)
	}
	if allow, _, ok := New("claim-2", protocol.ClaimAcquireBody{}, slog.Default(), time.Now()).PendingAllow(); !ok || len(allow) != 0 {
		t.Fatalf("no approved hosts: %v %v", allow, ok)
	}
}

func TestActiveStepsAreSeparateFromCancellationAndDelivery(t *testing.T) {
	c := New("claim-1", protocol.ClaimAcquireBody{}, slog.Default(), time.Now())
	ctx, cancel := context.WithCancel(context.Background())
	if err := c.TryAddStep("first", cancel, 1); err != nil {
		t.Fatal(err)
	}
	if !c.CancelStep("first") || ctx.Err() == nil {
		t.Fatal("step was not cancelled")
	}
	_, refusedCancel := context.WithCancel(context.Background())
	if err := c.TryAddStep("second", refusedCancel, 1); !errors.Is(err, ErrStepCapacity) {
		t.Fatalf("cancel freed work: %v", err)
	}
	c.CompleteStep("first")
	c.CompleteStep("first")
	if !c.CancelStep("first") {
		t.Fatal("completion removed cancellation")
	}
	if err := c.TryAddStep("second", func() {}, 1); err != nil {
		t.Fatal(err)
	}
	c.RemoveStep("first")
	c.RemoveStep("first")
	if err := c.TryAddStep("third", func() {}, 1); !errors.Is(err, ErrStepCapacity) {
		t.Fatalf("repeated cleanup freed another step: %v", err)
	}
	c.RemoveStep("second")
	if err := c.TryAddStep("third", func() {}, 1); err != nil {
		t.Fatal(err)
	}
	c.Release()
	if err := c.TryAddStep("fourth", func() {}, 1); !errors.Is(err, ErrStepUnavailable) {
		t.Fatalf("released claim accepted work: %v", err)
	}
}
