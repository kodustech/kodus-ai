package browser

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// fakeRunner stands for the container: it records the job and writes the
// tar stream a test built.
type fakeRunner struct {
	job    []byte
	spec   RunSpec
	stream []byte
	err    error
}

func (f *fakeRunner) Run(_ context.Context, spec RunSpec, job []byte, out io.Writer) error {
	f.job, f.spec = job, spec
	if f.stream != nil {
		if _, err := out.Write(f.stream); err != nil {
			return err
		}
	}
	return f.err
}

type entry struct {
	name string
	body []byte
}

func tarOf(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		if err := tw.WriteHeader(&tar.Header{Name: e.name, Mode: 0o644, Size: int64(len(e.body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(e.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func pngOf(t *testing.T, w, h int, c color.NRGBA) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, solid(w, h, c)); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(body))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func ptr[T any](v T) *T { return &v }

var t0 = time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)

// The orders page probe of the sample app: goto, wait, read, screenshot.
func ordersProbe() protocol.BrowserProbe {
	return protocol.BrowserProbe{
		Kind: "browser",
		Steps: []protocol.BrowserStep{
			{Goto: ptr("/")},
			{WaitFor: ptr("body[data-state=ready]")},
			{Screenshot: ptr("orders")},
			{ExpectText: []string{"#orders", "keyboard"}},
		},
		Viewport:  protocol.BrowserProbeViewport{Width: 1280, Height: 720},
		Clock:     ptr("2030-01-01T00:00:00.000Z"),
		TimeoutMs: 30_000,
	}
}

const secret = "claim-secret-value-1234"

func resultJSON(t *testing.T, value string) []byte {
	t.Helper()
	b, _ := json.Marshal(map[string]any{
		// The runner started 250 ms after the round's t0.
		"t0Epoch":      t0.Add(250 * time.Millisecond).UnixMilli(),
		"videoStartMs": 40,
		"steps": []map[string]any{
			{"index": 0, "kind": "goto", "ok": true, "startMs": 50, "endMs": 300},
			{"index": 1, "kind": "waitFor", "ok": true, "startMs": 300, "endMs": 400},
			{"index": 2, "kind": "screenshot", "ok": true, "startMs": 400, "endMs": 450, "screenshot": 0},
			{"index": 3, "kind": "expectText", "ok": false, "startMs": 450, "endMs": 5450, "value": value, "error": "mismatch", "screenshot": 1},
		},
		"console": []map[string]any{{"level": "error", "text": "token " + secret, "at": 420}},
	})
	return b
}

func resultWithNetwork(t *testing.T, value string, requireShot bool) []byte {
	t.Helper()
	var rr map[string]any
	_ = json.Unmarshal(resultJSON(t, value), &rr)
	rr["network"], rr["networkComplete"], rr["networkTruncated"] = []any{}, true, false
	if !requireShot {
		step := rr["steps"].([]any)[2].(map[string]any)
		step["ok"], step["error"] = false, "error"
	}
	b, _ := json.Marshal(rr)
	return b
}

func harJSON() []byte {
	b, _ := json.Marshal(map[string]any{"log": map[string]any{"entries": []map[string]any{
		{"startedDateTime": t0.Add(400 * time.Millisecond).Format(time.RFC3339Nano), "time": 12.4,
			"request":  map[string]any{"method": "GET", "url": "http://app.kody.internal:3000/orders/42?key=" + secret},
			"response": map[string]any{"status": 200}},
		{"startedDateTime": t0.Add(410 * time.Millisecond).Format(time.RFC3339Nano), "time": 1,
			"request":  map[string]any{"method": "GET", "url": "https://cdn.example.com/x.js"},
			"response": map[string]any{"status": 404}},
	}}})
	return b
}

func webm() []byte { return append([]byte{0x1A, 0x45, 0xDF, 0xA3}, make([]byte, 64)...) }

func newCapture(r Runner, baseline *http.Client) Capture {
	return Capture{Runner: r, Redactor: redact.New(redact.Known{Label: "claim", Value: secret}), Baseline: baseline}
}

func baselineServer(t *testing.T, body []byte) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/org/run/base/step/screenshot-0" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestCaptureReturnsStepsArtifactsAndThePixelDiffOfTheSameStep(t *testing.T) {
	base := pngOf(t, 100, 50, white)
	srv := baselineServer(t, base)
	prShot := solid(100, 50, white)
	for x := 0; x < 10; x++ {
		prShot.SetNRGBA(x, 0, color.NRGBA{0, 0, 0, 255})
	}
	var prPNG bytes.Buffer
	_ = png.Encode(&prPNG, prShot)
	r := &fakeRunner{stream: tarOf(t,
		entry{"result.json", resultJSON(t, "No orders yet")},
		entry{"screenshot-0.png", prPNG.Bytes()},
		entry{"screenshot-1.png", pngOf(t, 100, 50, white)},
		entry{"video.webm", webm()},
		entry{"har.json", harJSON()},
		entry{"trace.zip", zipOf(t, map[string]string{"trace.trace": `{"type":"before"}`, "resources/abc": "<html>hi</html>"})},
	)}
	out, err := newCapture(r, srv.Client()).Run(context.Background(), Request{
		Probe: ordersProbe(), Spec: RunSpec{ClaimID: "claim-1", Workload: "m-1", Service: "app", Port: 3000}, T0: t0,
		// The baseline took its screenshot at step 2, as this round did.
		Baseline: []protocol.BaselineScreenshot{{Step: 2, Screenshot: 0, URL: srv.URL + "/org/run/base/step/screenshot-0"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	// The runner got the closed list, the app's origin and the session bound.
	var job map[string]any
	_ = json.Unmarshal(r.job, &job)
	if job["origin"] != "http://app.kody.internal:3000" || job["timeoutMs"] != float64(30_000) || job["clock"] != "2030-01-01T00:00:00.000Z" {
		t.Fatalf("job %s", r.job)
	}
	if r.spec.Deadline != 30*time.Second+StartGrace || r.spec.Service != "app" {
		t.Fatalf("spec %+v", r.spec)
	}
	steps := out.Browser.Steps
	if len(steps) != 4 || !steps[0].Ok || steps[3].Ok || *steps[3].Error != protocol.BrowserStepErrorMismatch || *steps[3].Value != "No orders yet" {
		t.Fatalf("steps %+v", steps)
	}
	// On the round's clock: the runner's own ms plus when it started.
	if steps[0].StartMs != 300 || steps[3].EndMs != 5700 || *out.Browser.VideoStartMs != 290 {
		t.Fatalf("clock: %+v video %d", steps, *out.Browser.VideoStartMs)
	}
	if len(out.Browser.Pixels) != 1 || out.Browser.Pixels[0].Screenshot != 0 || out.Browser.Pixels[0].Changed != 10 || out.Browser.Pixels[0].Total != 5000 {
		t.Fatalf("pixels %+v", out.Browser.Pixels)
	}
	types := map[protocol.EvidenceUploadType]Artifact{}
	for _, a := range out.Artifacts {
		types[a.Type] = a
	}
	for _, want := range []protocol.EvidenceUploadType{"screenshot-0", "screenshot-1", "pixeldiff-0", "video", "har", "trace"} {
		if _, ok := types[want]; !ok {
			t.Fatalf("no %s in %v (dropped %v)", want, types, out.Dropped)
		}
	}
	// Text is redacted: the HAR, the console line, and the coverage route.
	if strings.Contains(string(types["har"].Body), secret) || types["har"].Redactions < 2 {
		t.Fatalf("har not redacted: %d", types["har"].Redactions)
	}
	if strings.Contains(out.Browser.Console[0].Text, secret) {
		t.Fatalf("console %q", out.Browser.Console[0].Text)
	}
	if len(out.Browser.Network) != 2 || *out.Browser.Network[0].At != 400 || *out.Browser.Network[0].Ms != 12 {
		t.Fatalf("network %+v", out.Browser.Network)
	}
	// Only the app's requests are the coverage log, by route.
	if len(out.Requests) != 1 || out.Requests[0].Route != "/orders/:id" || out.Requests[0].Status != 200 {
		t.Fatalf("requests %+v", out.Requests)
	}
	// The trace is re-packed stored, so its text reads as text.
	if !bytes.Contains(types["trace"].Body, []byte("<html>hi</html>")) {
		t.Fatal("trace not stored uncompressed")
	}
}

func TestCaptureDropsATraceWithASecretAndArtifactsOverTheirBound(t *testing.T) {
	big := append(webm(), make([]byte, MaxVideoBytes)...)
	r := &fakeRunner{stream: tarOf(t,
		entry{"result.json", resultWithNetwork(t, "keyboard", false)},
		entry{"video.webm", big},
		entry{"trace.zip", zipOf(t, map[string]string{"resources/x": "Authorization: " + secret})},
		entry{"notes.txt", []byte("not the runner's")},
		entry{"screenshot-0.png", []byte("not a png")},
	)}
	out, err := newCapture(r, nil).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0})
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range out.Artifacts {
		t.Fatalf("kept %s", a.Type)
	}
	joined := strings.Join(out.Dropped, "; ")
	for _, want := range []string{"video.webm: over", "trace: holds a value", "unexpected file", "screenshot-0: not a bounded PNG"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("dropped %q, want %q", joined, want)
		}
	}
	// A screenshot that was dropped is not named by its step.
	if out.Browser.Steps[2].Screenshot != nil {
		t.Fatal("step points at a dropped screenshot")
	}
}

func TestCaptureWithoutABaselineHasNoPixelDiff(t *testing.T) {
	r := &fakeRunner{stream: tarOf(t, entry{"result.json", resultWithNetwork(t, "keyboard", true)}, entry{"screenshot-0.png", pngOf(t, 10, 10, white)})}
	out, err := newCapture(r, nil).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0})
	if err != nil {
		t.Fatal(err)
	}
	if out.Browser.Pixels != nil {
		t.Fatalf("pixels %+v", out.Browser.Pixels)
	}
}

// A required baseline the store does not answer makes the capture inconclusive.
func TestCaptureRejectsWhenTheBaselineIsUnavailable(t *testing.T) {
	srv := baselineServer(t, nil)
	r := &fakeRunner{stream: tarOf(t, entry{"result.json", resultWithNetwork(t, "keyboard", true)}, entry{"screenshot-0.png", pngOf(t, 10, 10, white)})}
	_, err := newCapture(r, srv.Client()).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0,
		Baseline: []protocol.BaselineScreenshot{{Step: 2, Screenshot: 0, URL: srv.URL + "/elsewhere"}}})
	if err == nil {
		t.Fatal("a missing baseline silently omitted its required comparison")
	}
}

func TestCaptureRefusesWhatTheClosedListDoesNot(t *testing.T) {
	cases := map[string]func(p *protocol.BrowserProbe){
		"internal selector": func(p *protocol.BrowserProbe) { p.Steps[1] = protocol.BrowserStep{WaitFor: ptr("internal:text=\"x\"")} },
		"chained internal": func(p *protocol.BrowserProbe) {
			p.Steps[1] = protocol.BrowserStep{Click: ptr("#a >> internal:control=enter-frame")}
		},
		"two kinds":      func(p *protocol.BrowserProbe) { p.Steps[0].Click = ptr("#a") },
		"no kind":        func(p *protocol.BrowserProbe) { p.Steps[0] = protocol.BrowserStep{} },
		"side detection": func(p *protocol.BrowserProbe) { p.Steps[0] = protocol.BrowserStep{Goto: ptr("/.git/config")} },
		"env file":       func(p *protocol.BrowserProbe) { p.Steps[0] = protocol.BrowserStep{Goto: ptr("/.env.local?x=1")} },
		"other host":     func(p *protocol.BrowserProbe) { p.Steps[0] = protocol.BrowserStep{Goto: ptr("//evil.example/")} },
		"key":            func(p *protocol.BrowserProbe) { p.Steps[1] = protocol.BrowserStep{Press: ptr("Enter; rm")} },
		"role":           func(p *protocol.BrowserProbe) { p.Role = ptr("admin") },
		"timeout":        func(p *protocol.BrowserProbe) { p.TimeoutMs = 10 * 60_000 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			p := ordersProbe()
			mutate(&p)
			r := &fakeRunner{}
			_, err := newCapture(r, nil).Run(context.Background(), Request{Probe: p, Spec: RunSpec{Port: 3000}, T0: t0})
			var refused *observer.ProbeRefusedError
			if !errors.As(err, &refused) {
				t.Fatalf("err %v", err)
			}
			if r.job != nil {
				t.Fatal("a container started for a refused probe")
			}
		})
	}
}

func TestCaptureMapsTheRunnersRefusalAndFailures(t *testing.T) {
	_, err := newCapture(&fakeRunner{err: ErrJobRefused}, nil).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0})
	var refused *observer.ProbeRefusedError
	if !errors.As(err, &refused) {
		t.Fatalf("runner refusal: %v", err)
	}
	if _, err := newCapture(&fakeRunner{err: errors.New("no such image")}, nil).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0}); err == nil || errors.As(err, &refused) {
		t.Fatalf("runner failure: %v", err)
	}
	// A result that does not answer the probe's steps is not trusted.
	wrong, _ := json.Marshal(map[string]any{"t0Epoch": t0.UnixMilli(), "steps": []map[string]any{{"index": 0, "kind": "click", "ok": true}}})
	if _, err := newCapture(&fakeRunner{stream: tarOf(t, entry{"result.json", wrong})}, nil).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0}); err == nil {
		t.Fatal("a result of other steps was accepted")
	}
	relabelled := bytes.Replace(resultJSON(t, "x"), []byte(`"kind":"goto"`), []byte(`"kind":"click"`), 1)
	if _, err := newCapture(&fakeRunner{stream: tarOf(t, entry{"result.json", relabelled})}, nil).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0}); err == nil {
		t.Fatal("a step the runner relabelled was accepted")
	}
	if _, err := newCapture(&fakeRunner{stream: tarOf(t, entry{"video.webm", webm()})}, nil).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0}); err == nil {
		t.Fatal("no result.json was accepted")
	}
}

func TestSessionIsBoundedSoTheVideoIsToo(t *testing.T) {
	p := ordersProbe()
	p.TimeoutMs = 120_000
	if Session(p) != MaxSession {
		t.Fatalf("session %v", Session(p))
	}
	p.TimeoutMs = 200
	if Session(p) != MinSession {
		t.Fatalf("session %v", Session(p))
	}
}

// The result rides one step.result frame (1 MB): a page that logs and
// fetches without end still fits, and the HAR keeps every request.
func TestCaptureKeepsTheResultWithinAFrame(t *testing.T) {
	long := strings.Repeat("x", 3_000)
	var entries []map[string]any
	var console []map[string]any
	for i := 0; i < 200; i++ {
		entries = append(entries, map[string]any{"startedDateTime": t0.Format(time.RFC3339Nano), "time": 1,
			"request": map[string]any{"method": "GET", "url": "http://app.kody.internal:3000/" + long}, "response": map[string]any{"status": 200}})
		console = append(console, map[string]any{"level": "log", "text": long[:2_000], "at": 1})
	}
	har, _ := json.Marshal(map[string]any{"log": map[string]any{"entries": entries}})
	var rr map[string]any
	_ = json.Unmarshal(resultJSON(t, "keyboard"), &rr)
	rr["console"] = console
	result, _ := json.Marshal(rr)
	out, err := newCapture(&fakeRunner{stream: tarOf(t, entry{"result.json", result}, entry{"har.json", har}, entry{"screenshot-0.png", pngOf(t, 10, 10, white)})}, nil).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Browser.Network) != 200 || len(out.Browser.Console) != 200 || len(out.Requests) != 200 {
		t.Fatalf("network %d console %d requests %d", len(out.Browser.Network), len(out.Browser.Console), len(out.Requests))
	}
	frame, err := protocol.Encode(protocol.Header{ID: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", CellID: "cell-1", ClaimID: "claim-1"}, &protocol.StepResultBody{
		StepID: "0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d", Executor: protocol.ExecutorObserver, ImageID: "img", VMHealth: protocol.VMHealthOk,
		Probe: &protocol.ProbeResult{StepID: "0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d", Executor: "observer", ImageID: "img", Transport: protocol.ProbeResultTransportOk, Browser: out.Browser, Requests: out.Requests},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(frame) > protocol.MaxFrameBytes/2 {
		t.Fatalf("frame %d bytes", len(frame))
	}
	var harArtifact bool
	for _, a := range out.Artifacts {
		harArtifact = harArtifact || a.Type == protocol.EvidenceUploadTypeHar
	}
	if !harArtifact {
		t.Fatalf("the HAR was dropped: %v", out.Dropped)
	}
}
