package agent

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type uncertainCleanupDriver struct {
	*fake.Driver
	failure string
}

func (d uncertainCleanupDriver) ClaimMemory(driver.ClaimSize) driver.ClaimMemory {
	return driver.ClaimMemory{BootMB: 4096, ReadyMB: 4096}
}
func (d uncertainCleanupDriver) Destroy(ctx context.Context, r driver.MachineRef) error {
	if d.failure == "destroy" {
		return errors.New("daemon could not confirm container removal")
	}
	return d.Driver.Destroy(ctx, r)
}
func (d uncertainCleanupDriver) ReleaseClaim(ctx context.Context, n driver.ClaimNetwork) error {
	if d.failure == "network" {
		return errors.New("resource parent remains populated")
	}
	return d.Driver.ReleaseClaim(ctx, n)
}

// A logical release used to free the memory book even when the driver
// reported that workload/helper cleanup could not be confirmed.
func TestRequiredMemoryAdmissionQuarantinesAnUnconfirmedRelease(t *testing.T) {
	for _, failure := range []string{"destroy", "network"} {
		t.Run(failure, func(t *testing.T) {
			h := newHarness(t, func(c *Config) {
				c.Driver = uncertainCleanupDriver{Driver: c.Driver.(*fake.Driver), failure: failure}
				c.MemoryAllocatableMB = 4096
				c.RequireMemoryAdmission = true
			})
			h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureCellMemory}})
			h.ready("claim-1")
			if err := h.handle("claim-1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
				t.Fatal(err)
			}
			waitFor(t, func() bool { _, ok := h.a.claims.Get("claim-1"); return !ok })
			if hb := h.a.Heartbeat(); hb.Memory == nil || hb.Memory.CommittedMb != 4096 {
				t.Fatalf("uncertain release freed physical reservation: %+v", hb.Memory)
			}
			for _, id := range []string{"claim-2", "claim-1"} {
				if err := h.handle(id, protocol.MessageTypeClaimAcquire, h.acquireBody()); nackCode(err) != "no_capacity" {
					t.Fatalf("%s borrowed quarantined release budget: %v", id, err)
				}
			}
			if !strings.Contains(h.logs.String(), "resource.cleanup_pending") || !strings.Contains(h.logs.String(), "alarm=true") {
				t.Fatalf("missing cleanup alarm: %s", h.logs.String())
			}
		})
	}
}

func TestConfirmedReleaseAndLegacyModeDoNotQuarantineMemory(t *testing.T) {
	for _, tc := range []struct {
		name, failure string
		strict        bool
	}{
		{"confirmed", "", true},
		{"legacy-destroy-error", "destroy", false},
		{"legacy-network-error", "network", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, func(c *Config) {
				c.Driver = uncertainCleanupDriver{Driver: c.Driver.(*fake.Driver), failure: tc.failure}
				c.MemoryAllocatableMB = 4096
				c.RequireMemoryAdmission = tc.strict
			})
			h.ready("claim-1")
			if err := h.handle("claim-1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
				t.Fatal(err)
			}
			waitFor(t, func() bool { _, ok := h.a.claims.Get("claim-1"); return !ok })
			if got := h.a.mem.Committed(); got != 0 {
				t.Fatalf("normal/legacy release held memory: %d", got)
			}
		})
	}
}

func TestPendingPhysicalCleanupCannotBecomeAWorkloadBootFailure(t *testing.T) {
	for _, path := range []string{"upload", "compose", "recipe"} {
		t.Run(path, func(t *testing.T) {
			fault := driver.WorkloadBootFailed(driver.ErrResourceCleanupPending)
			h := newHarness(t, func(c *Config) {
				switch path {
				case "upload":
					c.Transport = stubTransport{upload: fault}
				case "compose":
					failing := enforcementFailureComposer{up: fault}
					c.Composer, c.Recipes = failing, failing
				case "recipe":
					failing := enforcementFailureComposer{recipe: &driver.RecipeStepError{Step: "setup", Field: "setup[0]", Err: fault}}
					c.Composer, c.Recipes = failing, failing
				}
			})
			b := h.acquireBody()
			b.Side = protocol.SidePr
			if path == "recipe" {
				withRecipe(b, migrateRecipe)
			}
			if err := h.handle("claim-pending-copy", protocol.MessageTypeClaimAcquire, b); err != nil {
				t.Fatal(err)
			}
			failed := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
			if failed.Kind != protocol.BlockerKindPlatform || failed.Signature != "resource_cleanup_pending" {
				t.Fatalf("pending helper blamed on PR: %+v", failed)
			}
		})
	}
}
