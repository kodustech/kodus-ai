package observer

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

const step = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b"

func app(t *testing.T) (*httptest.Server, Target) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/users":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"id":1}]`))
		case strings.HasPrefix(r.URL.Path, "/users/"):
			w.WriteHeader(http.StatusNotFound)
		case r.URL.Path == "/old":
			http.Redirect(w, r, "http://evil.example/", http.StatusFound)
		default:
			w.WriteHeader(http.StatusTeapot)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, Target{Service: "api", Port: 3000, Kind: "http", Address: strings.TrimPrefix(srv.URL, "http://")}
}

func httpProbe(method protocol.HTTPMethod, path string) protocol.Probe {
	return protocol.Probe{ID: "p", Origin: "agent", Purpose: "x", Expected: "y", Compare: []protocol.CompareField{"status"},
		Spec: protocol.ProbeSpec{HTTP: &protocol.HTTPProbe{Target: protocol.ProbeTarget{Service: "api", Port: 3000}, Method: method, Path: path, TimeoutMs: 2000}}}
}

func sqlProbe(q string) protocol.Probe {
	return protocol.Probe{ID: "p", Origin: "agent", Purpose: "x", Expected: "y", Compare: []protocol.CompareField{"db_count"},
		Spec: protocol.ProbeSpec{SQL: &protocol.SQLProbe{Target: protocol.ProbeTarget{Service: "db", Port: 5432}, Query: q, TimeoutMs: 2000}}}
}

func TestHTTPProbeAndRequestLog(t *testing.T) {
	_, target := app(t)
	r := New(Config{ImageID: "img-1", Targets: []Target{target}})
	res, err := r.Run(context.Background(), step, httpProbe("GET", "/users?page=2"))
	if err != nil {
		t.Fatal(err)
	}
	if res.HTTP.Status != 200 || res.HTTP.Body != `[{"id":1}]` || res.Executor != "observer" || res.ImageID != "img-1" {
		t.Fatalf("%+v", res.HTTP)
	}
	if _, err := r.Run(context.Background(), step, httpProbe("DELETE", "/users/42")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Run(context.Background(), step, httpProbe("GET", "/users/6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b")); err != nil {
		t.Fatal(err)
	}
	log := r.Log()
	want := []protocol.RequestLogEntry{{Method: "GET", Route: "/users", Status: 200}, {Method: "DELETE", Route: "/users/:id", Status: 404}, {Method: "GET", Route: "/users/:id", Status: 404}}
	if len(log) != 3 {
		t.Fatalf("%+v", log)
	}
	for i := range want {
		if log[i] != want[i] {
			t.Fatalf("log[%d] = %+v, want %+v", i, log[i], want[i])
		}
	}
	if len(res.Requests) != 1 || res.Requests[0].Route != "/users" {
		t.Fatalf("per-step log %+v", res.Requests)
	}
}

func TestRedirectIsNotFollowed(t *testing.T) {
	_, target := app(t)
	r := New(Config{Targets: []Target{target}})
	res, err := r.Run(context.Background(), step, httpProbe("GET", "/old"))
	if err != nil || res.HTTP.Status != http.StatusFound {
		t.Fatalf("%v %+v", err, res)
	}
}

func TestTargetMustBeExposed(t *testing.T) {
	r := New(Config{Targets: []Target{{Service: "api", Port: 3000, Kind: "http", Address: "127.0.0.1:1"}}})
	p := httpProbe("GET", "/")
	p.Spec.HTTP.Target.Port = 22
	_, err := r.Run(context.Background(), step, p)
	var re *ProbeRefusedError
	if !errors.As(err, &re) || re.Code != "target_not_exposed" {
		t.Fatal(err)
	}
}

func TestUnreachableApp(t *testing.T) {
	r := New(Config{Targets: []Target{{Service: "api", Port: 3000, Kind: "http", Address: "127.0.0.1:1"}}})
	res, err := r.Run(context.Background(), step, httpProbe("GET", "/"))
	sr := StepResult(step, "img", res, err)
	if sr.VMHealth != protocol.VMHealthUnreachable || sr.Probe != nil {
		t.Fatalf("%+v", sr)
	}
}

// S-31: probes that detect the side are refused and never become a finding.
func TestSideDetectingProbesAreRefused(t *testing.T) {
	_, target := app(t)
	r := New(Config{Targets: []Target{target, {Service: "db", Port: 5432, Kind: "postgres"}}, OpenSQL: openFake})
	shell := protocol.Probe{ID: "p", Origin: "agent", Purpose: "x", Expected: "y", Compare: []protocol.CompareField{"exit"},
		Spec: protocol.ProbeSpec{Shell: &protocol.ShellProbe{Command: "git rev-parse HEAD", TimeoutMs: 100}}}
	probes := map[string]protocol.Probe{
		"git rev-parse":     shell,
		"/proc cmdline":     httpProbe("GET", "/proc/1/cmdline"),
		".git HEAD":         httpProbe("GET", "/static/.git/HEAD"),
		".env":              httpProbe("GET", "/.env.local"),
		"read file via sql": sqlProbe("select pg_read_file('/proc/self/environ')"),
		"env via sql":       sqlProbe("SELECT current_setting('server_version')"),
		"version via sql":   sqlProbe("select version ()"),
		"sessions via sql":  sqlProbe("select query from pg_stat_activity"),
		"write via sql":     sqlProbe("update users set admin = true"),
		"absolute url":      httpProbe("GET", "//evil.example/x"),
	}
	for name, p := range probes {
		t.Run(name, func(t *testing.T) {
			res, err := r.Run(context.Background(), step, p)
			var re *ProbeRefusedError
			if !errors.As(err, &re) {
				t.Fatalf("ran: %v", err)
			}
			if sr := StepResult(step, "img", res, err); sr.Probe != nil {
				t.Fatal("refused probe carried a result")
			}
		})
	}
	if len(r.Log()) != 0 {
		t.Fatal("a refused probe reached the app")
	}
}

func TestSQLProbeIsReadOnly(t *testing.T) {
	r := New(Config{Targets: []Target{{Service: "db", Port: 5432, Kind: "postgres"}}, OpenSQL: openFake})
	res, err := r.Run(context.Background(), step, sqlProbe("select id, email from users"))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.SQL.Rows) != 2 || string(res.SQL.Rows[0][1]) != `"a@x"` || string(res.SQL.Rows[1][1]) != "null" {
		t.Fatalf("%+v", res.SQL)
	}
	shared.mu.Lock()
	defer shared.mu.Unlock()
	if len(shared.readOnly) == 0 || !shared.readOnly[len(shared.readOnly)-1] {
		t.Fatal("transaction not read-only")
	}
	if !strings.HasPrefix(shared.queries[len(shared.queries)-2], "SET LOCAL statement_timeout") {
		t.Fatalf("queries %v", shared.queries)
	}
}

func TestHandlerRoundTrip(t *testing.T) {
	_, target := app(t)
	r := New(Config{ImageID: "img-1", Targets: []Target{target}})
	srv := httptest.NewServer(Handler(r, "cell-1", func() string { return "7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d" }))
	defer srv.Close()
	frame, err := protocol.Encode(protocol.Header{ID: step, CellID: "cell-1", ClaimID: "c1"}, &protocol.ProbeRunBody{StepID: step, Probe: httpProbe("GET", "/users")})
	if err != nil {
		t.Fatal(err)
	}
	body, refused, err := HTTPClient{BaseURL: srv.URL}.Run(context.Background(), frame)
	if err != nil || refused != "" {
		t.Fatal(err, refused)
	}
	if body.Probe == nil || body.Probe.HTTP.Status != 200 {
		t.Fatalf("%+v", body)
	}
	if _, _, err := (HTTPClient{BaseURL: srv.URL}).Run(context.Background(), []byte(`{"v":1}`)); err == nil {
		t.Fatal("observer accepted an invalid frame")
	}
}
