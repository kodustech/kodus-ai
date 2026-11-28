package main

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

// -isolation-backend firecracker needs no gVisor image, and a cell given
// no kit does not start: the refusal names the kit flags.
func TestAFirecrackerCellWithoutItsKitDoesNotStart(t *testing.T) {
	args := []string{"-driver", "docker-gvisor", "-isolation-backend", "firecracker", "-state-dir", t.TempDir(), "-observer", "http"}
	st, err := parse(t, args...)
	if err != nil {
		t.Fatal(err)
	}
	if kind, err := startOn(t, "", args...); err != nil || kind != microvm.Kind {
		t.Fatalf("a firecracker cell asked for a gVisor image: %s %v", kind, err)
	}
	_, err = openMicroVM(context.Background(), st, "cell-1", machinetrust.Files{}, slog.Default())
	var u *isolation.UnavailableError
	if !errors.As(err, &u) || u.Backend != isolation.Firecracker || !strings.Contains(u.Reason, "microVM kit") {
		t.Fatalf("err %v", err)
	}
}

// -host-policy auto is shared on a microVM cell and dedicated on
// docker-gvisor (its hosts run SMT today); an explicit policy wins.
func TestTheHostPolicyFollowsTheDriverUnlessSet(t *testing.T) {
	for _, c := range []struct{ flag, kind, want string }{
		{"auto", microvm.Kind, "shared"},
		{"auto", "docker-gvisor", "dedicated"},
		{"", "docker-gvisor", "dedicated"},
		{"shared", "docker-gvisor", "shared"},
		{"dedicated", microvm.Kind, "dedicated"},
	} {
		if got, err := hostPolicyFor(c.flag, c.kind); err != nil || got != c.want {
			t.Errorf("%s on %s: %s %v", c.flag, c.kind, got, err)
		}
	}
	if _, err := hostPolicyFor("lax", "docker-gvisor"); err == nil {
		t.Error("an unknown policy")
	}
}
