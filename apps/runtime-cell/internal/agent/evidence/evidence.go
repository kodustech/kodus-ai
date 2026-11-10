// Package evidence captures the evidence of a step (EVIDENCE-CAPTURE-DESIGN): what the app did while a
// probe ran, on the round's clock [t0, t1], and an exec's output as a cast.
// Everything comes from untrusted code: each text is redacted with the
// claim's redactor before it is uploaded or summarized, and each artifact
// is cut to the design's bound. The canary check runs in the worker, which
// alone knows the canaries (ADR-043): it reads every text artifact back
// before anyone can open it. A block the cell could not read is left out
// ("not captured"), never sent empty. Nothing here changes a probe result
// the gate reads.
package evidence

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/asciicast"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// Bounds of the design table.
const (
	evidenceLogBytes    = 256 << 10
	evidenceLogRead     = 5_000
	evidenceLogTail     = 50
	evidenceOutbound    = 200
	evidenceCastBytes   = 512 << 10
	evidenceDBBytes     = 64 << 10
	evidenceReadTimeout = 30 * time.Second
	uploadTimeout       = 30 * time.Second
	castWidth           = 120
	castHeight          = 40
)

// Collector captures a step's evidence. A nil ServiceLogs or Outbound is a
// cell that cannot read them: that block is left out.
type Collector struct {
	// ServiceLogs reads a claim's service logs in a probe round's window.
	ServiceLogs driver.ServiceLogReader
	// Outbound reads the claim's egress there.
	Outbound OutboundSource
	// HTTP uploads the artifacts; nil: a plain client, 30 s.
	HTTP  *http.Client
	Clock clock.Clock
	// Accepts reports whether this session's hub accepts an optional field.
	Accepts func(feature string) bool
}

// Claim is what the collector needs of the claim a step ran in.
type Claim struct {
	ID       string
	Log      *slog.Logger
	Workload driver.MachineRef
	// Redactor is the claim's: every text is redacted with it before it is
	// uploaded or summarized.
	Redactor *redact.Redactor
}

// OutboundCall is one connection a claim made through the egress, let through or refused.
type OutboundCall struct {
	Host    string
	Port    int
	At      time.Time
	Allowed bool
}

// OutboundSource is the egress's record of a claim's calls in a window.
type OutboundSource interface {
	Outbound(ctx context.Context, claimID string, since, until time.Time) ([]OutboundCall, error)
}

// Asked reports whether the step asked for capture c and the hub accepts its field.
func (e *Collector) Asked(ev *protocol.EvidenceRequest, c protocol.EvidenceCapture, feature string) bool {
	if ev == nil || !e.Accepts(feature) {
		return false
	}
	for _, x := range ev.Capture {
		if x == c {
			return true
		}
	}
	return false
}

func grantOf(ev *protocol.EvidenceRequest, t protocol.EvidenceUploadType) *protocol.UploadGrant {
	if ev == nil {
		return nil
	}
	for i := range ev.Uploads {
		if ev.Uploads[i].Type == t {
			return &ev.Uploads[i]
		}
	}
	return nil
}

func sinceT0(at, t0 time.Time, window int64) int64 {
	return min(max(at.Sub(t0).Milliseconds(), 0), window)
}

// AttachProbe replaces the observer's evidence with the round's,
// as far as this cell captured it and the hub accepts it.
func (e *Collector) AttachProbe(ctx context.Context, c Claim, b *protocol.ProbeRunBody, p *protocol.ProbeResult, t0, t1 time.Time) {
	if !e.Accepts(protocol.FeatureTimedRequests) {
		for i := range p.Requests {
			p.Requests[i].At = nil
		}
	}
	var observerDB *protocol.DBEffects
	if p.Evidence != nil {
		observerDB = p.Evidence.Db
	}
	p.Evidence = nil
	window := max(t1.Sub(t0).Milliseconds(), 0)
	ev := &protocol.ProbeEvidence{T0: protocol.FormatTime(t0), WindowMs: window}
	r := c.Redactor
	if e.Asked(b.Evidence, protocol.EvidenceCaptureLogs, protocol.FeatureServiceLogs) && e.ServiceLogs != nil {
		ev.Logs = e.serviceLogs(ctx, c, b.Evidence, ev, r, t0, t1, window)
	}
	if e.Asked(b.Evidence, protocol.EvidenceCaptureDb, protocol.FeatureDBEffects) && observerDB != nil {
		ev.Db = e.dbEffects(ctx, c, b.Evidence, ev, r, observerDB)
	}
	if e.Asked(b.Evidence, protocol.EvidenceCaptureOutbound, protocol.FeatureOutboundCalls) && e.Outbound != nil {
		ev.Outbound = e.outbound(ctx, c, r, t0, t1, window)
	}
	if ev.Logs != nil || ev.Db != nil || ev.Outbound != nil || len(ev.Refs) > 0 {
		p.Evidence = ev
	}
}

// serviceLogs is the services' lines in [t0, t1]: the redacted text up to
// 256 KB (newest kept) as the logs artifact, and its last 50 lines inline.
func (e *Collector) serviceLogs(ctx context.Context, c Claim, req *protocol.EvidenceRequest, ev *protocol.ProbeEvidence, r *redact.Redactor, t0, t1 time.Time, window int64) *protocol.ServiceLogsEvidence {
	rctx, cancel := context.WithTimeout(ctx, evidenceReadTimeout)
	lines, err := e.ServiceLogs.ServiceLogs(rctx, c.ID, c.Workload, t0, t1, evidenceLogRead)
	cancel()
	if err != nil {
		c.Log.Warn("evidence.logs.unavailable", "err", err)
		return nil
	}
	out := &protocol.ServiceLogsEvidence{Tail: []protocol.ServiceLogLine{}}
	var redactions int64
	type line struct {
		at            int64
		service, text string
		raw           string
	}
	kept := make([]line, 0, len(lines))
	for _, l := range lines {
		if l.At.Before(t0) || l.At.After(t1) {
			continue
		}
		text, n1 := r.String(l.Text)
		service, n2 := r.String(l.Service)
		redactions += int64(n1 + n2)
		service, _ = redact.Clip(service, 128)
		if service == "" {
			service = "unknown"
		}
		kept = append(kept, line{at: sinceT0(l.At, t0, window), service: service, text: text, raw: protocol.FormatTime(l.At) + " " + service + " | " + text + "\n"})
	}
	out.Lines = int64(len(kept))
	out.Truncated = len(lines) >= evidenceLogRead
	// The artifact keeps the newest lines that fit.
	size, from := 0, len(kept)
	for from > 0 && size+len(kept[from-1].raw) <= evidenceLogBytes {
		from--
		size += len(kept[from].raw)
	}
	if from > 0 {
		out.Truncated = true
	}
	var body strings.Builder
	for _, l := range kept[from:] {
		body.WriteString(l.raw)
	}
	for _, l := range kept[max(len(kept)-evidenceLogTail, 0):] {
		text, _ := redact.Clip(l.text, redact.MaxLogTailText)
		out.Tail = append(out.Tail, protocol.ServiceLogLine{At: l.at, Service: l.service, Text: text})
	}
	if ref := e.Upload(ctx, c, req, protocol.EvidenceUploadTypeLogs, protocol.EvidenceContentTypeTextPlain, []byte(body.String()), out.Truncated, redactions); ref != nil {
		ev.Refs = append(ev.Refs, *ref)
	}
	return out
}

// dbEffects uploads the observer's rows, redacted, as the db artifact and
// keeps only the per-table counts in the result.
func (e *Collector) dbEffects(ctx context.Context, c Claim, req *protocol.EvidenceRequest, ev *protocol.ProbeEvidence, r *redact.Redactor, fx *protocol.DBEffects) *protocol.DBEffects {
	var redactions int64
	red := func(s string, max int) string {
		out, n := r.String(s)
		redactions += int64(n)
		out, _ = redact.Clip(out, max)
		return out
	}
	fx.Service = red(fx.Service, 128)
	if fx.Service == "" {
		fx.Service = "db"
	}
	for i := range fx.Tables {
		fx.Tables[i].Table = red(fx.Tables[i].Table, 256)
		if fx.Tables[i].Table == "" {
			fx.Tables[i].Table = "unknown"
		}
	}
	for si := range fx.Sample {
		s := &fx.Sample[si]
		s.Table = red(s.Table, 256)
		for i := range s.Columns {
			s.Columns[i] = red(s.Columns[i], 256)
		}
		for _, row := range s.Rows {
			for i, cell := range row {
				row[i] = redactCell(r, cell, &redactions)
			}
		}
	}
	artifact := struct {
		Engine string                   `json:"engine"`
		Tables []protocol.DBTableEffect `json:"tables"`
		Sample []protocol.DBSample      `json:"sample"`
	}{string(fx.Engine), fx.Tables, fx.Sample}
	if artifact.Sample == nil {
		artifact.Sample = []protocol.DBSample{}
	}
	body, _ := json.Marshal(artifact)
	// Redaction can grow a row past the bound the observer kept: drop rows from the end until it fits.
	for len(body) > evidenceDBBytes && len(artifact.Sample) > 0 {
		last := &artifact.Sample[len(artifact.Sample)-1]
		if len(last.Rows) > 0 {
			last.Rows = last.Rows[:len(last.Rows)-1]
		} else {
			artifact.Sample = artifact.Sample[:len(artifact.Sample)-1]
		}
		fx.Truncated = true
		body, _ = json.Marshal(artifact)
	}
	if ref := e.Upload(ctx, c, req, protocol.EvidenceUploadTypeDb, protocol.EvidenceContentTypeApplicationJSON, body, fx.Truncated, redactions); ref != nil {
		ev.Refs = append(ev.Refs, *ref)
	}
	// The rows travel only in the artifact: never in a frame to the hub.
	fx.Sample = nil
	if len(fx.Tables) > 20 {
		fx.Tables, fx.Truncated = fx.Tables[:20], true
	}
	return fx
}

// redactCell redacts one row value: a string as text, anything else over its JSON.
func redactCell(r *redact.Redactor, cell json.RawMessage, n *int64) json.RawMessage {
	var s string
	if json.Unmarshal(cell, &s) == nil {
		red, c := r.String(s)
		*n += int64(c)
		if c == 0 {
			return cell
		}
		b, _ := json.Marshal(red)
		return b
	}
	red, c := r.String(string(cell))
	*n += int64(c)
	if c == 0 {
		return cell
	}
	b, _ := json.Marshal(red)
	return b
}

// outbound is the claim's egress in [t0, t1], let through or refused, at most 200.
func (e *Collector) outbound(ctx context.Context, c Claim, r *redact.Redactor, t0, t1 time.Time, window int64) *protocol.OutboundEvidence {
	rctx, cancel := context.WithTimeout(ctx, evidenceReadTimeout)
	calls, err := e.Outbound.Outbound(rctx, c.ID, t0, t1)
	cancel()
	if err != nil {
		// A partial answer would read as "these were all": not captured instead.
		c.Log.Warn("evidence.outbound.unavailable", "err", err)
		return nil
	}
	out := &protocol.OutboundEvidence{Calls: []protocol.OutboundCall{}}
	for _, call := range calls {
		if call.Port < 1 || call.Port > 65535 || call.Host == "" {
			continue
		}
		if len(out.Calls) == evidenceOutbound {
			out.Truncated = true
			break
		}
		host, _ := r.String(call.Host)
		host, _ = redact.Clip(host, 253)
		out.Calls = append(out.Calls, protocol.OutboundCall{At: sinceT0(call.At, t0, window), Host: host, Port: int64(call.Port), Allowed: call.Allowed})
	}
	return out
}

// ExecCast is the exec's output as an asciicast v2 artifact, redacted and
// at most 512 KB. kody-exec hands the output whole at the end, so each
// stream is one event at the command's end, then a marker with the exit.
func (e *Collector) ExecCast(ctx context.Context, c Claim, b *protocol.ExecBody, start time.Time, out kodyexec.Result) []protocol.EvidenceRef {
	if !e.Asked(b.Evidence, protocol.EvidenceCaptureCast, protocol.FeatureExecCast) || grantOf(b.Evidence, protocol.EvidenceUploadTypeCast) == nil {
		return nil
	}
	r := c.Redactor
	stdout, n1 := r.String(out.Stdout)
	stderr, n2 := r.String(out.Stderr)
	end := time.Duration(max(out.DurationMs, 0)) * time.Millisecond
	cast := asciicast.New(castWidth, castHeight, start, evidenceCastBytes)
	cast.Add(end, asciicast.Output, strings.ReplaceAll(stdout, "\n", "\r\n"))
	cast.Add(end, asciicast.Output, strings.ReplaceAll(stderr, "\n", "\r\n"))
	cast.Add(end, asciicast.Marker, fmt.Sprintf("exit %d", out.ExitCode))
	ref := e.Upload(ctx, c, b.Evidence, protocol.EvidenceUploadTypeCast, protocol.EvidenceContentTypeTextPlain, cast.Bytes(), cast.Truncated() || out.Truncated, int64(n1+n2))
	if ref == nil {
		return nil
	}
	return []protocol.EvidenceRef{*ref}
}

// errUpload is an upload that did not land; the step goes on without the ref.
var errUpload = errors.New("evidence: upload")

// Upload PUTs one artifact with its grant: the type's content type only,
// within the grant's bytes, before it expires, with no redirect followed.
// The grant's URL carries its signature and is never logged.
func (e *Collector) Upload(ctx context.Context, c Claim, req *protocol.EvidenceRequest, t protocol.EvidenceUploadType, ct protocol.EvidenceContentType, body []byte, truncated bool, redactions int64) *protocol.EvidenceRef {
	g := grantOf(req, t)
	if g == nil {
		return nil
	}
	err := e.put(ctx, g, ct, body)
	if err != nil {
		c.Log.Warn("evidence.upload.failed", "type", t, "bytes", len(body), "err", err)
		return nil
	}
	sum := sha256.Sum256(body)
	c.Log.Info("evidence.upload", "type", t, "bytes", len(body), "truncated", truncated)
	return &protocol.EvidenceRef{Type: t, Bytes: int64(len(body)), Sha256: hex.EncodeToString(sum[:]), Truncated: truncated, Redactions: redactions}
}

func (e *Collector) put(ctx context.Context, g *protocol.UploadGrant, ct protocol.EvidenceContentType, body []byte) error {
	if g.ContentType != ct {
		return fmt.Errorf("%w: grant is for %s, artifact is %s", errUpload, g.ContentType, ct)
	}
	if int64(len(body)) > g.MaxBytes {
		return fmt.Errorf("%w: %d bytes over the grant's %d", errUpload, len(body), g.MaxBytes)
	}
	if exp, err := protocol.ParseTime(g.ExpiresAt); err != nil || !e.Clock.Now().Before(exp) {
		return fmt.Errorf("%w: grant expired", errUpload)
	}
	uctx, cancel := context.WithTimeout(ctx, uploadTimeout)
	defer cancel()
	hreq, err := http.NewRequestWithContext(uctx, http.MethodPut, g.URL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("%w: bad grant url", errUpload)
	}
	hreq.Header.Set("Content-Type", string(ct))
	hreq.ContentLength = int64(len(body))
	client := e.HTTP
	if client == nil {
		client = &http.Client{Timeout: uploadTimeout}
	}
	nc := *client
	nc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := nc.Do(hreq)
	if err != nil {
		// The error names the URL, which carries the grant's signature.
		return fmt.Errorf("%w: request failed", errUpload)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("%w: store answered %d", errUpload, resp.StatusCode)
	}
	return nil
}
