package agent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/evidence"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// evidenceStore is the evidence server's upload side: it records each PUT.
type evidenceStore struct {
	mu   sync.Mutex
	puts map[string]stored
	srv  *httptest.Server
}

type stored struct {
	contentType string
	body        string
}

func newEvidenceStore(t *testing.T) *evidenceStore {
	s := &evidenceStore{puts: map[string]stored{}}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.puts[r.URL.Path] = stored{r.Header.Get("Content-Type"), string(b)}
		s.mu.Unlock()
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *evidenceStore) get(path string) (stored, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.puts[path]
	return v, ok
}

func (s *evidenceStore) grant(typ protocol.EvidenceUploadType, ct protocol.EvidenceContentType, max int64, exp time.Time) protocol.UploadGrant {
	return protocol.UploadGrant{Type: typ, URL: s.srv.URL + "/" + string(typ) + "?sig=x", ContentType: ct, MaxBytes: max, ExpiresAt: protocol.FormatTime(exp)}
}

// recordingObserver answers with what the app did and keeps the frame it got.
type recordingObserver struct {
	mu    sync.Mutex
	frame []byte
}

func (o *recordingObserver) Run(_ context.Context, frame []byte) (*protocol.StepResultBody, string, error) {
	o.mu.Lock()
	o.frame = frame
	o.mu.Unlock()
	at := int64(3)
	return &protocol.StepResultBody{StepID: step1, Executor: protocol.ExecutorObserver, ImageID: "img-1", VMHealth: protocol.VMHealthOk, Probe: &protocol.ProbeResult{
		StepID: step1, Executor: "observer", ImageID: "img-1", Transport: protocol.ProbeResultTransportOk, DurationMs: 9,
		HTTP:     &protocol.ProbeResultHTTP{Status: 500, Headers: map[string]string{}, Body: "{}"},
		Requests: []protocol.RequestLogEntry{{Method: "POST", Route: "/orders", Status: 500, At: &at}},
		Evidence: &protocol.ProbeEvidence{T0: "2026-11-06T12:00:00Z", Db: &protocol.DBEffects{Engine: protocol.DBEnginePostgres, Service: "db",
			Tables: []protocol.DBTableEffect{{Table: "public.orders", Inserted: 1, Rows: 1}},
			Sample: []protocol.DBSample{{Table: "public.orders", Columns: []string{"id", "note"}, Rows: [][]json.RawMessage{{json.RawMessage(`7`), json.RawMessage(`"token ghs_download"`)}}}}}},
	}}, "", nil
}

type logsStub []driver.ServiceLogLine

func (l logsStub) ServiceLogs(context.Context, string, driver.MachineRef, time.Time, time.Time, int) ([]driver.ServiceLogLine, error) {
	return l, nil
}

type outboundStub []evidence.OutboundCall

func (o outboundStub) Outbound(context.Context, string, time.Time, time.Time) ([]evidence.OutboundCall, error) {
	return o, nil
}

func evidenceProbe(ev *protocol.EvidenceRequest) *protocol.ProbeRunBody {
	return &protocol.ProbeRunBody{StepID: step1, Evidence: ev, Probe: protocol.Probe{
		ID: "p", Origin: protocol.ProbeOriginAgent, Purpose: "p", Expected: "200",
		Compare: []protocol.CompareField{protocol.CompareFieldStatus},
		Spec:    protocol.ProbeSpec{HTTP: &protocol.HTTPProbe{Target: protocol.ProbeTarget{Service: "api", Port: 80}, Method: protocol.HTTPMethodPost, Path: "/orders", TimeoutMs: 1000}},
	}}
}

func evidenceHarness(t *testing.T, accepts ...string) (*harness, *recordingObserver, *evidenceStore) {
	obs := &recordingObserver{}
	store := newEvidenceStore(t)
	now := time.Now()
	h := newHarness(t, func(c *Config) {
		c.Observers = func(context.Context, ClaimInfo, []observer.Target) (observer.Client, error) { return obs, nil }
		c.ServiceLogs = logsStub{
			{Service: "api", At: now.Add(-time.Hour), Text: "before the round"},
			{Service: "api", At: now, Text: "POST /orders failed for ghs_download"},
		}
		c.Outbound = outboundStub{{Host: "api.stripe.com", Port: 443, At: now, Allowed: false}}
	})
	// The fake clock stands still: the round's window is its one instant.
	h.clk.Set(now)
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: accepts})
	return h, obs, store
}

var everyEvidenceFeature = []string{protocol.FeatureTimedRequests, protocol.FeatureServiceLogs, protocol.FeatureDBEffects, protocol.FeatureOutboundCalls, protocol.FeatureExecCast}

// A round on a hub that takes the evidence: service logs, db effects and
// outbound calls in the window, redacted; the logs and the rows uploaded
// with their grants; the rows never in the frame; the observer never sees
// a grant.
func TestProbeEvidenceCapturedRedactedAndUploaded(t *testing.T) {
	h, obs, store := evidenceHarness(t, everyEvidenceFeature...)
	h.ready("claim-1")
	exp := h.clk.Now().Add(10 * time.Minute)
	ev := &protocol.EvidenceRequest{
		Capture: []protocol.EvidenceCapture{protocol.EvidenceCaptureLogs, protocol.EvidenceCaptureDb, protocol.EvidenceCaptureOutbound},
		Uploads: []protocol.UploadGrant{
			store.grant(protocol.EvidenceUploadTypeLogs, protocol.EvidenceContentTypeTextPlain, 256<<10, exp),
			store.grant(protocol.EvidenceUploadTypeDb, protocol.EvidenceContentTypeApplicationJSON, 64<<10, exp),
		},
	}
	if err := h.handle("claim-1", protocol.MessageTypeProbeRun, evidenceProbe(ev)); err != nil {
		t.Fatal(err)
	}
	r := h.conn.next(t, isResult(step1)).(*protocol.StepResultBody)
	p := r.Probe
	if p.Requests[0].At == nil || *p.Requests[0].At != 3 {
		t.Fatalf("requests %+v", p.Requests)
	}
	e := p.Evidence
	if e == nil || e.Logs == nil || e.Db == nil || e.Outbound == nil {
		t.Fatalf("evidence %+v", e)
	}
	if e.Logs.Lines != 1 || len(e.Logs.Tail) != 1 || strings.Contains(e.Logs.Tail[0].Text, "ghs_download") || e.Logs.Tail[0].Service != "api" {
		t.Fatalf("logs %+v", e.Logs)
	}
	if e.Db.Sample != nil || len(e.Db.Tables) != 1 || e.Db.Tables[0].Inserted != 1 {
		t.Fatalf("db %+v", e.Db)
	}
	if len(e.Outbound.Calls) != 1 || e.Outbound.Calls[0].Host != "api.stripe.com" || e.Outbound.Calls[0].Allowed {
		t.Fatalf("outbound %+v", e.Outbound)
	}
	if len(e.Refs) != 2 || e.Refs[0].Type != protocol.EvidenceUploadTypeLogs || e.Refs[1].Type != protocol.EvidenceUploadTypeDb || len(e.Refs[0].Sha256) != 64 {
		t.Fatalf("refs %+v", e.Refs)
	}
	logs, ok := store.get("/logs")
	if !ok || logs.contentType != "text/plain" || strings.Contains(logs.body, "ghs_download") || !strings.Contains(logs.body, "api | POST /orders failed") || strings.Contains(logs.body, "before the round") {
		t.Fatalf("logs upload %+v", logs)
	}
	db, ok := store.get("/db")
	if !ok || db.contentType != "application/json" || strings.Contains(db.body, "ghs_download") || !strings.Contains(db.body, `"sample"`) {
		t.Fatalf("db upload %+v", db)
	}
	obs.mu.Lock()
	frame := string(obs.frame)
	obs.mu.Unlock()
	if strings.Contains(frame, "uploads") || !strings.Contains(frame, `"capture":["db"]`) {
		t.Fatalf("observer frame %s", frame)
	}
	// The frame the hub got passes the protocol (Encode re-decodes it).
	if _, err := protocol.Encode(protocol.Header{ID: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", CellID: "cell-1", ClaimID: "claim-1"}, r); err != nil {
		t.Fatal(err)
	}
}

// An older hub (its ack accepts none of it) never sees the fields: no
// evidence, no request times, no upload, and the observer is asked nothing.
func TestProbeEvidenceNotSentToAnOlderHub(t *testing.T) {
	h, obs, store := evidenceHarness(t)
	h.ready("claim-1")
	exp := h.clk.Now().Add(10 * time.Minute)
	ev := &protocol.EvidenceRequest{Capture: []protocol.EvidenceCapture{protocol.EvidenceCaptureLogs, protocol.EvidenceCaptureDb}, Uploads: []protocol.UploadGrant{store.grant(protocol.EvidenceUploadTypeLogs, protocol.EvidenceContentTypeTextPlain, 1<<20, exp)}}
	if err := h.handle("claim-1", protocol.MessageTypeProbeRun, evidenceProbe(ev)); err != nil {
		t.Fatal(err)
	}
	r := h.conn.next(t, isResult(step1)).(*protocol.StepResultBody)
	if r.Probe.Evidence != nil || r.Probe.Requests[0].At != nil {
		t.Fatalf("%+v", r.Probe)
	}
	if _, ok := store.get("/logs"); ok {
		t.Fatal("uploaded for a hub that does not take the ref")
	}
	obs.mu.Lock()
	defer obs.mu.Unlock()
	if strings.Contains(string(obs.frame), "evidence") {
		t.Fatalf("observer frame %s", obs.frame)
	}
}

// A grant that expired, or one for another content type, uploads nothing:
// the block is still summarized, without a ref.
func TestProbeEvidenceRefusesABadGrant(t *testing.T) {
	h, _, store := evidenceHarness(t, everyEvidenceFeature...)
	h.ready("claim-1")
	ev := &protocol.EvidenceRequest{Capture: []protocol.EvidenceCapture{protocol.EvidenceCaptureLogs, protocol.EvidenceCaptureDb}, Uploads: []protocol.UploadGrant{
		store.grant(protocol.EvidenceUploadTypeLogs, protocol.EvidenceContentTypeTextPlain, 1<<20, h.clk.Now().Add(-time.Second)),
		store.grant(protocol.EvidenceUploadTypeDb, protocol.EvidenceContentTypeTextPlain, 1<<20, h.clk.Now().Add(time.Minute)),
	}}
	if err := h.handle("claim-1", protocol.MessageTypeProbeRun, evidenceProbe(ev)); err != nil {
		t.Fatal(err)
	}
	r := h.conn.next(t, isResult(step1)).(*protocol.StepResultBody)
	if e := r.Probe.Evidence; e == nil || e.Logs == nil || e.Db == nil || len(e.Refs) != 0 {
		t.Fatalf("%+v", e)
	}
	if _, ok := store.get("/logs"); ok {
		t.Fatal("an expired grant was used")
	}
	if _, ok := store.get("/db"); ok {
		t.Fatal("a grant for another content type was used")
	}
}

// A test's output becomes an asciicast v2 artifact, redacted, uploaded with
// the cast grant; the exec result carries its ref.
func TestExecCastUploaded(t *testing.T) {
	store := newEvidenceStore(t)
	h := newHarness(t, func(c *Config) {
		c.Transport = stubTransport{exec: func(context.Context, kodyexec.Request) (kodyexec.Result, error) {
			return kodyexec.Result{ExitCode: 1, Stdout: "FAIL cart.test.ts\nusing ghs_download\n", Stderr: "boom\n", DurationMs: 1500}, nil
		}}
	})
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: everyEvidenceFeature})
	h.ready("claim-1")
	exec := &protocol.ExecBody{StepID: step1, Command: "npm test", TimeoutMs: 60_000, Evidence: &protocol.EvidenceRequest{
		Capture: []protocol.EvidenceCapture{protocol.EvidenceCaptureCast},
		Uploads: []protocol.UploadGrant{store.grant(protocol.EvidenceUploadTypeCast, protocol.EvidenceContentTypeTextPlain, 512<<10, h.clk.Now().Add(time.Minute))},
	}}
	if err := h.handle("claim-1", protocol.MessageTypeExec, exec); err != nil {
		t.Fatal(err)
	}
	r := h.conn.next(t, isResult(step1)).(*protocol.StepResultBody)
	if r.Exec == nil || len(r.Exec.Refs) != 1 || r.Exec.Refs[0].Type != protocol.EvidenceUploadTypeCast {
		t.Fatalf("%+v", r.Exec)
	}
	cast, ok := store.get("/cast")
	if !ok || strings.Contains(cast.body, "ghs_download") {
		t.Fatalf("cast %+v", cast)
	}
	lines := strings.Split(strings.TrimRight(cast.body, "\n"), "\n")
	if len(lines) != 4 || !strings.HasPrefix(lines[0], `{"version":2,`) || !strings.HasPrefix(lines[1], `[1.500000,"o","FAIL cart.test.ts\r\n`) || lines[3] != `[1.500000,"m","exit 1"]` {
		t.Fatalf("cast %q", lines)
	}
}
