package observer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// StepResult turns a probe outcome into the step.result body the hub gets.
// A refused probe has no probe field: it is inconclusive, never a finding.
func StepResult(stepID, imageID string, res *protocol.ProbeResult, err error) *protocol.StepResultBody {
	out := &protocol.StepResultBody{StepID: stepID, Executor: protocol.ExecutorObserver, ImageID: imageID, VMHealth: protocol.VMHealthOk}
	var unreachable *UnreachableError
	switch {
	case err == nil:
		out.Probe = res
	case errors.As(err, &unreachable):
		out.VMHealth = protocol.VMHealthUnreachable
	}
	return out
}

// Handler serves POST /v1/run: the body is the probe.run frame the hub sent,
// decoded again here with the strict decoder; the answer is a step.result
// frame. Only the cell agent reaches this port (security group, mTLS).
func Handler(r *Prober, cellID string, newID func() string) http.Handler {
	return handlerFor(r, cellID, "", newID)
}

// handlerFor answers only frames of claim when claim is set.
func handlerFor(r *Prober, cellID, claim string, newID func() string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/run", func(w http.ResponseWriter, req *http.Request) {
		raw, err := io.ReadAll(io.LimitReader(req.Body, protocol.MaxFrameBytes+1))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		msg, err := protocol.Decode(raw)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		run, ok := msg.Body.(*protocol.ProbeRunBody)
		if !ok {
			http.Error(w, "only probe.run", http.StatusBadRequest)
			return
		}
		frameClaim := ""
		if msg.Envelope.ClaimID != nil {
			frameClaim = *msg.Envelope.ClaimID
		}
		if claim != "" && frameClaim != claim {
			// One claim per observer: a frame for another claim is a bug in
			// the agent or an attack, never something to run.
			http.Error(w, "frame for another claim", http.StatusConflict)
			return
		}
		res, perr := r.RunStep(req.Context(), run)
		body := StepResult(run.StepID, r.cfg.ImageID, res, perr)
		out, err := protocol.Encode(protocol.Header{ID: newID(), Re: msg.Envelope.ID, CellID: cellID, ClaimID: frameClaim}, body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if perr != nil {
			w.Header().Set("X-Kodus-Probe-Refused", perr.Error())
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(out)
	})
	mux.HandleFunc("GET /v1/requests", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(r.Log())
	})
	return mux
}

// Client is how the cell agent talks to a claim's observer.
type Client interface {
	Run(ctx context.Context, frame []byte) (*protocol.StepResultBody, string, error)
}

// InProcess runs the observer inside the agent. Fake cell only: in
// production the observer is its own machine (ADR-053).
type InProcess struct {
	Runner *Prober
}

func (c InProcess) Run(ctx context.Context, frame []byte) (*protocol.StepResultBody, string, error) {
	msg, err := protocol.Decode(frame)
	if err != nil {
		return nil, "", err
	}
	run, ok := msg.Body.(*protocol.ProbeRunBody)
	if !ok {
		return nil, "", errors.New("observer: only probe.run")
	}
	res, perr := c.Runner.RunStep(ctx, run)
	refused := ""
	if perr != nil {
		refused = perr.Error()
	}
	return StepResult(run.StepID, c.Runner.cfg.ImageID, res, perr), refused, nil
}

// HTTPClient calls an observer machine.
type HTTPClient struct {
	BaseURL string
	HTTP    *http.Client
}

func (c HTTPClient) Run(ctx context.Context, frame []byte) (*protocol.StepResultBody, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/v1/run", bytes.NewReader(frame))
	if err != nil {
		return nil, "", err
	}
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, protocol.MaxFrameBytes+1))
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, "", errors.New("observer: " + resp.Status + ": " + string(raw))
	}
	msg, err := protocol.Decode(raw)
	if err != nil {
		return nil, "", err
	}
	body, ok := msg.Body.(*protocol.StepResultBody)
	if !ok {
		return nil, "", errors.New("observer: answer is not step.result")
	}
	return body, resp.Header.Get("X-Kodus-Probe-Refused"), nil
}
