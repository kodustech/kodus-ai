package agent

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type recoveredBakeCatalog struct {
	records       []driver.RecoveredBake
	err           error
	bounded       bool
	ack           func(context.Context, string) error
	waitForCancel bool
}

func (c *recoveredBakeCatalog) RecoverBakes(ctx context.Context) ([]driver.RecoveredBake, error) {
	_, c.bounded = ctx.Deadline()
	if c.waitForCancel {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return c.records, c.err
}
func (c *recoveredBakeCatalog) AcknowledgeBake(ctx context.Context, id string) error {
	if c.ack != nil {
		return c.ack(ctx, id)
	}
	return nil
}

func TestRecoveryRestoresOnlyBakeEligibilityNotClaimsOrPoolMachines(t *testing.T) {
	catalog := &recoveredBakeCatalog{records: []driver.RecoveredBake{{ImageID: "old-generation", OrgID: "org-a", EnvironmentID: "env-a", SHA: testSHA}, {ImageID: "current-generation", OrgID: "org-a", EnvironmentID: "env-a", SHA: testSHA, Current: true}}}
	h := newHarness(t, func(cfg *Config) { cfg.BakeCatalog = catalog })
	if !catalog.bounded {
		t.Fatal("recovery has no startup deadline")
	}
	if len(h.a.origin.Images()) != 2 || h.a.origin.Latest("org-a", "env-a") != "current-generation" {
		t.Fatal("verified eligibility was not restored")
	}
	tainted, _, _ := h.a.origin.Counts()
	if h.a.pool.Environments() != 0 || h.a.claims.Free() != h.a.cfg.MaxClaims || tainted != 0 {
		t.Fatal("recovery resurrected execution state")
	}
}

func TestRecoveryFailureRefusesAgentStartup(t *testing.T) {
	h := newHarness(t)
	cfg := h.a.cfg
	cfg.BakeCatalog = &recoveredBakeCatalog{err: errors.New("unverified surviving holder")}
	if _, err := New(cfg); err == nil {
		t.Fatal("unverified catalog accepted")
	}
}

func TestRecoveryHonorsProcessCancellation(t *testing.T) {
	h := newHarness(t)
	cfg := h.a.cfg
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cfg.RecoveryContext = ctx
	cfg.BakeCatalog = &recoveredBakeCatalog{waitForCancel: true}
	if _, err := New(cfg); !errors.Is(err, context.Canceled) {
		t.Fatalf("startup cancellation lost: %v", err)
	}
}

func TestSameEnvironmentCannotOvertakePublicationAcknowledgement(t *testing.T) {
	catalog := &recoveredBakeCatalog{}
	h := newHarness(t, func(cfg *Config) { cfg.BakeCatalog = catalog })
	entered, release := make(chan struct{}), make(chan struct{})
	catalog.ack = func(ctx context.Context, id string) error {
		if strings.HasPrefix(id, "img-env-a-") {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return nil
	}
	body := protocol.ImageBakeBody{OrgID: "org-a", EnvironmentID: "env-a", Sha: testSHA, RecipeSha: "r"}
	if err := h.a.bake("", body); err != nil {
		t.Fatal(err)
	}
	<-entered
	if code := nackCode(h.a.bake("", body)); code != "bake_in_progress" {
		close(release)
		t.Fatalf("second same-env bake accepted: %s", code)
	}
	other := body
	other.EnvironmentID = "env-b"
	if err := h.a.bake("", other); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	h.a.Wait()
	if len(h.drv.BakesSnapshot()) != 2 {
		t.Fatal("refused request executed or another environment was blocked")
	}
	_, _, remaining := h.a.origin.Counts()
	if remaining != 0 {
		t.Fatal("publication reservation leaked")
	}
}

func TestConcurrentBakeRefusalTakesNoPinOrMemory(t *testing.T) {
	h, drv, pin, allow := bakeMemoryHarness(t, 4096, 4096, 4096, nil)
	if err := startMemoryBake(t, h); err != nil {
		t.Fatal(err)
	}
	<-drv.started
	if code := nackCode(startMemoryBake(t, h)); code != "bake_in_progress" {
		allow()
		t.Fatalf("duplicate accepted: %s", code)
	}
	pin.mu.Lock()
	pins := len(pin.refs)
	pin.mu.Unlock()
	if pins != 1 || h.a.mem.Committed() != 4096 {
		allow()
		t.Fatal("refused request took pin or memory")
	}
	allow()
	h.a.Wait()
}
