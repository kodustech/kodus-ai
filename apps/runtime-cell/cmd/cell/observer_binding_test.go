package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

type observerRoundTrip func(*http.Request) (*http.Response, error)

func (f observerRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// A generic 409 says an observer is configured, not which claim owns it.
func TestHTTPObserverRefusesUnprovenExistingBinding(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	hc := &http.Client{Transport: observerRoundTrip(func(*http.Request) (*http.Response, error) {
		cancel()
		return &http.Response{StatusCode: http.StatusConflict, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("already configured"))}, nil
	})}
	factory := httpObservers(hc, nil)
	c := agent.ClaimInfo{ClaimID: "claim-a", Workload: driver.MachineRef{ImageID: "img-a"}, Observer: driver.MachineRef{PrivateAddress: "10.0.0.3"}}
	client, err := factory(ctx, c, nil)
	if err == nil || client != nil {
		t.Fatal("unproven 409 was accepted as this claim's observer")
	}
}
