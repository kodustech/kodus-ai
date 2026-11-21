package agent

import (
	"context"
	"errors"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Observer configuration failure is not an observation that the app VM died.
func TestObserverConfigFailureDoesNotInventUnhealthyWorkload(t *testing.T) {
	h := newHarness(t, func(c *Config) {
		c.Observers = func(context.Context, ClaimInfo, []observer.Target) (observer.Client, error) {
			return nil, errors.New("observer binding refused")
		}
	})
	h.ready("claim-1")
	b := &protocol.ProbeRunBody{StepID: step1, Probe: protocol.Probe{
		ID: "ready", Origin: protocol.ProbeOriginAgent, Purpose: "HTTP readiness", Expected: "200", Compare: []protocol.CompareField{protocol.CompareFieldStatus},
		Spec: protocol.ProbeSpec{HTTP: &protocol.HTTPProbe{Target: protocol.ProbeTarget{Service: "app", Port: 3000}, Method: protocol.HTTPMethodGet, Path: "/", TimeoutMs: 1000}},
	}}
	if err := h.handle("claim-1", protocol.MessageTypeProbeRun, b); err != nil {
		t.Fatal(err)
	}
	got := h.conn.next(t, isResult(step1)).(*protocol.StepResultBody)
	if got.VMHealth != protocol.VMHealthOk || got.Probe != nil {
		t.Fatal("observer infrastructure failure became unhealthy app evidence")
	}
}
