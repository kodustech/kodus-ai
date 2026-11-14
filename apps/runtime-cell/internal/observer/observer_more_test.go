package observer

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Every SQL probe opened a *sql.DB and never closed it: a run with many
// probes leaked a pool per probe against the VM's database.
func TestSQLPoolIsOpenedOncePerTargetAndClosed(t *testing.T) {
	var opened atomic.Int32
	var dbs []*sql.DB
	r := New(Config{Targets: []Target{{Service: "db", Port: 5432, Kind: "postgres"}}, OpenSQL: func(tg Target) (*sql.DB, error) {
		opened.Add(1)
		db, err := openFake(tg)
		dbs = append(dbs, db)
		return db, err
	}})
	for i := 0; i < 5; i++ {
		if _, err := r.Run(context.Background(), step, sqlProbe("select id, email from users")); err != nil {
			t.Fatal(err)
		}
	}
	if opened.Load() != 1 {
		t.Fatalf("%d pools for one target", opened.Load())
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if err := dbs[0].Ping(); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("pool still open: %v", err)
	}
}

func TestProbeTimeoutIsBounded(t *testing.T) {
	_, target := app(t)
	r := New(Config{Targets: []Target{target}})
	for _, ms := range []int64{0, 5, 3_600_000} {
		p := httpProbe("GET", "/users")
		p.Spec.HTTP.TimeoutMs = ms
		_, err := r.Run(context.Background(), step, p)
		var re *ProbeRefusedError
		if !errors.As(err, &re) || re.Code != "invalid_probe" {
			t.Fatalf("timeout %d: %v", ms, err)
		}
	}
}

// A body past MaxBody was cut silently: base and head that differ only past
// the cut compared equal. The result says it was cut and hashes all of it.
func TestCutBodyCarriesItsLengthAndHash(t *testing.T) {
	full := strings.Repeat("a", 100) + "DIFFERENT TAIL"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(full)) }))
	defer srv.Close()
	target := Target{Service: "api", Port: 3000, Kind: "http", Address: strings.TrimPrefix(srv.URL, "http://")}
	r := New(Config{Targets: []Target{target}, MaxBody: 50})
	res, err := r.Run(context.Background(), step, httpProbe("GET", "/"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(full))
	if len(res.HTTP.Body) != 50 || res.HTTP.Headers[HeaderBodyTruncated] != "114" || res.HTTP.Headers[HeaderBodySHA256] != hex.EncodeToString(sum[:]) {
		t.Fatalf("%+v", res.HTTP)
	}
}

func TestTooManyRowsIsInconclusiveNotCut(t *testing.T) {
	r := New(Config{Targets: []Target{{Service: "db", Port: 5432, Kind: "postgres"}}, OpenSQL: openFake, MaxRows: 1})
	_, err := r.Run(context.Background(), step, sqlProbe("select id, email from users"))
	var re *ProbeRefusedError
	if !errors.As(err, &re) || re.Code != "result_too_large" {
		t.Fatal(err)
	}
}

// The default client dials the targets and nothing else.
func TestDefaultClientReachesOnlyTheTargets(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer other.Close()
	_, target := app(t)
	tr := TargetsOnlyTransport([]Target{target})
	if tr.Proxy != nil {
		t.Fatal("takes a proxy from the environment")
	}
	c := &http.Client{Transport: tr}
	if _, err := c.Get(other.URL); err == nil || !strings.Contains(err.Error(), "not one of the claim's targets") {
		t.Fatalf("reached a non-target: %v", err)
	}
	if resp, err := c.Get("http://" + target.Address + "/users"); err != nil {
		t.Fatal(err)
	} else {
		resp.Body.Close()
	}
}

func TestMoreSideDetectingSpellingsAreRefused(t *testing.T) {
	_, target := app(t)
	r := New(Config{Targets: []Target{target, {Service: "db", Port: 5432, Kind: "postgres"}}, OpenSQL: openFake})
	for name, p := range map[string]protocol.Probe{
		"quoted function": sqlProbe(`select "pg_read_file"('/etc/passwd')`),
		"path parameter":  httpProbe("GET", "/static/.git;x/config"),
		"encoded dot":     httpProbe("GET", "/static/%2egit/config"),
	} {
		var re *ProbeRefusedError
		if _, err := r.Run(context.Background(), step, p); !errors.As(err, &re) {
			t.Errorf("%s ran: %v", name, err)
		}
	}
}

// The refusal text quotes what the PR's database said; a token in it does
// not reach the header or the log.
func TestRefusalReasonIsRedacted(t *testing.T) {
	err := refuse("sql_error", "%s", "ERROR: AKIAIOSFODNN7EXAMPLE not found")
	if strings.Contains(err.Error(), "AKIAIOSFODNN7EXAMPLE") {
		t.Fatal(err)
	}
}

func TestObserverAnswersOnlyItsClaim(t *testing.T) {
	_, target := app(t)
	s := &Server{CellID: "cell-1", NewID: func() string { return "7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d" }}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	cfg := `{"claimId":"c1","imageId":"img","targets":[{"Service":"api","Port":3000,"Kind":"http","Address":"` + target.Address + `"}]}`
	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/v1/config", strings.NewReader(cfg))
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != http.StatusNoContent {
		t.Fatalf("config: %v %v", err, resp)
	}
	frame, _ := protocol.Encode(protocol.Header{ID: step, CellID: "cell-1", ClaimID: "c2"}, &protocol.ProbeRunBody{StepID: step, Probe: httpProbe("GET", "/users")})
	if _, _, err := (HTTPClient{BaseURL: srv.URL}).Run(context.Background(), frame); err == nil || !strings.Contains(err.Error(), "another claim") {
		t.Fatalf("ran a frame for another claim: %v", err)
	}
	frame, _ = protocol.Encode(protocol.Header{ID: step, CellID: "cell-1", ClaimID: "c1"}, &protocol.ProbeRunBody{StepID: step, Probe: httpProbe("GET", "/users")})
	if body, _, err := (HTTPClient{BaseURL: srv.URL}).Run(context.Background(), frame); err != nil || body.Probe == nil {
		t.Fatalf("own claim: %v %+v", err, body)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}
