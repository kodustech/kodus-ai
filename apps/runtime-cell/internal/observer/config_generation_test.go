package observer

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerauth"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func putConfig(h http.Handler, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/v1/config", strings.NewReader(body)))
	return w
}

func managedConfigJSON(claim string, generation int, address, password string) string {
	return fmt.Sprintf(`{"claimId":%q,"imageId":"img-1","generation":%d,"targets":[{"Service":"db","Port":5432,"Kind":"postgres","Address":%q}],"sql":[{"service":"db","port":5432,"database":"app","username":"kody_observer_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","password":%q}]}`, claim, generation, address, password)
}

// Managed configuration used to be rejected outright; a generic 409 could
// hide stale targets and SQL pools after a reset.
func TestManagedConfigGenerationIsClaimBoundAndIdempotent(t *testing.T) {
	s := &Server{CellID: "cell-1"}
	defer s.Close()
	h := s.Handler()
	password := strings.Repeat("A", 43)
	one := managedConfigJSON("claim-1", 1, "127.0.0.1:5432", password)
	first := putConfig(h, one)
	if first.Code != http.StatusNoContent {
		t.Fatalf("initial managed config status=%d", first.Code)
	}
	if first.Header().Get("X-Kodus-Observer-Config") == "" || first.Header().Get("X-Kodus-Observer-Generation") != "1" {
		t.Fatal("missing configuration identity")
	}
	if got := putConfig(h, one); got.Code != http.StatusNoContent || got.Header().Get("X-Kodus-Observer-Config") != first.Header().Get("X-Kodus-Observer-Config") {
		t.Fatalf("idempotent config status=%d", got.Code)
	}
	for _, body := range []string{
		managedConfigJSON("claim-2", 2, "127.0.0.2:5432", password),
		managedConfigJSON("claim-1", 1, "127.0.0.2:5432", password),
		strings.Replace(managedConfigJSON("claim-1", 2, "127.0.0.1:5432", password), "img-1", "img-other", 1),
	} {
		if got := putConfig(h, body); got.Code != http.StatusConflict {
			t.Fatalf("conflicting managed config status=%d", got.Code)
		}
	}
	next := putConfig(h, managedConfigJSON("claim-1", 2, "127.0.0.2:5432", password))
	if next.Code != http.StatusNoContent || next.Header().Get("X-Kodus-Observer-Generation") != "2" || next.Header().Get("X-Kodus-Observer-Config") == first.Header().Get("X-Kodus-Observer-Config") {
		t.Fatalf("next generation status=%d", next.Code)
	}
	if got := putConfig(h, one); got.Code != http.StatusConflict {
		t.Fatalf("stale config status=%d", got.Code)
	}
}

func TestConfigRejectsAmbiguousTrailingOrOversizedJSON(t *testing.T) {
	valid := `{"claimId":"claim-1","imageId":"img-1","targets":[]}`
	for name, body := range map[string]string{
		"unicode key":          `{"claimId":"claim-1","imageId":"img-1","targets":[],"\u017fql":[]}`,
		"duplicate claim":      `{"claimId":"claim-1","claimId":"claim-2","imageId":"img-1","targets":[]}`,
		"case duplicate":       `{"claimId":"claim-1","ClaimId":"claim-2","imageId":"img-1","targets":[]}`,
		"trailing object":      valid + ` {"imageId":"other"}`,
		"oversized whitespace": valid + strings.Repeat(" ", 64<<10),
		"nested duplicate":     `{"claimId":"claim-1","imageId":"img-1","targets":[{"Service":"db","Port":5432,"Kind":"postgres","Address":"127.0.0.1:5432","Address":"127.0.0.2:5432"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			s := &Server{CellID: "cell-1"}
			defer s.Close()
			if got := putConfig(s.Handler(), body); got.Code != http.StatusBadRequest {
				t.Fatalf("ambiguous config accepted status=%d", got.Code)
			}
		})
	}
}

func TestManagedConfigRefusesUnboundCredentialAndDuplicateTargets(t *testing.T) {
	base := managedConfigJSON("claim-1", 1, "127.0.0.1:5432", strings.Repeat("A", 43))
	for _, body := range []string{
		strings.Replace(base, `"service":"db"`, `"service":"other"`, 1),
		strings.Replace(base, `"port":5432`, `"port":5433`, 1),
		strings.Replace(base, `"Kind":"postgres"`, `"Kind":"mysql"`, 1),
		strings.Replace(base, `"generation":1,`, "", 1),
		strings.Replace(base, `"claimId":"claim-1",`, "", 1),
		strings.Replace(base, `"Address":"127.0.0.1:5432"`, `"Address":"host.example:5432"`, 1),
		strings.Replace(base, `"password":"`+strings.Repeat("A", 43)+`"`, `"password":"invalid"`, 1),
	} {
		s := &Server{}
		if got := putConfig(s.Handler(), body); got.Code != http.StatusBadRequest {
			t.Fatalf("unbound config status=%d", got.Code)
		}
		s.Close()
	}
}

func TestNewGenerationClosesOldPoolsAndPinsFreshAddress(t *testing.T) {
	var opened []*sql.DB
	var addresses []string
	s := &Server{OpenManagedSQL: func(tg Target, _ observerauth.Credential) (*sql.DB, error) {
		db, err := openFake(tg)
		opened = append(opened, db)
		addresses = append(addresses, tg.Address)
		return db, err
	}}
	defer s.Close()
	h := s.Handler()
	password := strings.Repeat("A", 43)
	if got := putConfig(h, managedConfigJSON("claim-1", 1, "127.0.0.1:5432", password)); got.Code != http.StatusNoContent {
		t.Fatalf("first config=%d", got.Code)
	}
	if _, err := s.runner.Run(context.Background(), step, sqlProbe(`SELECT id FROM orders`)); err != nil {
		t.Fatal(err)
	}
	if got := putConfig(h, managedConfigJSON("claim-1", 2, "127.0.0.2:5432", password)); got.Code != http.StatusNoContent {
		t.Fatalf("reset config=%d", got.Code)
	}
	if err := opened[0].Ping(); err == nil {
		t.Fatal("old SQL pool survived reconfiguration")
	}
	if _, err := s.runner.Run(context.Background(), step, sqlProbe(`SELECT id FROM orders`)); err != nil {
		t.Fatal(err)
	}
	if len(addresses) != 2 || addresses[0] != "127.0.0.1:5432" || addresses[1] != "127.0.0.2:5432" {
		t.Fatal("SQL pool reused an old target address")
	}
}

func TestManagedConfigRefusesInheritedPGEnvironmentBeforeReadiness(t *testing.T) {
	t.Setenv("PGSERVICE", "unrelated-service")
	s := &Server{}
	defer s.Close()
	got := putConfig(s.Handler(), managedConfigJSON("claim-1", 1, "127.0.0.1:5432", strings.Repeat("A", 43)))
	if got.Code != http.StatusServiceUnavailable || s.runner != nil {
		t.Fatalf("invalid connector admitted readiness status=%d", got.Code)
	}
}

type configRoundTrip func(*http.Request) (*http.Response, error)

func (f configRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestReconfigurationWaitsForActiveProbeBeforeClosingPool(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	var pool *sql.DB
	s := &Server{CellID: "cell-1", NewID: func() string { return "7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d" }, Base: Config{HTTP: &http.Client{Transport: configRoundTrip(func(r *http.Request) (*http.Response, error) {
		close(started)
		select {
		case <-release:
		case <-r.Context().Done():
			return nil, r.Context().Err()
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("ready"))}, nil
	})}}, OpenManagedSQL: func(tg Target, _ observerauth.Credential) (*sql.DB, error) {
		db, err := openFake(tg)
		pool = db
		return db, err
	}}
	defer s.Close()
	defer unblock()
	cfg := managedConfigJSON("claim-1", 1, "127.0.0.1:5432", strings.Repeat("A", 43))
	cfg = strings.Replace(cfg, `"targets":[`, `"targets":[{"Service":"api","Port":3000,"Kind":"http","Address":"127.0.0.1:3000"},`, 1)
	h := s.Handler()
	if got := putConfig(h, cfg); got.Code != http.StatusNoContent {
		t.Fatalf("initial config=%d", got.Code)
	}
	if _, err := s.runner.Run(context.Background(), step, sqlProbe(`SELECT id FROM orders`)); err != nil {
		t.Fatal(err)
	}
	frame, err := protocol.Encode(protocol.Header{ID: step, CellID: "cell-1", ClaimID: "claim-1"}, &protocol.ProbeRunBody{StepID: step, Probe: httpProbe("GET", "/orders")})
	if err != nil {
		t.Fatal(err)
	}
	probed := make(chan int, 1)
	go func() {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/run", bytes.NewReader(frame)))
		probed <- w.Code
	}()
	<-started
	changed := make(chan int, 1)
	go func() { changed <- putConfig(h, strings.Replace(cfg, `"generation":1`, `"generation":2`, 1)).Code }()
	deadline := time.After(time.Second)
	for {
		select {
		case <-changed:
			t.Fatal("reconfigured before active probe finished")
		case <-deadline:
			t.Fatal("reconfiguration never queued")
		default:
		}
		// A waiting writer prevents new readers. The active probe must
		// still own its old pools until that read-side handler drains.
		if !s.mu.TryRLock() {
			break
		}
		s.mu.RUnlock()
		runtime.Gosched()
	}
	if err := pool.Ping(); err != nil {
		t.Fatal("active probe's SQL pool closed before it drained")
	}
	unblock()
	if status := <-probed; status != http.StatusOK {
		t.Fatalf("probe status=%d", status)
	}
	if status := <-changed; status != http.StatusNoContent {
		t.Fatalf("reconfigure status=%d", status)
	}
	if err := pool.Ping(); err == nil {
		t.Fatal("old pool remains open after active probe drained")
	}
}
