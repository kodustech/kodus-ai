package preview

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

const (
	idA = "prv_aaaaaaaaaaaaaaaaaaaaaaaaaa"
	idB = "prv_bbbbbbbbbbbbbbbbbbbbbbbbbb"
)

type logBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *logBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

type fixture struct {
	svc  *Service
	clk  *clock.Fake
	logs *logBuf
	reg  *metrics.Registry
}

func newFixture(t *testing.T, edit ...func(*Config)) *fixture {
	t.Helper()
	f := &fixture{clk: clock.NewFake(time.Now()), logs: &logBuf{}, reg: metrics.NewRegistry()}
	cfg := Config{Clock: f.clk, Log: slog.New(slog.NewJSONHandler(f.logs, &slog.HandlerOptions{Level: slog.LevelDebug})), Metrics: f.reg}
	for _, e := range edit {
		e(&cfg)
	}
	f.svc = New(cfg)
	t.Cleanup(f.svc.Close)
	return f
}

// app is an exposed service of a claim: it echoes what it got.
func app(t *testing.T, name string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/large":
			mb, _ := strconv.Atoi(r.URL.Query().Get("mb"))
			buf := make([]byte, 64<<10)
			_, _ = rand.Read(buf)
			for range mb * 16 {
				if _, err := w.Write(buf); err != nil {
					return
				}
			}
		case "/slow":
			select {
			case <-time.After(300 * time.Millisecond):
				_, _ = io.WriteString(w, "slow")
			case <-r.Context().Done():
			}
		case "/hang":
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "first")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		default:
			body, _ := io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"app": name, "path": r.URL.RequestURI(), "headers": r.Header, "body": string(body)})
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func hostPort(t *testing.T, srv *httptest.Server) (string, int) {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	p, _ := strconv.Atoi(u.Port())
	return u.Host, p
}

// route routes previewID of claimID to the claim's observer preview proxy
// over targets, the way the agent does on preview.route.
func (f *fixture) route(t *testing.T, previewID, claimID string, target Target, targets []observer.Target) {
	t.Helper()
	if err := f.svc.Route(Route{PreviewID: previewID, ClaimID: claimID, Target: target, Until: f.clk.Now().Add(15 * time.Minute), Upstream: observer.PreviewHandler(targets)}); err != nil {
		t.Fatal(err)
	}
}

func get(t *testing.T, h http.Handler, previewID, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	if previewID != "" {
		req.Header.Set(HeaderPreviewID, previewID)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func echoed(t *testing.T, rec *httptest.ResponseRecorder) (string, string, http.Header) {
	t.Helper()
	var out struct {
		App     string      `json:"app"`
		Path    string      `json:"path"`
		Headers http.Header `json:"headers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("not the app's answer (%d %s): %v", rec.Code, rec.Body.String(), err)
	}
	return out.App, out.Path, out.Headers
}

func TestAStreamForAPreviewIDWithNoRouteIsRefused(t *testing.T) {
	f := newFixture(t)
	for _, id := range []string{idA, "", "not-a-preview/../x?y"} {
		rec := get(t, f.svc.Handler(), id, "/secret/path?token=abc")
		if rec.Code != http.StatusNotFound || rec.Header().Get(observer.PreviewRefusedHeader) != "no_route" {
			t.Fatalf("id %q: %d %q, want 404 no_route", id, rec.Code, rec.Header().Get(observer.PreviewRefusedHeader))
		}
	}
	if got := f.reg.Counter("cell_preview_streams_total", "", "outcome").Value("no_route"); got != 3 {
		t.Fatalf("no_route counted %v times, want 3", got)
	}
	if logs := f.logs.String(); !strings.Contains(logs, `"msg":"preview.route.refused"`) || !strings.Contains(logs, `"alarm":true`) {
		t.Fatalf("no alarm for a route the hub never declared: %s", logs)
	}
}

func TestARoutedPreviewReachesItsClaimsHTTPExposeAndNothingElse(t *testing.T) {
	f := newFixture(t)
	web, other, otherClaim := app(t, "web"), app(t, "admin"), app(t, "other-claim")
	webAddr, webPort := hostPort(t, web)
	otherAddr, otherPort := hostPort(t, other)
	otherClaimAddr, otherClaimPort := hostPort(t, otherClaim)
	claimA := []observer.Target{
		{Service: "web", Port: webPort, Kind: "http", Address: webAddr},
		{Service: "admin", Port: otherPort, Kind: "http", Address: otherAddr},
		{Service: "db", Port: 5432, Kind: "postgres", Address: otherAddr},
	}
	f.route(t, idA, "claim-a", Target{Service: "web", Port: webPort}, claimA)
	f.route(t, idB, "claim-b", Target{Service: "web", Port: otherClaimPort}, []observer.Target{{Service: "web", Port: otherClaimPort, Kind: "http", Address: otherClaimAddr}})

	rec := get(t, f.svc.Handler(), idA, "/orders?page=2")
	name, path, headers := echoed(t, rec)
	if name != "web" || path != "/orders?page=2" {
		t.Fatalf("reached %s %s, want web /orders?page=2", name, path)
	}
	for _, h := range []string{HeaderPreviewID, observer.PreviewTargetHeader, "X-Forwarded-For"} {
		if headers.Get(h) != "" {
			t.Fatalf("the app got %s", h)
		}
	}
	// The other claim's preview reaches only the other claim.
	if name, _, _ := echoed(t, get(t, f.svc.Handler(), idB, "/")); name != "other-claim" {
		t.Fatalf("preview B reached %s", name)
	}
	// A dot segment never walks to the observer's own API.
	for _, p := range []string{"/../config", "/a/../../v1/requests", "/./x"} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.URL.Path = p
		req.Header.Set(HeaderPreviewID, idA)
		rec := httptest.NewRecorder()
		f.svc.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d, want 400", p, rec.Code)
		}
	}
}

func TestTheObserverProxiesOnlyAnHTTPTargetOfItsOwn(t *testing.T) {
	web := app(t, "web")
	addr, port := hostPort(t, web)
	h := observer.PreviewHandler([]observer.Target{{Service: "web", Port: port, Kind: "http", Address: addr}, {Service: "db", Port: 5432, Kind: "postgres", Address: addr}})
	for _, target := range []string{"db:5432", "web:1", "other:" + strconv.Itoa(port), "", "web:" + strconv.Itoa(port) + "0", "169.254.169.254:80"} {
		req := httptest.NewRequest(http.MethodGet, observer.PreviewPath+"/", nil)
		req.Header.Set(observer.PreviewTargetHeader, target)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound || rec.Header().Get(observer.PreviewRefusedHeader) != "no_target" {
			t.Fatalf("target %q: %d, want 404 no_target", target, rec.Code)
		}
	}
	// The observer's mux sends only /v1/preview/ to the proxy; its own API stays its own.
	req := httptest.NewRequest(http.MethodGet, "/v1/requests", nil)
	req.Header.Set(observer.PreviewTargetHeader, "web:"+strconv.Itoa(port))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("/v1/requests through the preview proxy: %d", rec.Code)
	}
}

func TestPreviewTrafficNeverBecomesProbeEvidence(t *testing.T) {
	web := app(t, "web")
	addr, port := hostPort(t, web)
	srv := observer.Handler(observer.New(observer.Config{ImageID: "img", Targets: []observer.Target{{Service: "web", Port: port, Kind: "http", Address: addr}}}), "cell-1", func() string { return "id" })
	req := httptest.NewRequest(http.MethodGet, observer.PreviewPath+"/checkout", nil)
	req.Header.Set(observer.PreviewTargetHeader, "web:"+strconv.Itoa(port))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("preview through the observer: %d %s", rec.Code, rec.Body.String())
	}
	logRec := httptest.NewRecorder()
	srv.ServeHTTP(logRec, httptest.NewRequest(http.MethodGet, "/v1/requests", nil))
	if l := strings.TrimSpace(logRec.Body.String()); l != "[]" && l != "null" {
		t.Fatalf("the probe request log has preview traffic: %s", logRec.Body.String())
	}
}

func TestUnrouteClosesOpenStreamsWithinASecond(t *testing.T) {
	f := newFixture(t)
	web := app(t, "web")
	addr, port := hostPort(t, web)
	f.route(t, idA, "claim-a", Target{Service: "web", Port: port}, []observer.Target{{Service: "web", Port: port, Kind: "http", Address: addr}})
	edge := httptest.NewServer(f.svc.Handler())
	t.Cleanup(edge.Close)
	req, _ := http.NewRequest(http.MethodGet, edge.URL+"/hang", nil)
	req.Header.Set(HeaderPreviewID, idA)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	first := make([]byte, 5)
	if _, err := io.ReadFull(resp.Body, first); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if !f.svc.Unroute(idA, "claim-a") {
		t.Fatal("unroute found no route")
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	if took := time.Since(start); took > time.Second {
		t.Fatalf("the stream ended %v after the unroute, want under a second", took)
	}
	if rec := get(t, f.svc.Handler(), idA, "/"); rec.Code != http.StatusNotFound {
		t.Fatalf("after unroute: %d", rec.Code)
	}
}

func TestAReleasedClaimLeavesNoRoute(t *testing.T) {
	f := newFixture(t)
	web := app(t, "web")
	addr, port := hostPort(t, web)
	targets := []observer.Target{{Service: "web", Port: port, Kind: "http", Address: addr}}
	f.route(t, idA, "claim-a", Target{Service: "web", Port: port}, targets)
	f.route(t, idB, "claim-a", Target{Service: "web", Port: port}, targets)
	if n := f.svc.ReleaseClaim("claim-a"); n != 2 || f.svc.Routes() != 0 {
		t.Fatalf("release dropped %d routes, %d left", n, f.svc.Routes())
	}
	if rec := get(t, f.svc.Handler(), idA, "/"); rec.Code != http.StatusNotFound {
		t.Fatalf("a released claim still serves: %d", rec.Code)
	}
}

func TestARouteRefusesPastItsEndAndAnotherClaimCannotTakeItsID(t *testing.T) {
	f := newFixture(t)
	web := app(t, "web")
	addr, port := hostPort(t, web)
	targets := []observer.Target{{Service: "web", Port: port, Kind: "http", Address: addr}}
	f.route(t, idA, "claim-a", Target{Service: "web", Port: port}, targets)
	if err := f.svc.Route(Route{PreviewID: idA, ClaimID: "claim-b", Target: Target{Service: "web", Port: port}, Until: f.clk.Now().Add(time.Hour), Upstream: observer.PreviewHandler(targets)}); !errors.Is(err, ErrOtherClaim) {
		t.Fatalf("another claim took the route: %v", err)
	}
	f.clk.Advance(15 * time.Minute)
	if rec := get(t, f.svc.Handler(), idA, "/"); rec.Code != http.StatusNotFound {
		t.Fatalf("past its until: %d", rec.Code)
	}
}

func TestAPreviewBeyondItsConcurrentStreamsIsBusy(t *testing.T) {
	f := newFixture(t, func(c *Config) { c.MaxStreams = 2 })
	web := app(t, "web")
	addr, port := hostPort(t, web)
	f.route(t, idA, "claim-a", Target{Service: "web", Port: port}, []observer.Target{{Service: "web", Port: port, Kind: "http", Address: addr}})
	edge := httptest.NewServer(f.svc.Handler())
	t.Cleanup(edge.Close)
	var open []io.Closer
	for range 2 {
		req, _ := http.NewRequest(http.MethodGet, edge.URL+"/hang", nil)
		req.Header.Set(HeaderPreviewID, idA)
		resp, err := http.DefaultClient.Do(req) //nolint:bodyclose // held open as one of the two busy streams; its body is closed at the end of the test
		if err != nil {
			t.Fatal(err)
		}
		// Held open (the two streams the third finds busy), closed below.
		open = append(open, resp.Body)
	}
	if rec := get(t, f.svc.Handler(), idA, "/"); rec.Code != http.StatusServiceUnavailable || rec.Header().Get(observer.PreviewRefusedHeader) != "busy" {
		t.Fatalf("a third stream: %d", rec.Code)
	}
	f.svc.Unroute(idA, "claim-a")
	for _, b := range open {
		_ = b.Close()
	}
}

// edgeStub is the preview edge's tunnel endpoint: it checks the client
// certificate and the ticket, and talks HTTP/2 to the cell over the
// WebSocket as the edge does.
type edgeStub struct {
	srv     *httptest.Server
	url     string
	dials   atomic.Int32
	tickets chan string
	conns   chan *http.Transport
	closed  chan struct{}
}

func newEdge(t *testing.T, ca *testpki.CA) *edgeStub {
	t.Helper()
	e := &edgeStub{tickets: make(chan string, 4), conns: make(chan *http.Transport, 4), closed: make(chan struct{}, 4)}
	srvCert, err := ca.Issue("edge", time.Hour, "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	e.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.dials.Add(1)
		if r.URL.Path != "/v1/cells/tunnel" || len(r.TLS.PeerCertificates) == 0 || r.TLS.PeerCertificates[0].Subject.CommonName != "cell-1" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		e.tickets <- strings.TrimPrefix(r.Header.Get("Authorization"), AuthScheme+" ")
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
		if err != nil {
			return
		}
		ws.SetReadLimit(maxMessage)
		nc := &readWatch{Conn: websocket.NetConn(context.WithoutCancel(r.Context()), ws, websocket.MessageBinary), ended: e.closed}
		var once atomic.Bool
		var p http.Protocols
		p.SetUnencryptedHTTP2(true)
		tr := &http.Transport{Protocols: &p, DialContext: func(context.Context, string, string) (net.Conn, error) {
			if once.Swap(true) {
				return nil, fmt.Errorf("one tunnel connection only")
			}
			return nc, nil
		}}
		e.conns <- tr
	}))
	e.srv.TLS = &tls.Config{Certificates: []tls.Certificate{srvCert}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: ca.Pool(), MinVersion: tls.VersionTLS13}
	e.srv.StartTLS()
	t.Cleanup(e.srv.Close)
	e.url = "wss://" + strings.TrimPrefix(e.srv.URL, "https://") + "/v1/cells/tunnel"
	return e
}

// readWatch tells when the edge's side of the tunnel stops reading: the
// cell closed it.
type readWatch struct {
	net.Conn
	ended chan struct{}
	once  sync.Once
}

func (r *readWatch) Read(p []byte) (int, error) {
	n, err := r.Conn.Read(p)
	if err != nil {
		r.once.Do(func() { r.ended <- struct{}{} })
	}
	return n, err
}

func cellTLS(t *testing.T, ca *testpki.CA) func() *tls.Config {
	t.Helper()
	cert, err := ca.Issue("cell-1", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return func() *tls.Config {
		return &tls.Config{Certificates: []tls.Certificate{cert}, RootCAs: ca.Pool(), MinVersion: tls.VersionTLS13}
	}
}

func TestTheTunnelServesARequestALargeStreamAndConcurrentStreamsOverAWebSocket(t *testing.T) {
	ca, err := testpki.NewCA("cells")
	if err != nil {
		t.Fatal(err)
	}
	edge := newEdge(t, ca)
	f := newFixture(t, func(c *Config) { c.TLS = cellTLS(t, ca) })
	web := app(t, "web")
	addr, port := hostPort(t, web)
	f.route(t, idA, "claim-a", Target{Service: "web", Port: port}, []observer.Target{{Service: "web", Port: port, Kind: "http", Address: addr}})
	ticket := strings.Repeat("A", 43)
	if err := f.svc.Tunnel(context.Background(), edge.url, ticket); err != nil {
		t.Fatal(err)
	}
	if got := <-edge.tickets; got != ticket {
		t.Fatalf("the edge got ticket %q", got)
	}
	tr := <-edge.conns
	client := &http.Client{Transport: tr}
	// do is the response's HTTP major version (0: no response) and its body.
	do := func(path string) (int, []byte) {
		req, _ := http.NewRequest(http.MethodGet, "http://p-host.preview.example"+path, nil)
		req.Header.Set(HeaderPreviewID, idA)
		resp, err := client.Do(req)
		if err != nil {
			t.Error(err)
			return 0, nil
		}
		defer func() { _ = resp.Body.Close() }()
		b, _ := io.ReadAll(resp.Body)
		return resp.ProtoMajor, b
	}
	if proto, b := do("/hello?x=1"); proto != 2 || !strings.Contains(string(b), `"path":"/hello?x=1"`) {
		t.Fatalf("a request over the tunnel: HTTP/%d %s", proto, b)
	}
	if _, b := do("/large?mb=64"); len(b) != 64<<20 {
		t.Fatalf("a large response arrived with %d bytes, want %d", len(b), 64<<20)
	}
	var wg sync.WaitGroup
	start := time.Now()
	var ok atomic.Int32
	for range 50 {
		wg.Go(func() {
			if proto, b := do("/slow"); proto != 0 && string(b) == "slow" {
				ok.Add(1)
			}
		})
	}
	wg.Wait()
	if ok.Load() != 50 || time.Since(start) > 3*time.Second {
		t.Fatalf("%d of 50 concurrent streams in %v: they did not run side by side", ok.Load(), time.Since(start))
	}
	// A second preview.tunnel for the same edge keeps the open tunnel.
	if err := f.svc.Tunnel(context.Background(), edge.url, strings.Repeat("B", 43)); err != nil || edge.dials.Load() != 1 {
		t.Fatalf("a second tunnel frame dialed again (%d dials, %v)", edge.dials.Load(), err)
	}
	if logs := f.logs.String(); strings.Contains(logs, "hello") || strings.Contains(logs, "x=1") || strings.Contains(logs, ticket) {
		t.Fatalf("a path, a query or the ticket reached the logs: %s", logs)
	}
}

func TestTheTunnelClosesFiveMinutesAfterItsLastRoute(t *testing.T) {
	ca, err := testpki.NewCA("cells")
	if err != nil {
		t.Fatal(err)
	}
	edge := newEdge(t, ca)
	f := newFixture(t, func(c *Config) { c.TLS = cellTLS(t, ca) })
	web := app(t, "web")
	addr, port := hostPort(t, web)
	targets := []observer.Target{{Service: "web", Port: port, Kind: "http", Address: addr}}
	f.route(t, idA, "claim-a", Target{Service: "web", Port: port}, targets)
	if err := f.svc.Tunnel(context.Background(), edge.url, strings.Repeat("A", 43)); err != nil {
		t.Fatal(err)
	}
	tr := <-edge.conns
	req, _ := http.NewRequest(http.MethodGet, "http://p-host.preview.example/", nil)
	req.Header.Set(HeaderPreviewID, idA)
	resp, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	f.svc.Unroute(idA, "claim-a")
	// A route back within the five minutes keeps the tunnel.
	f.clk.Advance(4 * time.Minute)
	f.route(t, idA, "claim-a", Target{Service: "web", Port: port}, targets)
	f.clk.Advance(2 * time.Minute)
	if f.svc.CloseIdle() {
		t.Fatal("the tunnel closed while a route was back")
	}
	f.svc.ReleaseClaim("claim-a")
	f.clk.Advance(4*time.Minute + 59*time.Second)
	if f.svc.CloseIdle() {
		t.Fatal("the tunnel closed before five minutes without a route")
	}
	f.clk.Advance(time.Second)
	if !f.svc.CloseIdle() {
		t.Fatal("the tunnel stayed open five minutes after its last route")
	}
	select {
	case <-edge.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the edge never saw the tunnel close")
	}
	waitFor(t, func() bool { _, up := f.svc.Connected(); return !up }, 5*time.Second)
}

// waitFor polls cond until it holds or d passes.
func waitFor(t *testing.T, cond func() bool, d time.Duration) {
	t.Helper()
	end := time.Now().Add(d)
	for !cond() {
		if time.Now().After(end) {
			t.Fatal("condition never held")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
