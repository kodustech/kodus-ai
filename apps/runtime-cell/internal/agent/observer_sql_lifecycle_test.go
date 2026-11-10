package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerauth"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

const sqlLifecycleRecipe = `version: 1
services:
  expose:
    - {service: db, port: 5432, kind: postgres, readonly_user_from_seed: true}
    - {service: rawdb, port: 5433, kind: postgres}
data:
  seed: {service: db, sql: seed.sql, user: app, database: app}
`

type lifecycleSQLProvider struct {
	credentials []observerauth.Credential
	err         error
	forgot      atomic.Int32
}

func (p *lifecycleSQLProvider) ProvisionObserverSQL(context.Context, driver.MachineRef, string) ([]observerauth.Credential, error) {
	return append([]observerauth.Credential(nil), p.credentials...), p.err
}
func (p *lifecycleSQLProvider) ObserverSQLCredentials(string) []observerauth.Credential {
	return append([]observerauth.Credential(nil), p.credentials...)
}
func (p *lifecycleSQLProvider) ObserverSQLSecrets(string) []string {
	var out []string
	for _, c := range p.credentials {
		out = append(out, c.Password)
	}
	return out
}
func (p *lifecycleSQLProvider) ForgetObserverSQL(string) { p.forgot.Add(1) }

func sqlLifecycleCredential() observerauth.Credential {
	return observerauth.Credential{Service: "db", Port: 5432, Database: "app", Username: "kody_observer_" + strings.Repeat("a", 32), Password: strings.Repeat("A", 43)}
}

func sqlLifecycleClaim(h *harness) *claims.Claim {
	b := h.acquireBody()
	b.Expose = []protocol.Expose{{Service: "db", Port: 5432, Kind: protocol.ExposeKindPostgres}}
	c := claims.New("claim-sql", *b, h.a.cfg.Log, h.clk.Now())
	c.SetWorkload(driver.MachineRef{MachineID: "sql-workload", PrivateAddress: "10.0.0.7", ImageID: "img-1"})
	return c
}

// The orchestration layer used to accept any non-empty provider result, even
// when the credential named a database outside the recipe's read-only target.
func TestSQLObserverLifecycleRefusesUnboundCredentials(t *testing.T) {
	valid := sqlLifecycleCredential()
	change := func(edit func(*observerauth.Credential)) []observerauth.Credential {
		c := valid
		edit(&c)
		return []observerauth.Credential{c}
	}
	for _, tc := range []struct {
		name        string
		credentials []observerauth.Credential
	}{
		{"empty", nil},
		{"other service", change(func(c *observerauth.Credential) { c.Service = "other" })},
		{"other port", change(func(c *observerauth.Credential) { c.Port = 5544 })},
		{"other database", change(func(c *observerauth.Credential) { c.Database = "other" })},
		{"duplicate target", []observerauth.Credential{valid, valid}},
		{"unflagged target", change(func(c *observerauth.Credential) { c.Service, c.Port = "rawdb", 5433 })},
		{"extra target", append([]observerauth.Credential{valid}, change(func(c *observerauth.Credential) { c.Service = "other" })...)},
		{"invalid username", change(func(c *observerauth.Credential) { c.Username = "superuser" })},
		{"invalid password", change(func(c *observerauth.Credential) { c.Password = "private-invalid-fixture" })},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := &lifecycleSQLProvider{credentials: tc.credentials}
			configured := 0
			h := newHarness(t, func(cfg *Config) {
				cfg.SQLObservers = p
				cfg.Observers = func(context.Context, ClaimInfo, []observer.Target) (observer.Client, error) {
					configured++
					return nil, nil
				}
			})
			c := sqlLifecycleClaim(h)
			err := h.a.provisionObserverSQL(context.Background(), c, checkout(t, sqlLifecycleRecipe))
			if err == nil || configured != 0 || c.ObserverGeneration() != 0 {
				t.Fatal("unbound credential reached observer configuration or advanced generation")
			}
			for _, credential := range tc.credentials {
				if strings.Contains(err.Error(), credential.Password) || strings.Contains(h.logs.String(), credential.Password) {
					t.Fatal("credential data leaked in lifecycle refusal")
				}
			}
		})
	}
}

func TestSQLObserverLifecycleConfiguresEachSeedGenerationWithRedaction(t *testing.T) {
	credential := sqlLifecycleCredential()
	p := &lifecycleSQLProvider{credentials: []observerauth.Credential{credential}}
	var generations []uint64
	h := newHarness(t, func(cfg *Config) {
		cfg.SQLObservers = p
		cfg.Observers = func(_ context.Context, info ClaimInfo, targets []observer.Target) (observer.Client, error) {
			generations = append(generations, info.ObserverGeneration)
			if info.ClaimID != "claim-sql" || len(targets) != 1 || targets[0].Service != "db" || targets[0].Address != "10.0.0.7:5432" {
				t.Error("configuration did not use this claim's target")
			}
			return nil, nil
		}
	})
	c := sqlLifecycleClaim(h)
	repo := checkout(t, sqlLifecycleRecipe)
	for range 2 {
		if err := h.a.provisionObserverSQL(context.Background(), c, repo); err != nil {
			t.Fatal("valid seeded account was refused")
		}
	}
	if len(generations) != 2 || generations[0] != 1 || generations[1] != 2 {
		t.Fatal("seed/reset did not advance the observer configuration generation")
	}
	if c.Redactor() == nil {
		t.Fatal("seeded authentication was not added to the claim redactor")
	}
	clean, _ := c.Redactor().String(credential.Password)
	if strings.Contains(clean, credential.Password) {
		t.Fatal("claim redactor exposed seeded authentication")
	}
}

func TestSQLObserverLifecycleFailureNeverPublishesReady(t *testing.T) {
	valid := sqlLifecycleCredential()
	for _, tc := range []struct {
		name         string
		credentials  []observerauth.Credential
		configureErr error
	}{
		{"empty account", nil, nil},
		{"wrong account", []observerauth.Credential{{Service: "other", Port: valid.Port, Database: valid.Database, Username: valid.Username, Password: valid.Password}}, nil},
		{"configuration failure", []observerauth.Credential{valid}, errors.New("private config failure")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := &lifecycleSQLProvider{credentials: tc.credentials}
			h := newHarness(t, func(cfg *Config) {
				cfg.SQLObservers = p
				cfg.Observers = func(context.Context, ClaimInfo, []observer.Target) (observer.Client, error) {
					return nil, tc.configureErr
				}
			})
			b := h.acquireBody()
			raw, _ := json.Marshal(sqlLifecycleRecipe)
			b.Recipe = &protocol.ClaimAcquireBodyRecipe{Path: ".kodus/workspace.yaml", Content: raw}
			if err := h.handle("claim-sql", protocol.MessageTypeClaimAcquire, b); err != nil {
				t.Fatal(err)
			}
			frame := h.conn.next(t, func(f any) bool { return isReady(f) || isFailed(f) })
			failed, ok := frame.(*protocol.ClaimFailedBody)
			if !ok || h.conn.attempts(isReady) != 0 || p.forgot.Load() == 0 || len(h.drv.Machines()) != 0 {
				t.Fatal("failed SQL binding published ready or retained claim resources")
			}
			if failed.Signature != "sql_provision_failed" && failed.Signature != "sql_observer_configuration" {
				t.Fatal("SQL binding failure lost its typed blocker")
			}
		})
	}
}
