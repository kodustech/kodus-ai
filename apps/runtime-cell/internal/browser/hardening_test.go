package browser

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Compressed byte limits used to admit dimensions larger than the viewport.
func TestCaptureRejectsOversizedScreenshotDimensions(t *testing.T) {
	r := &fakeRunner{stream: tarOf(t, entry{"result.json", resultWithNetwork(t, "x", true)}, entry{"screenshot-0.png", pngOf(t, 1281, 1, white)})}
	if _, err := newCapture(r, nil).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0}); err == nil {
		t.Fatal("an oversized required screenshot was accepted")
	}
}

// Missing measurements used to become Go zero values and passing steps.
func TestCaptureRejectsMissingRequiredMeasurements(t *testing.T) {
	for _, field := range []string{"ok", "startMs", "endMs", "screenshot"} {
		t.Run(field, func(t *testing.T) {
			var result map[string]any
			_ = json.Unmarshal(resultJSON(t, "x"), &result)
			delete(result["steps"].([]any)[2].(map[string]any), field)
			raw, _ := json.Marshal(result)
			r := &fakeRunner{stream: tarOf(t, entry{"result.json", raw}, entry{"screenshot-0.png", pngOf(t, 10, 10, white)})}
			if _, err := newCapture(r, nil).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0}); err == nil {
				t.Fatal("missing measurement accepted")
			}
		})
	}
}

func TestCaptureRejectsMissingConsoleOrStepIdentity(t *testing.T) {
	for _, field := range []string{"console", "index", "level", "text", "at"} {
		t.Run(field, func(t *testing.T) {
			var rr map[string]any
			_ = json.Unmarshal(resultWithNetwork(t, "x", true), &rr)
			switch field {
			case "console":
				delete(rr, field)
			case "index":
				delete(rr["steps"].([]any)[0].(map[string]any), field)
			default:
				delete(rr["console"].([]any)[0].(map[string]any), field)
			}
			raw, _ := json.Marshal(rr)
			r := &fakeRunner{stream: tarOf(t, entry{"result.json", raw}, entry{"screenshot-0.png", pngOf(t, 10, 10, white)})}
			if _, err := newCapture(r, nil).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0}); err == nil {
				t.Fatal("missing console/step measurement fabricated an empty result")
			}
		})
	}
}

func TestCaptureBaselineDimensionsAreBoundedBeforeDiff(t *testing.T) {
	srv := baselineServer(t, pngOf(t, 1281, 1, white))
	r := &fakeRunner{stream: tarOf(t, entry{"result.json", resultWithNetwork(t, "x", true)}, entry{"screenshot-0.png", pngOf(t, 10, 10, white)})}
	_, err := newCapture(r, srv.Client()).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0,
		Baseline: []protocol.BaselineScreenshot{{Step: 2, Screenshot: 0, URL: srv.URL + "/org/run/base/step/screenshot-0"}}})
	if err == nil {
		t.Fatal("oversized baseline silently omitted a required pixel comparison")
	}
}

func TestTraceRejectsDeclaredInflationBeforeOpening(t *testing.T) {
	out := &Outcome{}
	newCapture(nil, nil).trace(zipOf(t, map[string]string{"trace.trace": strings.Repeat("x", MaxTraceBytes+1)}), out)
	if len(out.Artifacts) != 0 || !strings.Contains(strings.Join(out.Dropped, ";"), "entry exceeds its bound") {
		t.Fatalf("oversized entry was not rejected before decompression: %v", out.Dropped)
	}
}

func TestHAROmitsUnknownCredentialsAndBodies(t *testing.T) {
	unknown := "opaque-new-session-value-92731"
	raw := []byte(`{"log":{"entries":[{"startedDateTime":"2026-11-07T12:00:00Z","time":4,"request":{"method":"GET","url":"http://user:` + unknown + `@app.kody.internal:3000/orders?session=` + unknown + `#` + unknown + `","headers":[{"name":"Authorization","value":"Bearer ` + unknown + `"},{"name":"Cookie","value":"sid=` + unknown + `"}],"cookies":[{"name":"sid","value":"` + unknown + `"}],"postData":{"text":"` + unknown + `"}},"response":{"status":200,"headers":[{"name":"Set-Cookie","value":"sid=` + unknown + `"}],"content":{"text":"` + unknown + `"}}}]}}`)
	out := &Outcome{Browser: &protocol.BrowserResult{}}
	_ = newCapture(nil, nil).har(Request{Spec: RunSpec{Port: 3000}, T0: t0}, raw, out, true)
	if len(out.Artifacts) != 1 {
		t.Fatalf("HAR unavailable: %v", out.Dropped)
	}
	for _, a := range out.Artifacts {
		if bytes.Contains(a.Body, []byte(unknown)) {
			t.Fatal("unknown credential escaped HAR sanitization")
		}
	}
	for _, n := range out.Browser.Network {
		if strings.Contains(n.URL, unknown) {
			t.Fatal("unknown credential escaped network summary")
		}
	}
}

func TestTraceDropsUnknownCredentialStructures(t *testing.T) {
	for _, body := range []string{`{"type":"resource-snapshot","snapshot":{"request":{"headers":[{"name":"Authorization","value":"Bearer opaque-fresh-value"}]}}}`, `{"type":"resource-snapshot","snapshot":{"response":{"headers":[{"name":"Set-Cookie","value":"sid=opaque-fresh-value"}]}}}`, "Cookie: sid=opaque-fresh-value", `{"type":"resource-snapshot","snapshot":{"request":{"postData":"{\"password\":\"opaque-fresh-value\"}"}}}`} {
		out := &Outcome{}
		newCapture(nil, nil).trace(zipOf(t, map[string]string{"trace.network": body}), out)
		if len(out.Artifacts) != 0 {
			t.Fatal("trace retained an unknown credential structure")
		}
	}
}

// Real Chromium resource-snapshot NDJSON includes empty cookies on every GET.
func TestTraceKeepsEmptyGETCookieMetadataButDropsNonemptyCookies(t *testing.T) {
	const get = `{"type":"resource-snapshot","snapshot":{"request":{"method":"GET","url":"http://app.kody.internal:3000/orders","httpVersion":"HTTP/1.1","cookies":[],"headers":[{"name":"Accept","value":"*/*"}],"queryString":[],"headersSize":-1,"bodySize":0},"response":{"status":200,"statusText":"OK","httpVersion":"HTTP/1.1","cookies":[],"headers":[{"name":"Content-Type","value":"application/json"}],"content":{"mimeType":"application/json","_sha1":"orders.json"},"headersSize":-1,"bodySize":12,"redirectURL":"","_transferSize":120}}}`
	for _, test := range []struct {
		name, body string
		keep       bool
	}{
		{"empty GET cookies", get + "\n" + get, true},
		{"empty named credentials", `{"authorization":"","password":null,"isPassword":false,"postData":null,"body":"","cookies":[]}`, true},
		{"request cookie", strings.Replace(get, `"cookies":[]`, `"cookies":[{"name":"session","value":"opaque-new-value"}]`, 1), false},
		{"response cookie", strings.ReplaceAll(get, `"cookies":[]`, `"cookies":[{"name":"session","value":"opaque-new-value"}]`), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			out := &Outcome{}
			newCapture(nil, nil).trace(zipOf(t, map[string]string{"trace.network": test.body, "resources/orders.json": `{"orders":[]}`}), out)
			if (len(out.Artifacts) == 1) != test.keep {
				t.Fatalf("keep=%v dropped=%v", test.keep, out.Dropped)
			}
		})
	}
}

func TestTraceDropsBodyAndURLCredentialCarriersRegardlessOfEncoding(t *testing.T) {
	for _, body := range []string{
		`{"postData":{"mimeType":"application/x-www-form-urlencoded","text":"password=opaque-new-value&csrf=x"}}`,
		`{"postData":{"mimeType":"multipart/form-data","text":"name=\"password\"\r\nopaque-new-value"}}`,
		`{"response":{"body":"<password>opaque-new-value</password>"}}`,
		`{"request":{"url":"http://app.kody.internal:3000/?arbitrary_session=opaque-new-value"}}`,
	} {
		out := &Outcome{}
		newCapture(nil, nil).trace(zipOf(t, map[string]string{"trace.network": body}), out)
		if len(out.Artifacts) != 0 {
			t.Fatal("trace retained a body or URL credential carrier")
		}
	}
}

func TestTraceRecognizesXMLCredentialsInActualResponseResources(t *testing.T) {
	for _, resource := range []string{
		`<login><password>opaque-minted-value</password></login>`,
		`<login xmlns:s="urn:session"><s:token>opaque-minted-value</s:token></login>`,
		`<login authorization="opaque-minted-value"/>`,
		`<input name="password" value="opaque-minted-value"/>`,
		`<INPUT NAME="password" VALUE="opaque-minted-value"/>`,
	} {
		out := &Outcome{}
		newCapture(nil, nil).trace(zipOf(t, map[string]string{
			"trace.network":          `{"type":"resource-snapshot","snapshot":{"request":{"method":"GET","url":"http://app.kody.internal:3000/orders"},"response":{"content":{"mimeType":"application/xml","_sha1":"response.xml"}}}}`,
			"resources/response.xml": resource,
		}), out)
		if len(out.Artifacts) != 0 {
			t.Fatal("credential-bearing XML response resource was exported")
		}
	}
	out := &Outcome{}
	newCapture(nil, nil).trace(zipOf(t, map[string]string{"trace.network": `{"response":{"content":{"mimeType":"application/xml","_sha1":"response.xml"}}}`, "resources/response.xml": `<orders><order id="42">keyboard</order></orders>`}), out)
	if len(out.Artifacts) != 1 {
		t.Fatalf("ordinary GET response resource was discarded: %v", out.Dropped)
	}
}

func TestDecodeRejectsHugeHeaderBeforeReadingImageData(t *testing.T) {
	b := pngOf(t, 1, 1, white)
	binary.BigEndian.PutUint32(b[16:20], 1<<20)
	binary.BigEndian.PutUint32(b[20:24], 1<<20)
	binary.BigEndian.PutUint32(b[29:33], crc32.ChecksumIEEE(b[12:29]))
	_, err := decodePNG(b, ordersProbe().Viewport)
	if err == nil || !strings.Contains(err.Error(), "dimensions") {
		t.Fatalf("huge dimensions not refused before decode: %v", err)
	}
}

func TestLegacyFullHARRequiresActualMeasurements(t *testing.T) {
	for _, field := range []string{"status", "time", "startedDateTime", "zero_status"} {
		t.Run(field, func(t *testing.T) {
			var doc map[string]any
			_ = json.Unmarshal(harJSON(), &doc)
			row := doc["log"].(map[string]any)["entries"].([]any)[0].(map[string]any)
			switch field {
			case "status":
				delete(row["response"].(map[string]any), "status")
			case "zero_status":
				row["response"].(map[string]any)["status"] = 0
			default:
				delete(row, field)
			}
			raw, _ := json.Marshal(doc)
			r := &fakeRunner{stream: tarOf(t, entry{"result.json", resultJSON(t, "x")}, entry{"har.json", raw}, entry{"screenshot-0.png", pngOf(t, 10, 10, white)})}
			if _, err := newCapture(r, nil).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0}); err == nil {
				t.Fatal("legacy HAR invented a missing/failed measurement")
			}
		})
	}
}

func TestLegacyFullHARAndLeanHaveTheSameMeasuredCoverage(t *testing.T) {
	var doc map[string]any
	_ = json.Unmarshal(harJSON(), &doc)
	rows := doc["log"].(map[string]any)["entries"].([]any)
	doc["log"].(map[string]any)["entries"] = rows[:1]
	har, _ := json.Marshal(doc)
	r := &fakeRunner{stream: tarOf(t, entry{"result.json", resultJSON(t, "x")}, entry{"har.json", har}, entry{"screenshot-0.png", pngOf(t, 10, 10, white)})}
	out, err := newCapture(r, nil).Run(context.Background(), Request{Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Requests) != 1 || out.Requests[0].Route != "/orders/:id" || out.Requests[0].Status != 200 {
		t.Fatalf("coverage %+v", out.Requests)
	}
	if !bytes.Contains(r.job, []byte(`"evidence":"full"`)) {
		t.Fatal("omitted evidence no longer defaults full")
	}
}

func TestLeanCaptureKeepsMeasuredNetworkWithoutHeavyArtifacts(t *testing.T) {
	var result map[string]any
	_ = json.Unmarshal(resultJSON(t, "x"), &result)
	result["network"] = []map[string]any{{"method": "GET", "url": "http://app.kody.internal:3000/orders/42?session=unknown-value", "at": 12, "complete": true, "status": 200, "ms": 4}}
	result["networkComplete"], result["networkTruncated"] = true, false
	raw, _ := json.Marshal(result)
	r := &fakeRunner{stream: tarOf(t, entry{"result.json", raw}, entry{"screenshot-0.png", pngOf(t, 10, 10, white)}, entry{"har.json", harJSON()}, entry{"video.webm", webm()}, entry{"trace.zip", zipOf(t, map[string]string{"trace.trace": "{}"})})}
	out, err := newCapture(r, nil).Run(context.Background(), Request{Evidence: ptr(protocol.EvidenceLevelLean), Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(r.job, []byte(`"evidence":"lean"`)) {
		t.Fatal("lean mode not sent to runner")
	}
	if len(out.Requests) != 1 || out.Requests[0].Route != "/orders/:id" || out.Requests[0].Status != 200 {
		t.Fatalf("requests %+v", out.Requests)
	}
	if strings.Contains(out.Browser.Network[0].URL, "unknown-value") {
		t.Fatal("network query secret retained")
	}
	for _, a := range out.Artifacts {
		if a.Type == "har" || a.Type == "trace" || a.Type == "video" {
			t.Fatalf("lean retained %s", a.Type)
		}
	}
}

func TestCaptureRefusesUnknownModeBeforeRunner(t *testing.T) {
	r := &fakeRunner{}
	_, err := newCapture(r, nil).Run(context.Background(), Request{Evidence: ptr(protocol.EvidenceLevel("invalid")), Probe: ordersProbe()})
	if err == nil || r.job != nil {
		t.Fatal("unknown evidence mode reached runner")
	}
}

func TestCaptureRejectsIncompleteNetworkMeasurements(t *testing.T) {
	for _, field := range []string{"network", "networkComplete", "networkTruncated", "method", "url", "at", "complete", "status", "ms"} {
		t.Run(field, func(t *testing.T) {
			var result map[string]any
			_ = json.Unmarshal(resultJSON(t, "x"), &result)
			net := map[string]any{"method": "GET", "url": "http://app.kody.internal:3000/orders", "at": 1, "complete": true, "status": 200, "ms": 2}
			result["network"], result["networkComplete"], result["networkTruncated"] = []map[string]any{net}, true, false
			if strings.HasPrefix(field, "network") {
				delete(result, field)
			} else {
				delete(net, field)
			}
			raw, _ := json.Marshal(result)
			r := &fakeRunner{stream: tarOf(t, entry{"result.json", raw}, entry{"screenshot-0.png", pngOf(t, 10, 10, white)})}
			_, err := newCapture(r, nil).Run(context.Background(), Request{Evidence: ptr(protocol.EvidenceLevelLean), Probe: ordersProbe(), Spec: RunSpec{Port: 3000}, T0: t0})
			if err == nil {
				t.Fatal("missing required network measurement accepted")
			}
		})
	}
}
