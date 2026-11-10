package agent

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/browser"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// stubRunner stands for the browser runner container: it answers one
// passing goto and one screenshot, with a HAR that names the download token.
type stubRunner struct {
	mu   sync.Mutex
	spec browser.RunSpec
	job  []byte
	t0   time.Time
}

func (s *stubRunner) Run(_ context.Context, spec browser.RunSpec, job []byte, out io.Writer) error {
	s.mu.Lock()
	s.spec, s.job = spec, job
	s.mu.Unlock()
	img := image.NewNRGBA(image.Rect(0, 0, 20, 10))
	for i := range img.Pix {
		img.Pix[i] = 255
	}
	img.SetNRGBA(0, 0, color.NRGBA{0, 0, 0, 255})
	var shot bytes.Buffer
	_ = png.Encode(&shot, img)
	result, _ := json.Marshal(map[string]any{"t0Epoch": s.t0.UnixMilli(), "videoStartMs": 5, "steps": []map[string]any{
		{"index": 0, "kind": "goto", "ok": true, "startMs": 10, "endMs": 20},
		{"index": 1, "kind": "screenshot", "ok": true, "startMs": 20, "endMs": 30, "screenshot": 0},
	}, "console": []any{}, "network": []map[string]any{{"method": "GET", "url": "http://app.kody.internal:3000/orders?t=ghs_download", "at": 12, "complete": true, "status": 200, "ms": 3}}, "networkComplete": true, "networkTruncated": false})
	har, _ := json.Marshal(map[string]any{"log": map[string]any{"entries": []map[string]any{{
		"startedDateTime": s.t0.Add(12 * time.Millisecond).Format(time.RFC3339Nano), "time": 3,
		"request": map[string]any{"method": "GET", "url": "http://app.kody.internal:3000/orders?t=ghs_download"}, "response": map[string]any{"status": 200},
	}}}})
	tw := tar.NewWriter(out)
	for _, f := range []struct {
		name string
		body []byte
	}{{"result.json", result}, {"screenshot-0.png", shot.Bytes()}, {"har.json", har}} {
		_ = tw.WriteHeader(&tar.Header{Name: f.name, Mode: 0o644, Size: int64(len(f.body)), Typeflag: tar.TypeReg})
		_, _ = tw.Write(f.body)
	}
	return tw.Close()
}

func TestBrowserProbeForwardsEvidenceModeAndRejectsUnknownBeforeRunner(t *testing.T) {
	for _, mode := range []protocol.EvidenceLevel{"", protocol.EvidenceLevelFull, protocol.EvidenceLevelLean, "invalid"} {
		t.Run(string(mode), func(t *testing.T) {
			runner := &stubRunner{}
			h := newHarness(t, func(c *Config) { c.Browser = runner })
			runner.t0 = h.clk.Now()
			h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureBrowser}})
			h.ready("claim-1", withApp)
			body := browserProbeRun(&protocol.EvidenceRequest{Capture: []protocol.EvidenceCapture{protocol.EvidenceCaptureBrowser}})
			if mode != "" {
				body.Probe.Evidence = &mode
			}
			if err := h.handle("claim-1", protocol.MessageTypeProbeRun, body); err != nil {
				t.Fatal(err)
			}
			result := h.conn.next(t, isResult(step1)).(*protocol.StepResultBody)
			runner.mu.Lock()
			job := append([]byte(nil), runner.job...)
			runner.mu.Unlock()
			if mode == "invalid" {
				if job != nil || result.Probe != nil {
					t.Fatal("unknown mode started work or produced passing result")
				}
				return
			}
			want := mode
			if want == "" {
				want = protocol.EvidenceLevelFull
			}
			var decoded map[string]any
			_ = json.Unmarshal(job, &decoded)
			if decoded["evidence"] != string(want) || result.Probe == nil {
				t.Fatalf("mode %s forwarded %v, result %+v", want, decoded["evidence"], result.Probe)
			}
		})
	}
}

func browserProbeRun(ev *protocol.EvidenceRequest) *protocol.ProbeRunBody {
	goto_, shot := "/", "orders"
	return &protocol.ProbeRunBody{StepID: step1, Evidence: ev, Probe: protocol.Probe{
		ID: "orders-page", Origin: protocol.ProbeOriginAgent, Purpose: "p", Expected: "the list",
		Compare: []protocol.CompareField{protocol.CompareFieldPixels},
		Spec: protocol.ProbeSpec{Browser: &protocol.BrowserProbe{Kind: "browser", Steps: []protocol.BrowserStep{{Goto: &goto_}, {Screenshot: &shot}},
			Viewport: protocol.BrowserProbeViewport{Width: 1280, Height: 720}, TimeoutMs: 30_000}},
	}}
}

func withApp(b *protocol.ClaimAcquireBody) {
	b.Expose = []protocol.Expose{{Service: "db", Port: 5432, Kind: protocol.ExposeKindPostgres}, {Service: "app", Port: 3000, Kind: protocol.ExposeKindHTTP}}
}

// A browser probe on a cell with a runner and a hub that accepts it: the
// cell plays it (never the observer), redacts the HAR, uploads each
// artifact with its grant, and the result carries the steps, the page's
// requests to the app and the refs.
func TestBrowserProbePlayedInTheRunnerAndUploaded(t *testing.T) {
	store := newEvidenceStore(t)
	runner := &stubRunner{}
	obsCalled := false
	h := newHarness(t, func(c *Config) {
		c.Browser = runner
		c.Observers = func(context.Context, ClaimInfo, []observer.Target) (observer.Client, error) {
			obsCalled = true
			return nil, io.EOF
		}
	})
	runner.t0 = h.clk.Now()
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureBrowser, protocol.FeatureTimedRequests}})
	h.ready("claim-1", withApp)
	exp := h.clk.Now().Add(10 * time.Minute)
	ev := &protocol.EvidenceRequest{Capture: []protocol.EvidenceCapture{protocol.EvidenceCaptureBrowser}, Uploads: []protocol.UploadGrant{
		store.grant(protocol.EvidenceUploadTypeScreenshot0, protocol.EvidenceContentTypeImagePng, 2<<20, exp),
		store.grant(protocol.EvidenceUploadTypeHar, protocol.EvidenceContentTypeApplicationJSON, 10<<20, exp),
	}}
	if err := h.handle("claim-1", protocol.MessageTypeProbeRun, browserProbeRun(ev)); err != nil {
		t.Fatal(err)
	}
	r := h.conn.next(t, isResult(step1)).(*protocol.StepResultBody)
	if obsCalled {
		t.Fatal("the observer was asked to play a browser probe")
	}
	p := r.Probe
	if p == nil || p.Browser == nil || len(p.Browser.Steps) != 2 || !p.Browser.Steps[1].Ok || *p.Browser.Steps[1].Screenshot != 0 {
		t.Fatalf("result %+v", p)
	}
	if r.Executor != protocol.ExecutorObserver || p.Executor != "observer" {
		t.Fatalf("executor %s/%s", r.Executor, p.Executor)
	}
	if len(p.Requests) != 1 || p.Requests[0].Route != "/orders" {
		t.Fatalf("requests %+v", p.Requests)
	}
	runner.mu.Lock()
	spec, job := runner.spec, string(runner.job)
	runner.mu.Unlock()
	if spec.Service != "app" || spec.Port != 3000 || spec.ClaimID != "claim-1" || !strings.Contains(job, `"origin":"http://app.kody.internal:3000"`) {
		t.Fatalf("runner spec %+v job %s", spec, job)
	}
	if p.Evidence == nil || len(p.Evidence.Refs) != 2 {
		t.Fatalf("refs %+v", p.Evidence)
	}
	shot, ok := store.get("/screenshot-0")
	if !ok || shot.contentType != "image/png" {
		t.Fatalf("screenshot upload %+v", shot.contentType)
	}
	har, ok := store.get("/har")
	if !ok || strings.Contains(har.body, "ghs_download") {
		t.Fatal("the HAR was not redacted with the claim's redactor")
	}
	for _, n := range p.Browser.Network {
		if strings.Contains(n.URL, "ghs_download") {
			t.Fatalf("network %+v", n)
		}
	}
	if _, err := protocol.Encode(protocol.Header{ID: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", CellID: "cell-1", ClaimID: "claim-1"}, r); err != nil {
		t.Fatal(err)
	}
}

// Without the runner, or for a hub that does not accept browser, the probe
// goes to the observer as before, which refuses it (browser_unavailable).
func TestBrowserProbeGoesToTheObserverWithoutTheFeature(t *testing.T) {
	for name, edit := range map[string]func(*Config, *harness){
		"no runner":  func(c *Config, _ *harness) {},
		"older hub":  func(c *Config, _ *harness) { c.Browser = &stubRunner{} },
		"no capture": func(c *Config, _ *harness) { c.Browser = &stubRunner{} },
	} {
		t.Run(name, func(t *testing.T) {
			var asked bool
			var h *harness
			h = newHarness(t, func(c *Config) {
				edit(c, h)
				c.Observers = func(_ context.Context, ci ClaimInfo, targets []observer.Target) (observer.Client, error) {
					asked = true
					return observer.InProcess{Runner: observer.New(observer.Config{ImageID: "img-1", Targets: targets})}, nil
				}
			})
			if name != "older hub" {
				h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureBrowser}})
			}
			h.ready("claim-1", withApp)
			ev := &protocol.EvidenceRequest{Capture: []protocol.EvidenceCapture{protocol.EvidenceCaptureBrowser}}
			if name == "no capture" {
				ev = nil
			}
			if err := h.handle("claim-1", protocol.MessageTypeProbeRun, browserProbeRun(ev)); err != nil {
				t.Fatal(err)
			}
			r := h.conn.next(t, isResult(step1)).(*protocol.StepResultBody)
			if !asked || r.Probe != nil {
				t.Fatalf("observer asked %v, probe %+v", asked, r.Probe)
			}
		})
	}
}
