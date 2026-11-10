package browser

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// ExploreGrace bounds startup/cleanup past the 30s action budget. The hub
// waits request timeout +20s; this runner ends at request timeout +10s.
const ExploreGrace = 10 * time.Second
const maxExplorationJSON = 256 << 10
const maxExplorationStream = 512 << 10

// Explorer reuses the isolated one-job Runner but returns no ProbeResult,
// coverage or artifacts. Its observations never enter the replay gate.
type Explorer struct {
	Runner     Runner
	Redactor   *redact.Redactor
	Redactions *int64
}

func CheckExploreRequest(req protocol.BrowserExploreRequest) error {
	if err := protocol.CheckBrowserExploreRequest(req); err != nil {
		return err
	}
	steps := make([]protocol.BrowserStep, len(req.Steps))
	for i, s := range req.Steps {
		steps[i] = protocol.BrowserStep{Goto: s.Goto, Click: s.Click, Fill: s.Fill, Select: s.Select, Press: s.Press, WaitFor: s.WaitFor}
	}
	return Check(protocol.BrowserProbe{Kind: "browser", Steps: steps, Viewport: req.Viewport, TimeoutMs: req.TimeoutMs})
}

func (e Explorer) Run(ctx context.Context, spec RunSpec, req protocol.BrowserExploreRequest) (protocol.BrowserExploreResult, error) {
	empty := protocol.BrowserExploreResult{}
	if err := CheckExploreRequest(req); err != nil {
		return empty, err
	}
	if e.Runner == nil || spec.Port < 1 || spec.Port > 65535 {
		return empty, errors.New("browser: exploration unavailable")
	}
	origin := "http://" + AppHost
	if spec.Port != 80 {
		origin += ":" + strconv.Itoa(spec.Port)
	}
	body, err := json.Marshal(struct {
		Mode    string                         `json:"mode"`
		Origin  string                         `json:"origin"`
		Request protocol.BrowserExploreRequest `json:"request"`
	}{"explore", origin, req})
	if err != nil {
		return empty, err
	}
	spec.Deadline = time.Duration(req.TimeoutMs)*time.Millisecond + ExploreGrace
	ctx, cancel := context.WithTimeout(ctx, spec.Deadline)
	defer cancel()
	var stream bytes.Buffer
	if err := e.Runner.Run(ctx, spec, body, &limitWriter{w: &stream, left: maxExplorationStream}); err != nil {
		return empty, err
	}
	reader := tar.NewReader(bytes.NewReader(stream.Bytes()))
	header, err := reader.Next()
	if err != nil {
		return empty, errors.New("browser: missing exploration result")
	}
	if header.Name != "exploration.json" || header.Typeflag != tar.TypeReg || header.Linkname != "" || header.Size < 1 || header.Size > maxExplorationJSON {
		return empty, errors.New("browser: invalid exploration entry")
	}
	raw, ok, err := limited(reader, maxExplorationJSON)
	if err != nil || !ok {
		return empty, errors.New("browser: exploration result exceeds bound")
	}
	if _, err := reader.Next(); !errors.Is(err, io.EOF) {
		return empty, errors.New("browser: exploration contains extra entries")
	}
	// Reuse the strict protocol JSON parser before unmarshalling, retaining its
	// duplicate-key, depth, required-field and closed-schema validation. This
	// local validation envelope is never sent or admitted as an actual step.
	frame := []byte(fmt.Sprintf(`{"v":%d,"id":"6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b","cellId":"local-explorer","claimId":"local-claim","type":"step.result","body":{"stepId":"0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d","executor":"observer","imageId":"local-image","vmHealth":"ok","browserExploration":`, protocol.ProtocolVersion))
	frame = append(frame, raw...)
	frame = append(frame, []byte(`}}`)...)
	message, err := protocol.Decode(frame)
	if err != nil {
		return empty, errors.New("browser: invalid exploration result")
	}
	result := *message.Body.(*protocol.StepResultBody).BrowserExploration
	if result.ActionsCompleted > int64(len(req.Steps)) || (result.Status == protocol.BrowserExploreStatusObserved && result.ActionsCompleted != int64(len(req.Steps))) {
		return empty, errors.New("browser: exploration action count does not match request")
	}
	r := e.Redactor
	if r == nil {
		r = redact.New()
	}
	wrapped := &protocol.StepResultBody{BrowserExploration: &result}
	count := r.StepResult(wrapped)
	if e.Redactions != nil {
		*e.Redactions += int64(count)
	}
	if err := protocol.CheckBrowserExploreResult(result); err != nil {
		return empty, errors.New("browser: redacted exploration result is invalid")
	}
	return result, nil
}
