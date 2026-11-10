//go:build dockersmoke

package observerauth_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerauth"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// TestManagedPostgresProof runs only against an explicitly supplied disposable
// fixture. It never discovers product configuration or prints credentials.
func TestManagedPostgresProof(t *testing.T) {
	address := os.Getenv("KODY_SQL_TEST_ADDRESS")
	password := os.Getenv("KODY_SQL_TEST_ADMIN_PASSWORD")
	if address == "" || password == "" {
		t.Skip("explicit isolated PostgreSQL fixture required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	u := url.URL{Scheme: "postgres", Host: address, User: url.UserPassword("seedowner", password), Path: "/fixture", RawQuery: "sslmode=disable"}
	admin, err := pgx.Connect(ctx, u.String())
	if err != nil {
		t.Fatalf("fixture admin connection failed (%T)", err)
	}
	defer admin.Close(ctx)
	exec := func(query string) {
		t.Helper()
		if _, err := admin.Exec(ctx, query); err != nil {
			t.Fatalf("fixture SQL failed (%T)", err)
		}
	}
	exec("CREATE TABLE public.orders(id integer PRIMARY KEY, label text NOT NULL); INSERT INTO public.orders VALUES (1,'one'),(2,'two')")
	credential, err := observerauth.NewCredential("db", 5432, "fixture")
	if err != nil {
		t.Fatal("credential generation failed")
	}
	verifier, err := observerauth.SCRAMVerifier(credential)
	if err != nil {
		t.Fatal("verifier generation failed")
	}
	expiry := time.Now().Add(40 * time.Minute).UTC().Truncate(time.Second)
	script, err := observerauth.ProvisionSQL(credential, verifier, expiry)
	if err != nil {
		t.Fatal("provisioning data refused")
	}
	exec(string(script))
	target := observer.Target{Service: "db", Port: 5432, Kind: "postgres", Address: address}
	db, err := observer.OpenManagedPostgres(target, credential)
	if err != nil {
		t.Fatal("managed connector refused")
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("managed SCRAM authentication failed (%T)", err)
	}
	var super, createdb, createrole, inherit, replicate, bypass bool
	var until time.Time
	if err := admin.QueryRow(ctx, "SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolvaliduntil FROM pg_roles WHERE rolname=$1", credential.Username).Scan(&super, &createdb, &createrole, &inherit, &replicate, &bypass, &until); err != nil {
		t.Fatal("role readback failed")
	}
	if super || createdb || createrole || inherit || replicate || bypass || !until.Equal(expiry) {
		t.Fatal("role privileges or hard expiry exceeded")
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatal("managed session unavailable")
	}
	if _, err := conn.ExecContext(ctx, "SET default_transaction_read_only=off"); err != nil {
		t.Fatal("fixture cannot isolate role privileges from session defaults")
	}
	for _, query := range []string{"INSERT INTO public.orders VALUES(3,'forbidden')", "UPDATE public.orders SET label='forbidden'", "DELETE FROM public.orders", "ALTER ROLE " + credential.Username + " SUPERUSER", "SET ROLE seedowner"} {
		if _, err := conn.ExecContext(ctx, query); err == nil {
			t.Fatal("read-only account acquired write or escalation privileges")
		}
	}
	conn.Close()
	other, err := observerauth.NewCredential("db", 5432, "fixture")
	if err != nil {
		t.Fatal("second account generation failed")
	}
	wrong := credential
	wrong.Password = other.Password
	bad, err := observer.OpenManagedPostgres(target, wrong)
	if err != nil {
		t.Fatal("wrong-password fixture config invalid")
	}
	if err := bad.PingContext(ctx); err == nil {
		t.Fatal("a different claim password authenticated")
	}
	bad.Close()
	server := &observer.Server{CellID: "sql-proof", NewID: hubclient.NewID}
	defer server.Close()
	handler := server.Handler()
	cc := observer.ClaimConfig{ClaimID: "claim-proof", ImageID: "image-proof", Generation: 1, Targets: []observer.Target{target}, SQL: []observerauth.Credential{credential}}
	configure := func(config observer.ClaimConfig) int {
		t.Helper()
		body, _ := json.Marshal(config)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/v1/config", bytes.NewReader(body)))
		if strings.Contains(w.Body.String(), credential.Password) || strings.Contains(w.Body.String(), verifier) {
			t.Fatal("private configuration leaked credential data")
		}
		return w.Code
	}
	if configure(cc) != 204 {
		t.Fatal("managed observer configuration refused")
	}
	query := func(q string) *protocol.StepResultBody {
		t.Helper()
		id := hubclient.NewID()
		body := &protocol.ProbeRunBody{StepID: id, Probe: protocol.Probe{ID: "sql-proof", Origin: protocol.ProbeOriginAgent, Purpose: "seeded order count", Expected: "two rows", Compare: []protocol.CompareField{protocol.CompareFieldDbCount}, Spec: protocol.ProbeSpec{SQL: &protocol.SQLProbe{Target: protocol.ProbeTarget{Service: "db", Port: 5432}, Query: q, TimeoutMs: 2000}}}}
		raw, err := protocol.Encode(protocol.Header{ID: hubclient.NewID(), CellID: "sql-proof", ClaimID: "claim-proof"}, body)
		if err != nil {
			t.Fatal("fixture request invalid")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/run", bytes.NewReader(raw)))
		if strings.Contains(w.Body.String(), credential.Password) || strings.Contains(w.Header().Get("X-Kodus-Probe-Refused"), credential.Password) {
			t.Fatal("probe leaked authentication")
		}
		if w.Code != 200 {
			t.Fatal("observer transport failed")
		}
		m, err := protocol.Decode(w.Body.Bytes())
		if err != nil {
			t.Fatal("observer response invalid")
		}
		out, ok := m.Body.(*protocol.StepResultBody)
		if !ok {
			t.Fatal("observer returned wrong body")
		}
		return out
	}
	count := func(want string) {
		t.Helper()
		out := query("SELECT count(*) FROM public.orders")
		if out.Probe == nil || out.Probe.SQL == nil || len(out.Probe.SQL.Rows) != 1 || string(out.Probe.SQL.Rows[0][0]) != want {
			t.Fatal("observer did not measure the seeded count")
		}
	}
	count("2")
	for _, q := range []string{"SELECT pg_notify('unwanted','message')", "SELECT pg_read_file('/etc/passwd')", "SELECT current_setting('server_version')", "SELECT * FROM pg_catalog.pg_roles"} {
		out := query(q)
		if out.Probe != nil || out.VMHealth != protocol.VMHealthOk {
			t.Fatal("unsafe SQL produced proof or fabricated workload failure")
		}
	}
	exec("INSERT INTO public.orders VALUES(3,'exploration')")
	count("3")
	exec("DROP TABLE public.orders; CREATE TABLE public.orders(id integer PRIMARY KEY,label text NOT NULL); INSERT INTO public.orders VALUES(1,'one'),(2,'two')")
	exec(string(script))
	cc.Generation = 2
	if configure(cc) != 204 {
		t.Fatal("observer reset reconfiguration refused")
	}
	count("2")
	stale := cc
	stale.Generation = 1
	if configure(stale) != 409 {
		t.Fatal("stale observer generation accepted")
	}
	foreign := cc
	foreign.ClaimID = "other-claim"
	foreign.Generation = 3
	if configure(foreign) != 409 {
		t.Fatal("a foreign claim rebound the observer")
	}
	for _, tc := range []struct{ setup, cleanup string }{
		{"CREATE FUNCTION public.unsafe_fn() RETURNS integer LANGUAGE SQL AS 'SELECT 1'", "DROP FUNCTION public.unsafe_fn()"},
		{"CREATE VIEW public.unsafe_view AS SELECT * FROM public.orders", "DROP VIEW public.unsafe_view"},
		{"ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY", "ALTER TABLE public.orders DISABLE ROW LEVEL SECURITY"},
		{"GRANT UPDATE ON public.orders TO PUBLIC", "REVOKE UPDATE ON public.orders FROM PUBLIC"},
	} {
		exec(tc.setup)
		candidate, e := observerauth.NewCredential("db", 5432, "fixture")
		if e != nil {
			t.Fatal("unsafe-schema fixture failed")
		}
		v, _ := observerauth.SCRAMVerifier(candidate)
		blocked, _ := observerauth.ProvisionSQL(candidate, v, expiry)
		if _, e := admin.Exec(ctx, string(blocked)); e == nil {
			t.Fatal("unsupported schema was accepted as side-effect-safe")
		}
		exec("ROLLBACK")
		exec(tc.cleanup)
	}
	t.Log("PostgreSQL16 proof: SCRAM, grants, expiry, scoped config, query refusals, reset and unsafe-schema blocks passed")
}
