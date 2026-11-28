package observer

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// A Postgres that answers the effects queries, before and after the app wrote.
type effectsDB struct {
	mu       sync.Mutex
	after    atomic.Bool
	readOnly []bool
	queries  []string
}

type effectsConn struct{ db *effectsDB }

func (d *effectsDB) Open(string) (driver.Conn, error) { return &effectsConn{d}, nil }
func (c *effectsConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("not supported")
}
func (c *effectsConn) Close() error              { return nil }
func (c *effectsConn) Begin() (driver.Tx, error) { return fakeTx{}, nil }
func (c *effectsConn) BeginTx(_ context.Context, o driver.TxOptions) (driver.Tx, error) {
	c.db.mu.Lock()
	c.db.readOnly = append(c.db.readOnly, o.ReadOnly)
	c.db.mu.Unlock()
	return fakeTx{}, nil
}

func (c *effectsConn) ExecContext(_ context.Context, q string, _ []driver.NamedValue) (driver.Result, error) {
	c.db.mu.Lock()
	c.db.queries = append(c.db.queries, q)
	c.db.mu.Unlock()
	return driver.RowsAffected(0), nil
}

func (c *effectsConn) QueryContext(_ context.Context, q string, _ []driver.NamedValue) (driver.Rows, error) {
	c.db.mu.Lock()
	c.db.queries = append(c.db.queries, q)
	c.db.mu.Unlock()
	after := c.db.after.Load()
	switch {
	case strings.HasPrefix(q, "SELECT txid_snapshot_xmax"):
		return &fakeRows{cols: []string{"x"}, data: [][]driver.Value{{int64(4_294_968_296)}}}, nil // epoch 1, xid 1000
	case strings.HasPrefix(q, "SELECT schemaname"):
		ins := int64(5)
		upd := int64(0)
		if after {
			ins, upd = 6, 1
		}
		return &fakeRows{cols: []string{"schemaname", "relname", "n_tup_ins", "n_tup_upd", "n_tup_del"}, data: [][]driver.Value{
			{"public", "orders", ins, int64(0), int64(0)},
			{"public", "users", int64(2), upd, int64(0)},
			{"public", "untouched", int64(9), int64(0), int64(0)},
		}}, nil
	case q == `SELECT * FROM "public"."orders" WHERE xmin::text::bigint >= 1000 LIMIT 50`:
		return &fakeRows{cols: []string{"id", "total", "api_key"}, data: [][]driver.Value{{int64(7), 12.5, "sk_live_x"}}}, nil
	case q == `SELECT * FROM "public"."users" WHERE xmin::text::bigint >= 1000 LIMIT 50`:
		return &fakeRows{cols: []string{"id", "email", "password_hash"}, data: [][]driver.Value{{int64(2), []byte("a@x"), "$2b$10$abc"}}}, nil
	case strings.HasPrefix(q, "SELECT * FROM"):
		return &fakeRows{cols: []string{"id"}}, nil
	}
	return nil, errors.New("unexpected query: " + q)
}

var (
	effectsOnce sync.Once
	effects     = &effectsDB{}
)

// One HTTP probe with database effects asked: the rows the app wrote while
// it ran, per table, read only, secret-looking columns redacted.
func TestDBEffectsOfAnHTTPProbe(t *testing.T) {
	effectsOnce.Do(func() { sql.Register("observer-effects", effects) })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		effects.after.Store(true) // the app writes while the probe runs
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	api := Target{Service: "api", Port: 3000, Kind: "http", Address: strings.TrimPrefix(srv.URL, "http://")}
	db := Target{Service: "db", Port: 5432, Kind: "postgres", Address: "db:5432"}
	r := New(Config{ImageID: "img-1", Targets: []Target{api, db}, OpenSQL: func(Target) (*sql.DB, error) { return sql.Open("observer-effects", "") }})
	defer r.Close()
	run := &protocol.ProbeRunBody{StepID: step, Probe: httpProbe("POST", "/orders"), Evidence: &protocol.EvidenceRequest{Capture: []protocol.EvidenceCapture{protocol.EvidenceCaptureDb}}}
	res, err := r.RunStep(context.Background(), run)
	if err != nil {
		t.Fatal(err)
	}
	if res.HTTP.Status != 201 || res.Requests[0].At == nil {
		t.Fatalf("%+v", res)
	}
	fx := res.Evidence.Db
	if fx.Engine != protocol.DBEnginePostgres || fx.Service != "db" || len(fx.Tables) != 2 {
		t.Fatalf("%+v", fx)
	}
	if fx.Tables[0] != (protocol.DBTableEffect{Table: "public.orders", Inserted: 1, Rows: 1}) || fx.Tables[1] != (protocol.DBTableEffect{Table: "public.users", Updated: 1, Rows: 1}) {
		t.Fatalf("%+v", fx.Tables)
	}
	sample, _ := json.Marshal(fx.Sample)
	if strings.Contains(string(sample), "sk_live_x") || strings.Contains(string(sample), "$2b$") || !strings.Contains(string(sample), `"a@x"`) {
		t.Fatalf("sample %s", sample)
	}
	if strings.Count(string(sample), RedactedValue) != 2 {
		t.Fatalf("sample %s", sample)
	}
	effects.mu.Lock()
	defer effects.mu.Unlock()
	for _, ro := range effects.readOnly {
		if !ro {
			t.Fatal("a transaction was not READ ONLY")
		}
	}
	for _, q := range effects.queries {
		if !strings.HasPrefix(q, "SET LOCAL statement_timeout") && protocol.CheckReadOnlySQL(q) != nil {
			t.Fatalf("not read-only: %s", q)
		}
	}
}

// Without the ask, or for a probe that is not HTTP, nothing is read.
func TestDBEffectsOnlyWhenAsked(t *testing.T) {
	_, api := app(t)
	calls := 0
	r := New(Config{ImageID: "img-1", Targets: []Target{api, {Service: "db", Port: 5432, Kind: "postgres"}}, OpenSQL: func(Target) (*sql.DB, error) {
		calls++
		return nil, io.EOF
	}})
	res, err := r.RunStep(context.Background(), &protocol.ProbeRunBody{StepID: step, Probe: httpProbe("GET", "/users")})
	if err != nil || res.Evidence != nil || calls != 0 {
		t.Fatalf("%+v %v %d", res, err, calls)
	}
	// Asked, but the database cannot be read: the probe's result stands, without effects.
	res, err = r.RunStep(context.Background(), &protocol.ProbeRunBody{StepID: step, Probe: httpProbe("GET", "/users"), Evidence: &protocol.EvidenceRequest{Capture: []protocol.EvidenceCapture{protocol.EvidenceCaptureDb}}})
	if err != nil || res.HTTP.Status != 200 || res.Evidence != nil {
		t.Fatalf("%+v %v", res, err)
	}
}

func TestTrimSampleKeepsTheBudget(t *testing.T) {
	big := json.RawMessage(`"` + strings.Repeat("x", 900) + `"`)
	fx := &protocol.DBEffects{Sample: []protocol.DBSample{{Table: "a", Columns: []string{"v"}}, {Table: "b", Columns: []string{"v"}}}}
	for i := 0; i < 50; i++ {
		fx.Sample[0].Rows = append(fx.Sample[0].Rows, []json.RawMessage{big})
		fx.Sample[1].Rows = append(fx.Sample[1].Rows, []json.RawMessage{big})
	}
	if !trimSample(fx, MaxEffectBytes) {
		t.Fatal("not cut")
	}
	b, _ := json.Marshal(fx.Sample)
	if len(b) > MaxEffectBytes {
		t.Fatalf("%d bytes", len(b))
	}
	if quoted, _ := quoteIdent("postgres", `pub"lic.or"ders`); quoted != `"pub""lic"."or""ders"` {
		t.Fatal(quoted)
	}
	if _, ok := quoteIdent("mysql", "a\x00b"); ok {
		t.Fatal("NUL accepted")
	}
}

// A database whose answer breaks partway through: the scenario (its DSN)
// names which read breaks.
type brokenReadDriver struct{}

type (
	brokenReadConn struct{ scenario string }
	brokenReadRows struct {
		col  string
		rows []driver.Value
		i    int
	}
)

func (brokenReadDriver) Open(dsn string) (driver.Conn, error) { return brokenReadConn{dsn}, nil }
func (brokenReadConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("not supported")
}
func (brokenReadConn) Close() error              { return nil }
func (brokenReadConn) Begin() (driver.Tx, error) { return fakeTx{}, nil }

func (brokenReadConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return fakeTx{}, nil
}

func (brokenReadConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	return driver.RowsAffected(0), nil
}

func (c brokenReadConn) QueryContext(_ context.Context, q string, _ []driver.NamedValue) (driver.Rows, error) {
	switch {
	case strings.Contains(q, "txid_snapshot_xmax"):
		return &brokenReadRows{col: "xmax"}, nil
	case strings.Contains(q, "pg_stat_user_tables"):
		return &fakeRows{cols: []string{"schemaname", "relname", "n_tup_ins", "n_tup_upd", "n_tup_del"}}, nil
	case strings.Contains(q, "information_schema.tables"):
		if c.scenario == "listing" {
			return &brokenReadRows{col: "table_name", rows: []driver.Value{[]byte("orders")}}, nil
		}
		return &fakeRows{cols: []string{"table_name"}, data: [][]driver.Value{{[]byte("orders")}}}, nil
	case strings.HasPrefix(q, "SELECT COUNT(*)"):
		return &brokenReadRows{col: "count"}, nil
	}
	return nil, errors.New("unexpected query: " + q)
}

func (r *brokenReadRows) Columns() []string { return []string{r.col} }
func (r *brokenReadRows) Close() error      { return nil }
func (r *brokenReadRows) Next(dest []driver.Value) error {
	if r.i >= len(r.rows) {
		return errors.New("connection reset mid-read")
	}
	dest[0] = r.rows[r.i]
	r.i++
	return nil
}

var brokenReadOnce sync.Once

// The mark a probe's effects are measured from is an error when the database
// breaks while answering, never a mark built from half an answer. It used to
// keep xmax 0, the tables listed before the break, or a count of 0.
func TestDBMarkFailsWhenTheDatabaseBreaksMidAnswer(t *testing.T) {
	brokenReadOnce.Do(func() { sql.Register("observer-broken-read", brokenReadDriver{}) })
	for _, tc := range []struct{ scenario, kind string }{
		{"xmax", "postgres"},
		{"listing", "mysql"},
		{"count", "mysql"},
	} {
		t.Run(tc.scenario, func(t *testing.T) {
			db := Target{Service: "db", Port: 5432, Kind: tc.kind, Address: "db:5432"}
			r := New(Config{ImageID: "img-1", Targets: []Target{db}, OpenSQL: func(Target) (*sql.DB, error) {
				return sql.Open("observer-broken-read", tc.scenario)
			}})
			defer r.Close()
			if m, err := r.markDB(context.Background()); err == nil {
				t.Fatalf("a broken read became a mark: %+v", m)
			}
		})
	}
}
