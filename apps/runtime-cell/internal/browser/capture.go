package browser

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// Artifact is one file to upload with its grant.
type Artifact struct {
	Type        protocol.EvidenceUploadType
	ContentType protocol.EvidenceContentType
	Body        []byte
	Truncated   bool
	Redactions  int64
}

// Outcome is one round's browser result: the probe result's browser block,
// the page's requests to the app (the coverage log, S-32), the artifacts
// to upload, and what was left out and why (for the claim's log).
type Outcome struct {
	Browser   *protocol.BrowserResult
	Requests  []protocol.RequestLogEntry
	Artifacts []Artifact
	Dropped   []string
}

// Capture plays one browser probe round.
type Capture struct {
	Runner   Runner
	Redactor Redactor
	// Baseline reads the baseline screenshots (signed GETs to the evidence
	// store); nil: a client with a 15 s timeout. Redirects are never followed.
	Baseline *http.Client
	// Tolerance per channel for the pixel diff; 0: DefaultTolerance.
	Tolerance uint8
}

// Request is one round: the probe, where its app listens, the baseline
// round's screenshots (none on the baseline round itself) and the round's t0.
type Request struct {
	// Evidence defaults to full for older callers.
	Evidence *protocol.EvidenceLevel
	Probe    protocol.BrowserProbe
	Spec     RunSpec
	Baseline []protocol.BaselineScreenshot
	T0       time.Time
}

var screenshotName = regexp.MustCompile(`^screenshot-([0-9])\.png$`)

// files is what the runner's tar stream held, each to its bound.
type files struct {
	result      []byte
	screenshots map[int][]byte
	video       []byte
	trace       []byte
	har         []byte
	dropped     []string
}

// capped reads one entry: nil and false when it is over max (then drained).
func capped(r io.Reader, max int64) ([]byte, bool, error) {
	b, ok, err := limited(r, max)
	if err == nil && !ok {
		_, err = io.Copy(io.Discard, r)
	}
	return b, ok, err
}

// limited never drains beyond the bound: closing a ZIP entry must stop inflation.
func limited(r io.Reader, max int64) ([]byte, bool, error) {
	b, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(b)) > max {
		return nil, false, nil
	}
	return b, true, nil
}

// readFiles reads the stream; only regular files the runner writes are
// kept, each up to its bound. An entry over its bound is dropped, never cut
// (a cut PNG or zip is not one).
func readFiles(r io.Reader, lean bool) (*files, error) {
	tr := tar.NewReader(r)
	f := &files{screenshots: map[int][]byte{}}
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return f, nil
		}
		if err != nil {
			return nil, fmt.Errorf("browser: runner output: %w", err)
		}
		if h.Typeflag != tar.TypeReg {
			return nil, errors.New("browser: runner output contains a non-regular file")
		}
		if lean && (h.Name == "video.webm" || h.Name == "trace.zip" || h.Name == "har.json") {
			if _, err := io.Copy(io.Discard, tr); err != nil {
				return nil, err
			}
			continue
		}
		var limit int64
		var dst *[]byte
		n := -1
		switch {
		case h.Name == "result.json":
			limit, dst = maxResultBytes, &f.result
		case h.Name == "video.webm":
			limit, dst = MaxVideoBytes, &f.video
		case h.Name == "trace.zip":
			limit, dst = MaxTraceBytes, &f.trace
		case h.Name == "har.json":
			limit, dst = MaxHARBytes, &f.har
		case screenshotName.MatchString(h.Name):
			n, _ = strconv.Atoi(screenshotName.FindStringSubmatch(h.Name)[1])
			limit = MaxScreenshotBytes
		default:
			// Not one of the runner's files: never kept.
			if _, err := io.Copy(io.Discard, tr); err != nil {
				return nil, err
			}
			f.dropped = append(f.dropped, "unexpected file in the runner's output")
			continue
		}
		b, ok, err := capped(tr, limit)
		if err != nil {
			return nil, fmt.Errorf("browser: runner output: %w", err)
		}
		if !ok {
			f.dropped = append(f.dropped, fmt.Sprintf("%s: over %d bytes", h.Name, limit))
			continue
		}
		if n >= 0 {
			f.screenshots[n] = b
		} else {
			*dst = b
		}
	}
}

// runnerResult is result.json.
type runnerResult struct {
	T0Epoch      *int64 `json:"t0Epoch"`
	VideoStartMs int64  `json:"videoStartMs"`
	Steps        []struct {
		Index      *int64  `json:"index"`
		Kind       string  `json:"kind"`
		Ok         *bool   `json:"ok"`
		StartMs    *int64  `json:"startMs"`
		EndMs      *int64  `json:"endMs"`
		Value      *string `json:"value"`
		Error      *string `json:"error"`
		Screenshot *int64  `json:"screenshot"`
	} `json:"steps"`
	Console []struct {
		Level *string `json:"level"`
		Text  *string `json:"text"`
		At    *int64  `json:"at"`
	} `json:"console"`
	Network []struct {
		Method   string `json:"method"`
		URL      string `json:"url"`
		At       *int64 `json:"at"`
		Complete *bool  `json:"complete"`
		Status   *int64 `json:"status"`
		Ms       *int64 `json:"ms"`
	} `json:"network"`
	NetworkComplete  *bool `json:"networkComplete"`
	NetworkTruncated *bool `json:"networkTruncated"`
}

var stepErrors = map[string]protocol.BrowserStepError{}

func init() {
	for _, e := range []protocol.BrowserStepError{protocol.BrowserStepErrorTimeout, protocol.BrowserStepErrorNotFound, protocol.BrowserStepErrorMismatch,
		protocol.BrowserStepErrorNavigation, protocol.BrowserStepErrorRefused, protocol.BrowserStepErrorSkipped, protocol.BrowserStepErrorError} {
		stepErrors[string(e)] = e
	}
}

const maxSinceT0 = 3_600_000

func clampMs(ms int64) int64 { return min(max(ms, 0), maxSinceT0) }

// Run plays the probe and returns the round's outcome. A probe the closed
// list refuses is an *observer.ProbeRefusedError and no container starts.
func (c Capture) Run(ctx context.Context, req Request) (*Outcome, error) {
	mode := protocol.EvidenceLevelFull
	if req.Evidence != nil {
		mode = *req.Evidence
	}
	if mode != protocol.EvidenceLevelLean && mode != protocol.EvidenceLevelFull {
		return nil, refuse("invalid_probe", "unknown browser evidence mode")
	}
	if err := Check(req.Probe); err != nil {
		return nil, err
	}
	body, err := jobFor(req.Probe, req.Spec.Port, mode)
	if err != nil {
		return nil, err
	}
	spec := req.Spec
	spec.Deadline = Session(req.Probe) + StartGrace
	rctx, cancel := context.WithTimeout(ctx, spec.Deadline)
	defer cancel()
	pr, pw := io.Pipe()
	ran := make(chan error, 1)
	go func() {
		err := c.Runner.Run(rctx, spec, body, &limitWriter{w: pw, left: maxStreamBytes})
		pw.CloseWithError(err)
		ran <- err
	}()
	f, rerr := readFiles(pr, mode == protocol.EvidenceLevelLean)
	if rerr != nil {
		cancel()
	}
	// Unblock a runner still writing past the archive's end.
	_ = pr.CloseWithError(errors.New("browser: stream closed"))
	runErr := <-ran
	if errors.Is(runErr, ErrJobRefused) {
		return nil, refuse("invalid_probe", "the browser runner refused the steps")
	}
	if rerr != nil {
		return nil, rerr
	}
	if runErr != nil {
		return nil, fmt.Errorf("browser: runner: %w", runErr)
	}
	if f.result == nil {
		return nil, errors.New("browser: the runner wrote no result")
	}
	return c.outcome(ctx, req, f)
}

type limitWriter struct {
	w    io.Writer
	left int64
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > l.left {
		return 0, errors.New("browser: runner output past its bound")
	}
	l.left -= int64(len(p))
	return l.w.Write(p)
}

func (c Capture) red(s string, max int, n *int64) string {
	out, k := c.Redactor.String(s)
	*n += int64(k)
	out, _ = redact.Clip(out, max)
	return out
}

func (c Capture) outcome(ctx context.Context, req Request, f *files) (*Outcome, error) {
	var rr runnerResult
	if err := json.Unmarshal(f.result, &rr); err != nil {
		return nil, fmt.Errorf("browser: result: %w", err)
	}
	if len(rr.Steps) != len(req.Probe.Steps) {
		return nil, fmt.Errorf("browser: the runner answered %d steps for %d", len(rr.Steps), len(req.Probe.Steps))
	}
	if rr.T0Epoch == nil || *rr.T0Epoch <= 0 {
		return nil, errors.New("browser: missing runner clock")
	}
	if rr.Console == nil {
		return nil, errors.New("browser: no console measurement")
	}
	// The runner's clock against the round's: one clock for both sides' lanes.
	offset := max(*rr.T0Epoch-req.T0.UnixMilli(), 0)
	out := &Outcome{Browser: &protocol.BrowserResult{Network: []protocol.BrowserNetworkEntry{}, Console: []protocol.BrowserConsoleEntry{}}, Requests: []protocol.RequestLogEntry{}, Dropped: f.dropped}
	var textRedactions int64
	usedShots := map[int64]bool{}
	for i, s := range rr.Steps {
		// The kind is the probe's, never the runner's word for it.
		kind := kindOf(req.Probe.Steps[i])
		if s.Index == nil || *s.Index != int64(i) || string(kind) != s.Kind {
			return nil, fmt.Errorf("browser: step %d of the result is not the probe's", i)
		}
		if s.Ok == nil || s.StartMs == nil || s.EndMs == nil || *s.StartMs < 0 || *s.EndMs < *s.StartMs || *s.EndMs > maxSinceT0 {
			return nil, fmt.Errorf("browser: step %d has incomplete measurements", i)
		}
		if *s.Ok && s.Error != nil {
			return nil, fmt.Errorf("browser: step %d has conflicting outcome", i)
		}
		o := protocol.BrowserStepOutcome{Index: int64(i), Kind: kind, Ok: *s.Ok, StartMs: clampMs(*s.StartMs + offset), EndMs: clampMs(*s.EndMs + offset)}
		if s.Value != nil {
			v := c.red(*s.Value, maxValue, &textRedactions)
			o.Value = &v
		}
		if s.Error != nil {
			e, ok := stepErrors[*s.Error]
			if !ok {
				e = protocol.BrowserStepErrorError
			}
			o.Error = &e
		} else if !*s.Ok {
			e := protocol.BrowserStepErrorError
			o.Error = &e
		}
		if s.Screenshot != nil {
			if *s.Screenshot < 0 || *s.Screenshot >= MaxScreenshots || usedShots[*s.Screenshot] {
				return nil, fmt.Errorf("browser: step %d has invalid screenshot", i)
			}
			usedShots[*s.Screenshot] = true
			if _, ok := f.screenshots[int(*s.Screenshot)]; ok {
				n := *s.Screenshot
				o.Screenshot = &n
			}
		}
		if kind == protocol.BrowserStepKindScreenshot && *s.Ok && o.Screenshot == nil {
			return nil, fmt.Errorf("browser: step %d has no required screenshot", i)
		}
		out.Browser.Steps = append(out.Browser.Steps, o)
	}
	for _, l := range rr.Console {
		if len(out.Browser.Console) == maxEntries {
			break
		}
		if l.At == nil || *l.At < 0 || *l.At > maxSinceT0 || l.Level == nil || l.Text == nil {
			return nil, errors.New("browser: incomplete console measurement")
		}
		at := clampMs(*l.At + offset)
		level, _ := redact.Clip(*l.Level, 16)
		out.Browser.Console = append(out.Browser.Console, protocol.BrowserConsoleEntry{Level: level, Text: c.red(*l.Text, maxConsoleText, &textRedactions), At: &at})
	}
	lean := req.Evidence != nil && *req.Evidence == protocol.EvidenceLevelLean
	if rr.VideoStartMs >= 0 && f.video != nil && !lean {
		v := clampMs(rr.VideoStartMs + offset)
		out.Browser.VideoStartMs = &v
	}
	if f.video != nil && !lean {
		if len(f.video) < 4 || !bytes.Equal(f.video[:4], []byte{0x1A, 0x45, 0xDF, 0xA3}) {
			out.Dropped = append(out.Dropped, "video: not a WebM")
		} else {
			out.Artifacts = append(out.Artifacts, Artifact{Type: protocol.EvidenceUploadTypeVideo, ContentType: protocol.EvidenceContentTypeVideoWebm, Body: f.video})
		}
	}
	if rr.Network != nil {
		if rr.NetworkComplete == nil || !*rr.NetworkComplete || rr.NetworkTruncated == nil || *rr.NetworkTruncated || len(rr.Network) > maxEntries {
			return nil, errors.New("browser: incomplete network measurement")
		}
		for _, n := range rr.Network {
			if n.At == nil || n.Complete == nil || !*n.Complete || n.Status == nil || *n.Status < 100 || *n.Status > 599 || n.Ms == nil || *n.Ms < 0 || *n.At < 0 || *n.At > maxSinceT0 || *n.Ms > maxSinceT0 || !validNetworkMethod(n.Method) {
				return nil, errors.New("browser: invalid network measurement")
			}
			u, err := safeURL(n.URL)
			if err != nil {
				return nil, errors.New("browser: invalid network URL")
			}
			at, ms := clampMs(*n.At+offset), *n.Ms
			c.network(req, protocol.BrowserNetworkEntry{Method: n.Method, URL: u, Status: *n.Status, At: &at, Ms: &ms}, out)
		}
	} else if lean || f.har == nil || rr.NetworkComplete != nil || rr.NetworkTruncated != nil {
		return nil, errors.New("browser: no network measurement")
	}
	if f.har != nil && !lean {
		if err := c.har(req, f.har, out, rr.Network == nil); err != nil && rr.Network == nil {
			return nil, err
		}
	}
	if f.trace != nil && !lean {
		c.trace(f.trace, out)
	}
	if err := c.pixels(ctx, req, f.screenshots, out); err != nil {
		return nil, err
	}
	if textRedactions > 0 {
		// The step values and console lines travel in the result: their count goes with the HAR's, if any.
		for i := range out.Artifacts {
			if out.Artifacts[i].Type == protocol.EvidenceUploadTypeHar {
				out.Artifacts[i].Redactions += textRedactions
			}
		}
	}
	return out, nil
}

// har redacts the HAR's text with the claim's redactor, uploads it when it
// still fits, and takes the network list (and the page's requests to the
// app, for coverage) from it.
func (c Capture) har(req Request, raw []byte, out *Outcome, harvest bool) error {
	// Export metadata only: arbitrary minted credentials in headers, cookies,
	// query strings, posted data and response bodies need no known-value match.
	_, n := c.Redactor.String(string(raw))
	var doc struct {
		Log struct {
			Entries []struct {
				StartedDateTime string   `json:"startedDateTime"`
				Time            *float64 `json:"time"`
				Request         struct {
					Method string `json:"method"`
					URL    string `json:"url"`
				} `json:"request"`
				Response struct {
					Status *int64 `json:"status"`
				} `json:"response"`
			} `json:"entries"`
		} `json:"log"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil || doc.Log.Entries == nil || (harvest && len(doc.Log.Entries) > maxEntries) {
		out.Dropped = append(out.Dropped, "har: invalid measurement")
		return errors.New("browser: invalid HAR measurement")
	}
	for i := range doc.Log.Entries {
		e := &doc.Log.Entries[i]
		u, err := safeURL(e.Request.URL)
		atTime, timeErr := time.Parse(time.RFC3339Nano, e.StartedDateTime)
		if err != nil || !validNetworkMethod(e.Request.Method) || e.Response.Status == nil || *e.Response.Status < 100 || *e.Response.Status > 599 || e.Time == nil || *e.Time < 0 || *e.Time > maxSinceT0 || timeErr != nil {
			return errors.New("browser: invalid HAR entry")
		}
		e.Request.URL, _ = c.Redactor.String(u)
		entry := protocol.BrowserNetworkEntry{Method: e.Request.Method, URL: e.Request.URL, Status: *e.Response.Status}
		at, ms := clampMs(atTime.Sub(req.T0).Milliseconds()), clampMs(int64(*e.Time))
		entry.At, entry.Ms = &at, &ms
		if harvest {
			c.network(req, entry, out)
		}
	}
	text, err := json.Marshal(doc)
	if err != nil || len(text) > MaxHARBytes {
		out.Dropped = append(out.Dropped, "har: over its bound once redacted")
		return errors.New("browser: HAR over its bound")
	}
	out.Artifacts = append(out.Artifacts, Artifact{Type: protocol.EvidenceUploadTypeHar, ContentType: protocol.EvidenceContentTypeApplicationJSON, Body: text, Redactions: int64(n)})
	return nil
}

var networkMethod = regexp.MustCompile(`^[A-Z]{1,16}$`)

func validNetworkMethod(method string) bool { return networkMethod.MatchString(method) }

func safeURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", errors.New("browser: invalid URL")
	}
	u.User, u.RawQuery, u.Fragment, u.RawFragment = nil, "", "", ""
	return u.String(), nil
}

func (c Capture) network(req Request, entry protocol.BrowserNetworkEntry, out *Outcome) {
	if len(out.Browser.Network) == maxEntries {
		return
	}
	var n int64
	entry.URL = c.red(entry.URL, maxURL, &n)
	out.Browser.Network = append(out.Browser.Network, entry)
	if pu, err := url.Parse(entry.URL); err == nil && pu.Host == AppHost+":"+strconv.Itoa(req.Spec.Port) && len(out.Requests) < maxEntries {
		route := c.red(observer.Route(pu.Path), maxRoute, &n)
		out.Requests = append(out.Requests, protocol.RequestLogEntry{Method: entry.Method, Route: route, Status: entry.Status, At: entry.At})
	}
}

// trace re-packs the Playwright trace without compression, so the worker's
// canary check reads its text as it reads the HAR's (ADR-043), and drops it
// when the claim's redactor finds a secret in any text entry: a zip cannot
// be redacted in place.
func (c Capture) trace(raw []byte, out *Outcome) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		out.Dropped = append(out.Dropped, "trace: not a zip")
		return
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	var inflated int64
	for _, e := range zr.File {
		if e.FileInfo().IsDir() {
			continue
		}
		remaining := min(maxTraceInflated-inflated, int64(MaxTraceBytes-buf.Len()))
		if e.UncompressedSize64 > uint64(max(remaining, 0)) {
			out.Dropped = append(out.Dropped, "trace: entry exceeds its bound")
			return
		}
		rc, err := e.Open()
		if err != nil {
			out.Dropped = append(out.Dropped, "trace: unreadable entry")
			return
		}
		b, ok, err := limited(rc, remaining)
		rc.Close()
		if err != nil || !ok {
			out.Dropped = append(out.Dropped, "trace: over its bound uncompressed")
			return
		}
		inflated += int64(len(b))
		if utf8.Valid(b) {
			if _, n := c.Redactor.String(string(b)); n > 0 {
				out.Dropped = append(out.Dropped, "trace: holds a value the claim's redactor matches")
				return
			}
			if credentialStructure(b) {
				out.Dropped = append(out.Dropped, "trace: holds a credential-bearing structure")
				return
			}
		}
		if buf.Len()+len(b) > MaxTraceBytes {
			out.Dropped = append(out.Dropped, "trace: over its bound uncompressed")
			return
		}
		w, err := zw.CreateHeader(&zip.FileHeader{Name: e.Name, Method: zip.Store, Modified: e.Modified})
		if err != nil {
			out.Dropped = append(out.Dropped, "trace: re-pack failed")
			return
		}
		if _, err := w.Write(b); err != nil {
			out.Dropped = append(out.Dropped, "trace: re-pack failed")
			return
		}
	}
	if err := zw.Close(); err != nil {
		out.Dropped = append(out.Dropped, "trace: re-pack failed")
		return
	}
	if buf.Len() > MaxTraceBytes {
		out.Dropped = append(out.Dropped, "trace: over its bound uncompressed")
		return
	}
	out.Artifacts = append(out.Artifacts, Artifact{Type: protocol.EvidenceUploadTypeTrace, ContentType: protocol.EvidenceContentTypeApplicationZip, Body: buf.Bytes()})
}

// pixels diffs each screenshot this round took against the baseline's
// screenshot of the same step. A requested baseline that cannot be measured
// fails the capture; omitting the comparison must never clear that probe.
func (c Capture) pixels(ctx context.Context, req Request, shots map[int][]byte, out *Outcome) error {
	byStep := map[int64]protocol.BaselineScreenshot{}
	for _, b := range req.Baseline {
		byStep[b.Step] = b
	}
	tol := c.Tolerance
	if tol == 0 {
		tol = DefaultTolerance
	}
	for i := range out.Browser.Steps {
		s := &out.Browser.Steps[i]
		if s.Screenshot == nil {
			continue
		}
		// Decode only this screenshot and its baseline, never all ten at once.
		shot := *s.Screenshot
		img, err := decodePNG(shots[int(shot)], req.Probe.Viewport)
		if err != nil {
			if s.Ok && s.Kind == protocol.BrowserStepKindScreenshot {
				return fmt.Errorf("browser: required screenshot %d is invalid", shot)
			}
			out.Dropped = append(out.Dropped, fmt.Sprintf("screenshot-%d: not a bounded PNG", shot))
			s.Screenshot = nil
			continue
		}
		out.Artifacts = append(out.Artifacts, Artifact{Type: protocol.EvidenceUploadType("screenshot-" + strconv.FormatInt(shot, 10)), ContentType: protocol.EvidenceContentTypeImagePng, Body: shots[int(shot)]})
		base, ok := byStep[s.Index]
		if !ok {
			continue
		}
		baseline, err := c.fetchBaseline(ctx, base.URL, req.Probe.Viewport)
		if err != nil {
			return fmt.Errorf("browser: required baseline for screenshot %d is unavailable", *s.Screenshot)
		}
		d := Diff(baseline, img, tol)
		out.Browser.Pixels = append(out.Browser.Pixels, protocol.PixelDiff{Screenshot: *s.Screenshot, Ratio: d.Ratio(), Changed: d.Changed, Total: d.Total, SizeDiffers: d.SizeDiffers})
		if png := EncodePNG(d.Image, MaxScreenshotBytes); png != nil {
			out.Artifacts = append(out.Artifacts, Artifact{Type: protocol.EvidenceUploadType("pixeldiff-" + strconv.FormatInt(*s.Screenshot, 10)), ContentType: protocol.EvidenceContentTypeImagePng, Body: png})
		} else {
			out.Dropped = append(out.Dropped, fmt.Sprintf("pixeldiff-%d: over its bound", *s.Screenshot))
		}
	}
	return nil
}

// decodePNG validates allocation bounds using only the PNG header first.
func decodePNG(b []byte, viewport protocol.BrowserProbeViewport) (image.Image, error) {
	config, err := png.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return nil, errors.New("browser: not a PNG")
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width) > viewport.Width || int64(config.Height) > viewport.Height || int64(config.Width)*int64(config.Height) > MaxScreenshotPixels {
		return nil, errors.New("browser: PNG dimensions exceed viewport")
	}
	return png.Decode(bytes.NewReader(b))
}

func (c Capture) fetchBaseline(ctx context.Context, u string, viewport protocol.BrowserProbeViewport) (image.Image, error) {
	hc := c.Baseline
	if hc == nil {
		hc = &http.Client{Timeout: 15 * time.Second}
	}
	client := *hc
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	fctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(fctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, errors.New("browser: bad baseline url")
	}
	resp, err := client.Do(r)
	if err != nil {
		// The error names the URL, which carries a signature.
		return nil, errors.New("browser: baseline request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "image/png") {
		return nil, fmt.Errorf("browser: baseline answered %d", resp.StatusCode)
	}
	b, ok, err := capped(resp.Body, MaxScreenshotBytes)
	if err != nil || !ok {
		return nil, errors.New("browser: baseline over its bound")
	}
	return decodePNG(b, viewport)
}

var credentialText = regexp.MustCompile(`(?im)(?:^|["'\s{,])(?:authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)["']?\s*:`)

func credentialName(s string) bool {
	s = strings.ToLower(strings.NewReplacer("-", "", "_", "").Replace(s))
	return strings.Contains(s, "token") || strings.Contains(s, "cookie") || strings.Contains(s, "password") || strings.Contains(s, "secret") || strings.Contains(s, "authorization") || s == "apikey" || s == "auth" || s == "csrf"
}

// XML/HTML response payloads live in separate resources/<sha> trace entries,
// not in the network event's body. Inspect recognizable tags and attributes;
// arbitrary opaque page data still requires seed-only environments.
func xmlCredentials(b []byte) bool {
	if !bytes.Contains(b, []byte{'<'}) {
		return false
	}
	d := xml.NewDecoder(bytes.NewReader(b))
	d.Strict, d.AutoClose, d.Entity = false, xml.HTMLAutoClose, xml.HTMLEntity
	for tokens := 0; tokens < 100_000; tokens++ {
		token, err := d.Token()
		if err != nil {
			return false
		}
		if e, ok := token.(xml.StartElement); ok {
			if credentialName(e.Name.Local) {
				return true
			}
			for _, attr := range e.Attr {
				if credentialName(attr.Name.Local) || ((strings.EqualFold(attr.Name.Local, "name") || strings.EqualFold(attr.Name.Local, "type")) && credentialName(attr.Value)) {
					return true
				}
			}
		}
	}
	return true // Refuse optional trace data that exceeds this parser's work bound.
}

// Trace snapshots are not safely editable in place. Refuse recognized secret
// structures, including values minted by the app that no redactor knows yet.
func credentialStructure(b []byte) bool {
	var visit func(any, int) bool
	visit = func(value any, depth int) bool {
		if depth > 32 {
			return true
		}
		switch v := value.(type) {
		case map[string]any:
			for key, item := range v {
				// Bodies may be JSON, form data, multipart, XML or arbitrary bytes.
				// No format-specific scanner can safely preserve those carriers.
				if (strings.EqualFold(key, "postData") || strings.EqualFold(key, "body")) && credentialValue(item) {
					return true
				}
				if strings.EqualFold(key, "url") {
					if raw, ok := item.(string); ok {
						u, err := url.Parse(raw)
						if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
							return true
						}
					}
				}
				if credentialName(key) && credentialValue(item) {
					return true
				}
				if strings.EqualFold(key, "name") {
					if name, ok := item.(string); ok && credentialName(name) && credentialValue(v["value"]) {
						return true
					}
				}
				if visit(item, depth+1) {
					return true
				}
			}
		case []any:
			for _, item := range v {
				if visit(item, depth+1) {
					return true
				}
			}
		case string:
			var nested any
			if json.Unmarshal([]byte(v), &nested) == nil {
				return visit(nested, depth+1)
			}
			return credentialText.MatchString(v) || xmlCredentials([]byte(v))
		}
		return false
	}
	var doc any
	if json.Unmarshal(b, &doc) == nil {
		return visit(doc, 0)
	}
	if xmlCredentials(b) {
		return true
	}
	for _, line := range bytes.Split(b, []byte{'\n'}) {
		var doc any
		if json.Unmarshal(line, &doc) == nil {
			if visit(doc, 0) {
				return true
			}
			continue
		}
		if credentialText.Match(line) || xmlCredentials(line) {
			return true
		}
	}
	return false
}

// Chromium records empty cookie arrays and nullable metadata on ordinary GETs.
// Empty carriers contain no credential; nonempty carriers remain conservative.
func credentialValue(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case string:
		return v != ""
	case bool:
		return v
	case float64:
		return v != 0
	case []any:
		return len(v) > 0
	case map[string]any:
		return len(v) > 0
	default:
		return true
	}
}
