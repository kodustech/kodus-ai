package dockercli

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// Cancelling the Docker CLI did not stop the unnamed data helper. The cell
// then returned its reservation while the helper could still consume it.
func TestCopyVolumeBoundNamesLabelsAndRemovesItsHelperAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	deadline := time.Now().Add(time.Minute).Truncate(time.Second)
	ctx, stop := context.WithDeadline(ctx, deadline)
	defer stop()
	labels := map[string]string{"kodus.cell": "cell-owned", "kodus.org": "org-owned"}
	var runArgs, removeArgs []string
	c := CLI{Run: func(rctx context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		switch args[0] {
		case "run":
			runArgs = append([]string(nil), args...)
			cancel()
			return nil, context.Canceled
		case "rm":
			removeArgs = append([]string(nil), args...)
			if rctx.Err() != nil {
				t.Error("helper cleanup reused cancelled context")
			}
			until, ok := rctx.Deadline()
			if !ok || time.Until(until) <= 0 || time.Until(until) > 5*time.Second {
				t.Errorf("cleanup not bounded independently: %v %v", until, ok)
			}
		}
		return nil, nil
	}}
	err := c.CopyVolumeBound(ctx, "runsc", "helper", "source", "target", labels, "/cell/claim")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("lost cancellation: %v", err)
	}
	if errors.Is(err, driver.ErrResourceCleanupPending) {
		t.Fatalf("successful cleanup left pending state: %v", err)
	}
	if len(removeArgs) == 0 {
		t.Fatal("helper was never removed")
	}
	name := removeArgs[len(removeArgs)-1]
	if !strings.HasPrefix(name, "kodus-copy-") || !strings.Contains(strings.Join(runArgs, " "), "--name "+name+" ") {
		t.Fatalf("run/removal identity mismatch: %q %q", runArgs, removeArgs)
	}
	for _, want := range []string{"--label kodus.cell=cell-owned", "--label kodus.org=org-owned", "--label kodus.hard-expires=" + deadline.UTC().Format(time.RFC3339), "--cgroup-parent /cell/claim"} {
		if !strings.Contains(strings.Join(runArgs, " "), want) {
			t.Fatalf("helper missing %q: %q", want, runArgs)
		}
	}
	if len(labels) != 2 {
		t.Fatalf("container expiry polluted volume metadata: %v", labels)
	}
}

func TestCopyVolumeBoundReturnsPendingWhenRemovalCannotBeConfirmed(t *testing.T) {
	for _, tc := range []struct {
		name      string
		removeErr error
		pending   bool
	}{
		{"removed", nil, false},
		{"already-gone", errors.New("Error response from daemon: No such container: owned"), false},
		{"daemon-unreachable", errors.New("daemon unreachable"), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			original := errors.New("copy failed")
			var called bool
			c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
				if args[0] == "run" {
					return nil, original
				}
				if args[0] == "rm" {
					called = true
					return nil, tc.removeErr
				}
				return nil, nil
			}}
			err := c.CopyVolumeBound(context.Background(), "runsc", "helper", "source", "target", nil, "/cell/claim")
			if !errors.Is(err, original) || errors.Is(err, driver.ErrResourceCleanupPending) != tc.pending || !called {
				t.Fatalf("err=%v removed=%v", err, called)
			}
		})
	}
}

func TestCopyVolumeBoundPreservesEarlierSourceCeiling(t *testing.T) {
	ceiling := time.Now().Add(time.Minute).Truncate(time.Second)
	labels := map[string]string{"kodus.cell": "cell", "kodus.hard-expires": ceiling.UTC().Format(time.RFC3339)}
	var got []string
	c := CLI{Run: func(ctx context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		if args[0] == "run" {
			got = args
			if at, ok := ctx.Deadline(); !ok || !at.Equal(ceiling) {
				t.Fatalf("helper ran beyond source ceiling: %v", at)
			}
		}
		return nil, nil
	}}
	if err := c.CopyVolumeBound(context.Background(), "runsc", "helper", "source", "target", labels, "/cell/claim"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(got, " "), "--label kodus.hard-expires="+ceiling.UTC().Format(time.RFC3339)) {
		t.Fatalf("source ceiling missing: %q", got)
	}
}
