package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type exitedReader struct{ calls int }

func (r *exitedReader) ExitedServices(context.Context, driver.MachineRef, int) ([]driver.ExitedService, error) {
	r.calls++
	return []driver.ExitedService{{Name: "api", State: "Exited (1) 2 seconds ago", ExitCode: 1, Log: []string{"seed failed", "token=ghp_" + strings.Repeat("a", 36)}}}, nil
}

// observerAnswering is an observer whose probe got an HTTP answer, or none.
type observerAnswering struct{ status int64 }

func (o observerAnswering) Run(context.Context, []byte) (*protocol.StepResultBody, string, error) {
	p := &protocol.ProbeResult{Executor: "observer", Requests: []protocol.RequestLogEntry{}, Transport: protocol.ProbeResultTransportOk}
	if o.status != 0 {
		p.HTTP = &protocol.ProbeResultHTTP{Status: o.status, Headers: map[string]string{}}
	}
	return &protocol.StepResultBody{VMHealth: protocol.VMHealthOk, Probe: p}, "", nil
}

func healthProbe() *protocol.ProbeRunBody {
	return &protocol.ProbeRunBody{StepID: step1, Probe: protocol.Probe{
		ID: "p", Origin: protocol.ProbeOriginAgent, Purpose: "p", Expected: "200",
		Compare: []protocol.CompareField{protocol.CompareFieldStatus},
		Spec:    protocol.ProbeSpec{HTTP: &protocol.HTTPProbe{Target: protocol.ProbeTarget{Service: "api", Port: 80}, Method: protocol.HTTPMethodGet, Path: "/health", TimeoutMs: 1000}},
	}}
}

func probeResult(t *testing.T, status int64, accepts bool, reader *exitedReader) *protocol.StepResultBody {
	t.Helper()
	h := newHarness(t, func(c *Config) {
		c.Observers = func(context.Context, ClaimInfo, []observer.Target) (observer.Client, error) {
			return observerAnswering{status: status}, nil
		}
		c.Parts.ExitedServices = reader
	})
	if accepts {
		h.a.accepts = map[string]bool{protocol.FeatureServiceStates: true}
	}
	h.ready("claim-1")
	if err := h.handle("claim-1", protocol.MessageTypeProbeRun, healthProbe()); err != nil {
		t.Fatal(err)
	}
	return h.conn.next(t, isResult(step1)).(*protocol.StepResultBody)
}

// A probe that got no HTTP answer says which services exited, with exit code and a
// redacted log tail, so the ready check can end at once on an app that died.
func TestAProbeWithNoAnswerReportsTheServicesThatExited(t *testing.T) {
	r := probeResult(t, 0, true, &exitedReader{})
	if len(r.Services) != 1 || r.Services[0].Name != "api" || r.Services[0].ExitCode != 1 || len(r.Services[0].LogTail) != 2 {
		t.Fatalf("services %+v", r.Services)
	}
	if strings.Contains(strings.Join(r.Services[0].LogTail, "\n"), "ghp_") {
		t.Fatalf("the log tail was not redacted: %v", r.Services[0].LogTail)
	}
}

// The field goes only to a hub that accepts it, and only when nothing answered.
func TestExitedServicesAreNotSentToAnOlderHubNorWhenTheAppAnswered(t *testing.T) {
	if r := probeResult(t, 0, false, &exitedReader{}); len(r.Services) != 0 {
		t.Fatalf("an older hub got services: %+v", r.Services)
	}
	reader := &exitedReader{}
	if r := probeResult(t, 200, true, reader); len(r.Services) != 0 || reader.calls != 0 {
		t.Fatalf("an answered probe read the services: %+v (%d reads)", r.Services, reader.calls)
	}
}
