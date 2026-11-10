// Package observer runs the probes that decide a verdict, outside the VM
// (ADR-053): typed HTTP requests and read-only SQL against the claim's
// exposed ports. It never sees code, .git or processes, and every request it
// makes goes into a log by method and route, which the gate uses for
// coverage instead of any label from the agent.
package observer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// Target is one exposed port of the claim's VM, as the cell resolved it.
type Target struct {
	Service string
	Port    int
	Kind    string // http | postgres | mysql | grpc
	Address string // host:port reachable from the observer
}

// ProbeRefusedError is a probe the observer will not run; the step is
// inconclusive, never a finding (S-31).
type ProbeRefusedError struct {
	Code   string
	Reason string
}

func (e *ProbeRefusedError) Error() string { return e.Code + ": " + e.Reason }

// maxReason bounds a refusal's text (it may quote the app's database).
const maxReason = 512

func refuse(code, format string, a ...any) error {
	// The reason can carry text the PR's own database chose (an SQL error):
	// it is redacted before it reaches a header or a log.
	reason, _ := redact.Patterns(fmt.Sprintf(format, a...))
	reason, _ = redact.Clip(reason, maxReason)
	return &ProbeRefusedError{Code: code, Reason: reason}
}

const (
	// MinProbeTimeout and MaxProbeTimeout bound a probe's timeoutMs: zero
	// would expire at once and read as an unreachable VM, and a huge one
	// would pin the observer (and Postgres treats 0 as no timeout at all).
	MinProbeTimeout = 100 * time.Millisecond
	MaxProbeTimeout = 2 * time.Minute

	// Headers the observer adds to an HTTP result whose body it cut: the
	// gate then compares the full body's hash, not the kept prefix alone.
	HeaderBodyTruncated = "x-kodus-observer-body-truncated"
	HeaderBodySHA256    = "x-kodus-observer-body-sha256"
)

type Config struct {
	ImageID string
	Targets []Target
	// HTTP is the client for app requests. nil: a client whose transport
	// dials only the targets' addresses, with no proxy from the
	// environment (the network is the first lock, this is the second).
	HTTP *http.Client
	// OpenSQL opens a pool for a sql target with the read-only user created
	// at bake. The observer opens one per target and closes it with Close.
	OpenSQL func(t Target) (*sql.DB, error)
	// ManagedSQL applies the closed SQL subset and never exposes target error text.
	ManagedSQL bool
	// Role resolves loginAs(role) to headers outside the VM, by handle.
	Role func(ctx context.Context, role string) (map[string]string, error)
	// MaxBody caps the response body kept in the result; MaxRows the rows
	// (a bigger result is refused, never cut).
	MaxBody int
	MaxRows int
	Now     func() time.Time
}

// Prober runs one claim's probes.
type Prober struct {
	cfg Config
	mu  sync.Mutex
	log []protocol.RequestLogEntry
	dbs map[string]*sql.DB
}

func New(cfg Config) *Prober {
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Transport: TargetsOnlyTransport(cfg.Targets)}
	}
	// A redirect is an answer, not an instruction to go elsewhere.
	client := *cfg.HTTP
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	cfg.HTTP = &client
	if cfg.MaxBody == 0 {
		cfg.MaxBody = 64 << 10
	}
	if cfg.MaxRows == 0 {
		cfg.MaxRows = 1000
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Prober{cfg: cfg, dbs: map[string]*sql.DB{}}
}

// TargetsOnlyTransport dials only the targets' addresses and takes no proxy
// from the environment.
func TargetsOnlyTransport(targets []Target) *http.Transport {
	allowed := map[string]bool{}
	for _, t := range targets {
		allowed[t.Address] = true
	}
	d := &net.Dialer{Timeout: 10 * time.Second}
	return &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if !allowed[addr] {
				return nil, fmt.Errorf("observer: %s is not one of the claim's targets", addr)
			}
			return d.DialContext(ctx, network, addr)
		},
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     time.Minute,
	}
}

// Close closes the SQL pools and idle target connections.
func (r *Prober) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	var errs []error
	r.cfg.HTTP.CloseIdleConnections()
	for k, db := range r.dbs {
		errs = append(errs, db.Close())
		delete(r.dbs, k)
	}
	return errors.Join(errs...)
}

func (r *Prober) target(t protocol.ProbeTarget, kinds ...string) (Target, error) {
	for _, x := range r.cfg.Targets {
		if x.Service == t.Service && int64(x.Port) == t.Port {
			for _, k := range kinds {
				if x.Kind == k {
					return x, nil
				}
			}
			return Target{}, refuse("target_kind", "%s:%d is %s", t.Service, t.Port, x.Kind)
		}
	}
	return Target{}, refuse("target_not_exposed", "%s:%d is not in the claim's expose", t.Service, t.Port)
}

func probeTimeout(ms int64) (time.Duration, error) {
	d := time.Duration(ms) * time.Millisecond
	if d < MinProbeTimeout || d > MaxProbeTimeout {
		return 0, refuse("invalid_probe", "timeoutMs %d is outside [%d, %d]", ms, MinProbeTimeout.Milliseconds(), MaxProbeTimeout.Milliseconds())
	}
	return d, nil
}

// RunStep executes a probe.run: the probe and, when the round asks for
// database effects of an HTTP probe, what the app wrote while it ran
// (dbeffects.go). A database that cannot be read leaves the effects out;
// it never changes the probe's result.
func (r *Prober) RunStep(ctx context.Context, b *protocol.ProbeRunBody) (*protocol.ProbeResult, error) {
	var mark *dbMark
	if wantsDB(b.Evidence) && b.Probe.Spec.HTTP != nil {
		mark, _ = r.markDB(ctx)
	}
	t0 := r.cfg.Now()
	res, err := r.Run(ctx, b.StepID, b.Probe)
	if mark != nil && err == nil && res != nil {
		if fx, ferr := r.dbEffects(ctx, mark); ferr == nil {
			res.Evidence = &protocol.ProbeEvidence{T0: protocol.FormatTime(t0), WindowMs: max(r.cfg.Now().Sub(t0).Milliseconds(), 0), Db: fx}
		}
	}
	return res, err
}

// Run executes one probe. A *ProbeRefusedError means the probe was not run.
func (r *Prober) Run(ctx context.Context, stepID string, p protocol.Probe) (*protocol.ProbeResult, error) {
	start := r.cfg.Now()
	res := &protocol.ProbeResult{
		StepID:    stepID,
		Executor:  "observer",
		ImageID:   r.cfg.ImageID,
		Requests:  []protocol.RequestLogEntry{},
		Transport: protocol.ProbeResultTransportOk,
	}
	var err error
	switch {
	case p.Spec.HTTP != nil:
		res.HTTP, err = r.runHTTP(ctx, *p.Spec.HTTP, res, start)
	case p.Spec.SQL != nil:
		res.SQL, err = r.runSQL(ctx, *p.Spec.SQL)
	case p.Spec.Browser != nil:
		// The cell agent plays browser probes in its browser runner (ADR-071)
		// when it has one and the hub sent the browser capture; one that
		// reaches the observer has neither.
		err = refuse("browser_unavailable", "this cell has no browser runner for this probe")
	case p.Spec.Shell != nil:
		err = refuse("kind_not_allowed", "shell is internal evidence and runs in the VM, never on the observer")
	default:
		err = refuse("invalid_probe", "no spec")
	}
	res.DurationMs = r.cfg.Now().Sub(start).Milliseconds()
	return res, err
}

// Side-detection surfaces: a probe that reads the version of the code
// instead of its behavior fabricates findings (S-31). A ';' after the name
// (path parameters, which some servers strip) counts as its end.
var sideDetectingPath = regexp.MustCompile(`(?i)(^|/)(\.git|\.hg|\.svn|\.env[^/;]*|\.kodus|proc|sys)(/|;|$)`)

// IsSideDetectingPath reports a path that reads the code instead of the
// behavior; the browser runner's goto steps are held to it too (ADR-071).
func IsSideDetectingPath(p string) bool { return sideDetectingPath.MatchString(p) }

func (r *Prober) runHTTP(ctx context.Context, p protocol.HTTPProbe, res *protocol.ProbeResult, start time.Time) (*protocol.ProbeResultHTTP, error) {
	t, err := r.target(p.Target, "http")
	if err != nil {
		return nil, err
	}
	timeout, err := probeTimeout(p.TimeoutMs)
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(p.Path)
	if err != nil || u.IsAbs() || u.Host != "" || !strings.HasPrefix(p.Path, "/") || strings.HasPrefix(p.Path, "//") {
		return nil, refuse("invalid_path", "path must be relative to the app")
	}
	if sideDetectingPath.MatchString(u.Path) || sideDetectingPath.MatchString(u.RawPath) {
		return nil, refuse("side_detection", "path %s reads the code, not the behavior", u.Path)
	}
	var body io.Reader
	if p.Body != nil {
		body = strings.NewReader(*p.Body)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, string(p.Method), "http://"+t.Address+p.Path, body)
	if err != nil {
		return nil, refuse("invalid_request", "%v", err)
	}
	req.Host = "app.kody.internal"
	for k, v := range p.Headers {
		if strings.EqualFold(k, "host") {
			continue
		}
		req.Header.Set(k, v)
	}
	if p.Role != nil {
		if r.cfg.Role == nil {
			return nil, refuse("role_unavailable", "no credential for role %s", *p.Role)
		}
		h, err := r.cfg.Role(ctx, *p.Role)
		if err != nil {
			return nil, refuse("role_unavailable", "%v", err)
		}
		for k, v := range h {
			req.Header.Set(k, v)
		}
	}
	sentAt := max(r.cfg.Now().Sub(start).Milliseconds(), 0)
	resp, err := r.cfg.HTTP.Do(req)
	if err != nil {
		return nil, &UnreachableError{err}
	}
	defer resp.Body.Close()
	// timedRequests: when it was sent, on the round's clock (the agent drops it for a hub that does not accept it).
	entry := protocol.RequestLogEntry{Method: string(p.Method), Route: Route(u.Path), Status: int64(resp.StatusCode)}
	timed := entry
	timed.At = &sentAt
	res.Requests = append(res.Requests, timed)
	r.mu.Lock()
	r.log = append(r.log, entry)
	r.mu.Unlock()

	// Keep MaxBody bytes, hash all of it: a difference past the cut still
	// shows, and a read that broke off is a lost transport, not an answer.
	h := sha256.New()
	var kept bytes.Buffer
	total, rerr := io.Copy(io.MultiWriter(h, &limitedBuffer{buf: &kept, max: r.cfg.MaxBody}), resp.Body)
	headers := map[string]string{}
	for k, v := range resp.Header {
		headers[strings.ToLower(k)] = strings.Join(v, ", ")
	}
	if rerr != nil {
		res.Transport = protocol.ProbeResultTransportLost
	}
	if total > int64(r.cfg.MaxBody) {
		headers[HeaderBodyTruncated] = strconv.FormatInt(total, 10)
		headers[HeaderBodySHA256] = hex.EncodeToString(h.Sum(nil))
	}
	return &protocol.ProbeResultHTTP{Status: int64(resp.StatusCode), Headers: headers, Body: string(bytes.ToValidUTF8(kept.Bytes(), []byte("�")))}, nil
}

// limitedBuffer keeps the first max bytes and drops the rest.
type limitedBuffer struct {
	buf *bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := l.max - l.buf.Len(); room > 0 {
		l.buf.Write(p[:min(room, len(p))])
	}
	return len(p), nil
}

// UnreachableError: the app did not answer; vmHealth becomes unreachable.
type UnreachableError struct{ Err error }

func (e *UnreachableError) Error() string { return "unreachable: " + e.Err.Error() }
func (e *UnreachableError) Unwrap() error { return e.Err }

var (
	numericSeg = regexp.MustCompile(`^\d+$`)
	uuidSeg    = regexp.MustCompile(`^(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	hexSeg     = regexp.MustCompile(`^(?i)[0-9a-f]{16,}$`)
)

// Route normalizes a request path for the coverage log: ids become :id.
func Route(p string) string {
	if p == "" {
		return "/"
	}
	segs := strings.Split(p, "/")
	for i, s := range segs {
		if numericSeg.MatchString(s) || uuidSeg.MatchString(s) || hexSeg.MatchString(s) {
			segs[i] = ":id"
		}
	}
	return strings.Join(segs, "/")
}

// Log returns every request this observer made, by method and route.
func (r *Prober) Log() []protocol.RequestLogEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]protocol.RequestLogEntry(nil), r.log...)
}

// Functions that read the server, the files or the session instead of the
// app's data. The SQL user is read-only already; this keeps a superuser
// seed from turning a probe into a side detector (S-31). A quoted name
// ("pg_read_file"(...)) is caught too.
var sqlSideDetecting = regexp.MustCompile(`(?i)\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_ls_\w+|lo_import|lo_get|current_setting|set_config|version|inet_server_addr|inet_server_port|pg_postmaster_start_time|pg_backend_pid|pg_stat_activity|load_file|sys_exec|dblink\w*|copy)"?\s*\(|@@(hostname|version|datadir|basedir)|\bpg_stat_activity\b|\binformation_schema\.processlist\b`)

// db returns the target's pool, opened once.
func (r *Prober) db(t Target) (*sql.DB, error) {
	key := t.Service + "/" + strconv.Itoa(t.Port)
	r.mu.Lock()
	defer r.mu.Unlock()
	if db, ok := r.dbs[key]; ok {
		return db, nil
	}
	db, err := r.cfg.OpenSQL(t)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(1)
	db.SetConnMaxIdleTime(time.Minute)
	r.dbs[key] = db
	return db, nil
}

func (r *Prober) runSQL(ctx context.Context, p protocol.SQLProbe) (*protocol.ProbeResultSQL, error) {
	t, err := r.target(p.Target, "postgres", "mysql")
	if err != nil {
		return nil, err
	}
	timeout, err := probeTimeout(p.TimeoutMs)
	if err != nil {
		return nil, err
	}
	if err := protocol.CheckReadOnlySQL(p.Query); err != nil {
		return nil, refuse("sql_not_read_only", "%v", err)
	}
	if sqlSideDetecting.MatchString(p.Query) {
		return nil, refuse("side_detection", "query reads the server, not the data")
	}
	if r.cfg.ManagedSQL {
		query, err := ManagedSQLQuery(p.Query)
		if err != nil {
			return nil, refuse("sql_managed_query", "%s", errManagedQuery)
		}
		p.Query = query
	}
	if r.cfg.OpenSQL == nil {
		return nil, refuse("sql_unavailable", "no sql client configured")
	}
	db, err := r.db(t)
	if err != nil {
		return nil, r.sqlConnectionError(err)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// Read-only twice: the user has no write grant, and the transaction is
	// READ ONLY and always rolled back.
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, r.sqlConnectionError(err)
	}
	defer tx.Rollback()
	if t.Kind == "postgres" {
		if _, err := tx.ExecContext(ctx, "SET LOCAL statement_timeout = "+strconv.FormatInt(timeout.Milliseconds(), 10)); err != nil {
			return nil, r.sqlConnectionError(err)
		}
	}
	rows, err := tx.QueryContext(ctx, p.Query)
	if err != nil {
		return nil, refuse("sql_error", "%v", r.sqlError(err))
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, refuse("sql_error", "%v", r.sqlError(err))
	}
	out := &protocol.ProbeResultSQL{Columns: cols, Rows: [][]json.RawMessage{}}
	for rows.Next() {
		if len(out.Rows) >= r.cfg.MaxRows {
			// A cut result would compare as equal where it differs past the
			// cut: the probe is inconclusive instead.
			return nil, refuse("result_too_large", "more than %d rows; narrow the query", r.cfg.MaxRows)
		}
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, refuse("sql_error", "%v", r.sqlError(err))
		}
		row := make([]json.RawMessage, len(cols))
		for i, v := range vals {
			row[i] = jsonValue(v)
		}
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, refuse("sql_error", "%v", r.sqlError(err))
	}
	return out, nil
}

func jsonValue(v any) json.RawMessage {
	switch x := v.(type) {
	case nil:
		return json.RawMessage("null")
	case []byte:
		v = string(bytes.ToValidUTF8(x, []byte("�")))
	case time.Time:
		v = x.UTC().Format(time.RFC3339Nano)
	}
	b, err := json.Marshal(v)
	if err != nil {
		b, _ = json.Marshal(fmt.Sprint(v))
	}
	return b
}

// SortedTargets is for logs and tests.
func (c Config) SortedTargets() []Target {
	t := append([]Target(nil), c.Targets...)
	sort.Slice(t, func(i, j int) bool { return t[i].Service < t[j].Service })
	return t
}

// A database controlled by the app may echo credentials in an error. Managed
// connections never return that remote text to frames, headers or logs.
func (r *Prober) sqlError(err error) error {
	if r.cfg.ManagedSQL {
		return errors.New("managed SQL target failed")
	}
	return err
}

// SQL connectivity/authentication does not establish workload machine health.
func (r *Prober) sqlConnectionError(err error) error {
	if r.cfg.ManagedSQL {
		return refuse("sql_unavailable", "managed SQL target is unavailable")
	}
	return &UnreachableError{err}
}
