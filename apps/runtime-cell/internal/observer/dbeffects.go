package observer

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Database effects of a probe round (EVIDENCE-CAPTURE-DESIGN "What is
// captured"): what the app wrote while the probe ran, read over the same
// read-only pool and READ ONLY transactions as a sql probe, every statement
// through CheckReadOnlySQL. Postgres: the pg_stat_user_tables delta
// (inserted, updated, deleted per table) and the rows whose xmin is newer
// than the snapshot taken at t0; MySQL: each table's row count delta only.
//
// The t0 mark is txid_current_snapshot()'s xmax, not txid_current():
// txid_current() assigns a transaction id, which a READ ONLY transaction
// refuses. Every transaction that starts after the mark has an id at or
// above that xmax, so its rows are the round's.
//
// pg_stat counters reach the view when a backend flushes them (up to about
// a second later on Postgres 15+), so a table can show rows read by xmin
// and zero counts. The rows are what was written; the counts are a summary.

const (
	// DB effects bounds (the design table): 20 tables, 50 rows per table,
	// 64 KB of rows.
	MaxEffectTables = 20
	MaxEffectRows   = 50
	MaxEffectBytes  = 64 << 10
	// maxScanTables bounds how many tables the xmin scan reads.
	maxScanTables = 50
	// maxEffectValue bounds one value of a row.
	maxEffectValue   = 1 << 10
	dbEffectsTimeout = 5 * time.Second
)

// secretColumn is a column whose values are never read out: its value is
// replaced before the row leaves the observer.
var secretColumn = regexp.MustCompile(`(?i)(password|passwd|token|secret|key|hash|salt|credential|otp)`)

// RedactedValue replaces the value of a secret-looking column.
const RedactedValue = "[redacted]"

type tableCounts struct{ ins, upd, del int64 }

// dbMark is the database as it stood at t0.
type dbMark struct {
	target Target
	xmax   uint64
	counts map[string]tableCounts
	order  []string
}

// dbTarget is the round's database: the first postgres target, else the first mysql.
func (r *Prober) dbTarget() (Target, bool) {
	for _, kind := range []string{"postgres", "mysql"} {
		for _, t := range r.cfg.Targets {
			if t.Kind == kind {
				return t, true
			}
		}
	}
	return Target{}, false
}

// readOnly runs f in a READ ONLY transaction that is always rolled back.
func (r *Prober) readOnly(ctx context.Context, t Target, f func(*sql.Tx) error) error {
	if r.cfg.OpenSQL == nil {
		return fmt.Errorf("observer: no sql client configured")
	}
	db, err := r.db(t)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if t.Kind == "postgres" {
		if _, err := tx.ExecContext(ctx, "SET LOCAL statement_timeout = "+strconv.FormatInt(dbEffectsTimeout.Milliseconds(), 10)); err != nil {
			return err
		}
	}
	return f(tx)
}

func query(ctx context.Context, tx *sql.Tx, q string) (*sql.Rows, error) {
	if err := protocol.CheckReadOnlySQL(q); err != nil {
		return nil, err
	}
	return tx.QueryContext(ctx, q)
}

// markDB records t0: the snapshot's xmax and the per-table counters.
func (r *Prober) markDB(ctx context.Context) (*dbMark, error) {
	t, ok := r.dbTarget()
	if !ok {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, dbEffectsTimeout)
	defer cancel()
	m := &dbMark{target: t}
	err := r.readOnly(ctx, t, func(tx *sql.Tx) error {
		var err error
		if t.Kind == "postgres" {
			rows, qerr := query(ctx, tx, "SELECT txid_snapshot_xmax(txid_current_snapshot())")
			if qerr != nil {
				return qerr
			}
			defer rows.Close()
			if rows.Next() {
				var x int64
				if err := rows.Scan(&x); err != nil {
					return err
				}
				m.xmax = uint64(x)
			}
			if err := rows.Close(); err != nil {
				return err
			}
		}
		m.counts, m.order, err = r.tableCounts(ctx, tx, t)
		return err
	})
	if err != nil {
		return nil, err
	}
	return m, nil
}

// tableCounts reads every user table's counters (postgres) or row count (mysql).
func (r *Prober) tableCounts(ctx context.Context, tx *sql.Tx, t Target) (map[string]tableCounts, []string, error) {
	counts := map[string]tableCounts{}
	var order []string
	if t.Kind == "postgres" {
		rows, err := query(ctx, tx, "SELECT schemaname, relname, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables ORDER BY schemaname, relname LIMIT 500")
		if err != nil {
			return nil, nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var schema, rel string
			var c tableCounts
			if err := rows.Scan(&schema, &rel, &c.ins, &c.upd, &c.del); err != nil {
				return nil, nil, err
			}
			name := schema + "." + rel
			counts[name] = c
			order = append(order, name)
		}
		return counts, order, rows.Err()
	}
	rows, err := query(ctx, tx, "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name LIMIT "+strconv.Itoa(MaxEffectTables))
	if err != nil {
		return nil, nil, err
	}
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return nil, nil, err
		}
		names = append(names, n)
	}
	rows.Close()
	for _, n := range names {
		id, ok := quoteIdent("mysql", n)
		if !ok {
			continue
		}
		cr, err := query(ctx, tx, "SELECT COUNT(*) FROM "+id)
		if err != nil {
			return nil, nil, err
		}
		var c int64
		if cr.Next() {
			_ = cr.Scan(&c)
		}
		cr.Close()
		counts[n] = tableCounts{ins: c}
		order = append(order, n)
	}
	return counts, order, nil
}

// quoteIdent quotes a name the database itself returned; a name with NUL is skipped.
func quoteIdent(kind, name string) (string, bool) {
	if name == "" || strings.ContainsRune(name, 0) {
		return "", false
	}
	if kind == "mysql" {
		return "`" + strings.ReplaceAll(name, "`", "``") + "`", true
	}
	parts := strings.SplitN(name, ".", 2)
	for i, p := range parts {
		parts[i] = `"` + strings.ReplaceAll(p, `"`, `""`) + `"`
	}
	return strings.Join(parts, "."), true
}

// dbEffects is what changed since m: per-table counts and, on Postgres, the rows written.
func (r *Prober) dbEffects(ctx context.Context, m *dbMark) (*protocol.DBEffects, error) {
	ctx, cancel := context.WithTimeout(ctx, dbEffectsTimeout)
	defer cancel()
	out := &protocol.DBEffects{Engine: protocol.DBEngine(m.target.Kind), Service: m.target.Service, Tables: []protocol.DBTableEffect{}}
	err := r.readOnly(ctx, m.target, func(tx *sql.Tx) error {
		now, order, err := r.tableCounts(ctx, tx, m.target)
		if err != nil {
			return err
		}
		type change struct {
			name   string
			effect protocol.DBTableEffect
			sample *protocol.DBSample
		}
		var changes []change
		scanned := 0
		for _, name := range order {
			before, after := m.counts[name], now[name]
			e := protocol.DBTableEffect{Table: name}
			if m.target.Kind == "postgres" {
				e.Inserted, e.Updated, e.Deleted = max(after.ins-before.ins, 0), max(after.upd-before.upd, 0), max(after.del-before.del, 0)
			} else if d := after.ins - before.ins; d > 0 {
				e.Inserted = d
			} else {
				e.Deleted = -d
			}
			var sample *protocol.DBSample
			if m.target.Kind == "postgres" && scanned < maxScanTables {
				scanned++
				if sample, err = r.rowsSince(ctx, tx, name, m.xmax); err != nil {
					return err
				}
				if sample != nil {
					e.Rows = int64(len(sample.Rows))
				}
			}
			if e.Inserted == 0 && e.Updated == 0 && e.Deleted == 0 && e.Rows == 0 {
				continue
			}
			changes = append(changes, change{name: name, effect: e, sample: sample})
		}
		if len(changes) > MaxEffectTables {
			changes, out.Truncated = changes[:MaxEffectTables], true
		}
		for _, c := range changes {
			out.Tables = append(out.Tables, c.effect)
			if c.sample != nil {
				out.Sample = append(out.Sample, *c.sample)
			}
		}
		if trimSample(out, MaxEffectBytes) {
			out.Truncated = true
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// rowsSince reads the table's rows written after the mark (xmin at or above
// its xmax, compared on the 32-bit xid), at most MaxEffectRows; nil when none.
func (r *Prober) rowsSince(ctx context.Context, tx *sql.Tx, table string, xmax uint64) (*protocol.DBSample, error) {
	id, ok := quoteIdent("postgres", table)
	if !ok {
		return nil, nil
	}
	low := strconv.FormatUint(xmax%(1<<32), 10)
	rows, err := query(ctx, tx, "SELECT * FROM "+id+" WHERE xmin::text::bigint >= "+low+" LIMIT "+strconv.Itoa(MaxEffectRows))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	all, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	cols := all[:min(len(all), 64)]
	s := &protocol.DBSample{Table: table, Columns: cols, Rows: [][]json.RawMessage{}}
	for rows.Next() {
		vals := make([]any, len(all))
		ptrs := make([]any, len(all))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make([]json.RawMessage, len(cols))
		for i := range cols {
			if secretColumn.MatchString(cols[i]) {
				row[i] = json.RawMessage(`"` + RedactedValue + `"`)
				continue
			}
			row[i] = clipValue(jsonValue(vals[i]))
		}
		s.Rows = append(s.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(s.Rows) == 0 {
		return nil, nil
	}
	return s, nil
}

// clipValue keeps a value under maxEffectValue bytes (a long text becomes its prefix).
func clipValue(v json.RawMessage) json.RawMessage {
	if len(v) <= maxEffectValue {
		return v
	}
	var s string
	if err := json.Unmarshal(v, &s); err == nil {
		b, _ := json.Marshal(s[:min(len(s), maxEffectValue-16)] + "…")
		return b
	}
	return json.RawMessage(`"[too large]"`)
}

// trimSample drops rows, from the table with the most, until the sample fits budget.
func trimSample(out *protocol.DBEffects, budget int) bool {
	rowSize := func(row []json.RawMessage) int {
		n := 3
		for _, v := range row {
			n += len(v) + 1
		}
		return n
	}
	total := 0
	for _, s := range out.Sample {
		total += len(s.Table) + 64
		for _, c := range s.Columns {
			total += len(c) + 3
		}
		for _, row := range s.Rows {
			total += rowSize(row)
		}
	}
	cut := false
	for total > budget && len(out.Sample) > 0 {
		big := 0
		for i := range out.Sample {
			if len(out.Sample[i].Rows) > len(out.Sample[big].Rows) {
				big = i
			}
		}
		s := &out.Sample[big]
		if len(s.Rows) == 0 {
			out.Sample = append(out.Sample[:big], out.Sample[big+1:]...)
			continue
		}
		total -= rowSize(s.Rows[len(s.Rows)-1])
		s.Rows = s.Rows[:len(s.Rows)-1]
		cut = true
	}
	return cut
}

// wantsDB reports whether the round asked for database effects.
func wantsDB(ev *protocol.EvidenceRequest) bool {
	if ev == nil {
		return false
	}
	for _, c := range ev.Capture {
		if c == protocol.EvidenceCaptureDb {
			return true
		}
	}
	return false
}
