package observer

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerauth"
)

func TestManagedSQLRejectsExecutableOrMetadataQueriesBeforeConnecting(t *testing.T) {
	for _, q := range []string{
		`select public.write_secret() from orders`,
		`select pg_catalog.pg_notify('x','y') from orders`,
		`select "pg_read_file"('/etc/passwd') from orders`,
		`select * from pg_catalog.pg_roles`,
		`select * from information_schema.tables`,
		`select * from pg_stat_activity`,
		`select * into copy from orders`,
		`select * from orders for update`,
		`with changed as (delete from orders returning *) select * from changed`,
		`explain analyze select * from orders`,
		`select count(*) from (select * from orders) nested`,
		`select * from orders; select * from users`,
		`select * from orders -- comment`,
		`select * from orders /* comment */`,
		`select * from orders where id = $$value$$`,
		`select 1`,
	} {
		t.Run(q, func(t *testing.T) {
			called := false
			r := New(Config{Targets: []Target{{Service: "db", Port: 5432, Kind: "postgres"}}, ManagedSQL: true, OpenSQL: func(tg Target) (*sql.DB, error) { called = true; return openFake(tg) }})
			defer r.Close()
			_, err := r.Run(context.Background(), step, sqlProbe(q))
			var refused *ProbeRefusedError
			if !errors.As(err, &refused) || called {
				t.Fatalf("managed query was not refused before connecting (called=%t)", called)
			}
		})
	}
}

func TestManagedSQLPinsOrdinaryTablesToPublicAndKeepsReadOnlyTransaction(t *testing.T) {
	r := New(Config{Targets: []Target{{Service: "db", Port: 5432, Kind: "postgres"}}, ManagedSQL: true, OpenSQL: openFake})
	defer r.Close()
	if _, err := r.Run(context.Background(), step, sqlProbe(`SELECT id, email FROM users WHERE id = 1 ORDER BY id DESC LIMIT 10`)); err != nil {
		t.Fatal(err)
	}
	shared.mu.Lock()
	defer shared.mu.Unlock()
	last := shared.queries[len(shared.queries)-1]
	if !strings.Contains(last, `FROM "public"."users"`) {
		t.Fatalf("table was not pinned to public: %s", last)
	}
	if !shared.readOnly[len(shared.readOnly)-1] {
		t.Fatal("transaction is writable")
	}
}

func TestManagedSQLErrorsNeverReturnRemoteCredentialText(t *testing.T) {
	secret := strings.Repeat("A", 43)
	r := New(Config{Targets: []Target{{Service: "db", Port: 5432, Kind: "postgres"}}, ManagedSQL: true, OpenSQL: func(Target) (*sql.DB, error) { return nil, errors.New("remote said " + secret) }})
	defer r.Close()
	_, err := r.Run(context.Background(), step, sqlProbe(`SELECT id FROM orders`))
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatal("managed SQL exposed remote error text")
	}
}

func fixtureCredential(t *testing.T) observerauth.Credential {
	t.Helper()
	c, err := observerauth.NewCredential("db", 5432, "app")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestManagedSQLCanonicalSubset(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{`select count(*) from orders`, `SELECT pg_catalog.count(*) FROM "public"."orders"`},
		{`SELECT SUM(amount) AS total FROM public.orders WHERE status = 'paid' AND deleted IS NULL LIMIT 100`, `SELECT pg_catalog.sum("amount") AS "total" FROM "public"."orders" WHERE "status" = 'paid' AND "deleted" IS NULL LIMIT 100`},
		{`SELECT "OrderID", email FROM "public"."Orders" WHERE email = 'Bob''s' ORDER BY "OrderID" ASC`, `SELECT "OrderID", "email" FROM "public"."Orders" WHERE "email" = 'Bob''s' ORDER BY "OrderID" ASC`},
	} {
		got, err := ManagedSQLQuery(tc.in)
		if err != nil || got != tc.want {
			t.Errorf("closed subset rejected/canonicalized incorrectly: %q (%v)", got, err)
		}
	}
	for _, query := range []string{
		`SELECT count(*) FROM "PUBLIC".orders`,
		`SELECT count(*) FROM orders WHERE id = 1 OR pg_sleep(1)`,
		`SELECT * FROM orders WHERE id = 1 UNION SELECT * FROM other`,
		`SELECT * FROM orders LIMIT 1001`,
		`SELECT * FROM orders OFFSET 1`,
		`SELECT "pg_read_file"() FROM orders`,
		`SELECT sum(*) FROM orders`,
		`SELECT * FROM "pg_roles"`,
		`SELECT * FROM orders WHERE id = 1;`,
		`SELECT * FROM orders WHERE name = E'escaped'`,
	} {
		if _, err := ManagedSQLQuery(query); err == nil {
			t.Errorf("query escaped the closed subset: %q", query)
		}
	}
}

func TestManagedConnectionFailureIsNotAnUnhealthyVMFact(t *testing.T) {
	for _, connectionError := range []error{errManagedPostgresConfig, errors.New("target connection failed")} {
		r := New(Config{ImageID: "img-1", Targets: []Target{{Service: "db", Port: 5432, Kind: "postgres"}}, ManagedSQL: true, OpenSQL: func(Target) (*sql.DB, error) { return nil, connectionError }})
		result, err := r.Run(context.Background(), step, sqlProbe(`SELECT id FROM orders`))
		frame := StepResult(step, "img-1", result, err)
		if frame.VMHealth != "ok" || frame.Probe != nil {
			t.Fatal("managed SQL connection failure manufactured a VM-health failure")
		}
		r.Close()
	}
}
