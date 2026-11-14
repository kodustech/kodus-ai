package agent

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Accepted recipe syntax never means an unsupported driver can ignore it.
func TestUnsupportedRecipeCapabilitiesRefuseBeforeUpload(t *testing.T) {
	for _, tc := range []struct{ name, text, want string }{
		{"seeded SQL", "services:\n  expose: [{service: db, port: 5432, kind: postgres, readonly_user_from_seed: true}]\ndata:\n  seed: {service: db, sql: seed.sql, user: app, database: app}\n", "sql_observer_unsupported"},
		{"fake driver", "fakes: {stripe: {image: 'stripe/stripe-mock@sha256:" + strings.Repeat("a", 64) + "'}}\n", "recipe_fakes_unsupported"},
		{"mutable fake image", "fakes: {stripe: {image: stripe-mock}}\n", "fake_image_pin_required"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upload := &countedRecipeUpload{}
			h := newHarness(t, func(c *Config) { c.Transport = upload })
			b := h.acquireBody()
			raw, _ := json.Marshal("version: 1\n" + tc.text)
			b.Recipe = &protocol.ClaimAcquireBodyRecipe{Path: ".kodus/workspace.yaml", Content: raw}
			if err := h.handle("claim-cap", protocol.MessageTypeClaimAcquire, b); err != nil {
				t.Fatal(err)
			}
			got := h.conn.next(t, func(f any) bool { return isReady(f) || isFailed(f) })
			failed, ok := got.(*protocol.ClaimFailedBody)
			if !ok || failed.Signature != tc.want || upload.count.Load() != 0 {
				t.Fatalf("capability was ignored: failed=%t uploads=%d", ok, upload.count.Load())
			}
		})
	}
}

func TestHelloNegotiatesOnlyConfiguredRecipeExecution(t *testing.T) {
	for _, tc := range []struct {
		name       string
		fakes, sql bool
	}{
		{"unsupported driver", false, false},
		{"local fake services", true, false},
		{"managed SQL", false, true},
		{"both supported", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, func(cfg *Config) {
				cfg.FakeSupport = tc.fakes
				if tc.sql {
					cfg.SQLObservers = &lifecycleSQLProvider{}
				}
			})
			hello := h.a.Hello()
			if slices.Contains(hello.Features, protocol.FeatureRecipeFakes) != tc.fakes || slices.Contains(hello.Features, protocol.FeatureSeededSQL) != tc.sql {
				t.Fatal("hello misrepresented the executable recipe capabilities")
			}
			if _, err := protocol.Encode(protocol.Header{ID: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", CellID: "cell-1"}, hello); err != nil {
				t.Fatal("negotiated hello failed the shared wire contract")
			}
		})
	}
}
