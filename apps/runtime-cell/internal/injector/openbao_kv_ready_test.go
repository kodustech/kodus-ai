package injector

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
)

const baoKVUpgradingMessage = "Upgrading from non-versioned to versioned data. This backend will be unavailable for a brief period and will resume service shortly."

var errBaoKVUpgrading = errors.New("owned KV fixture initializing")

// This is a test-fixture probe, not production retry policy. The old fixture
// trusted /sys/health and immediately wrote to a still-initializing KV mount.
func baoWaitKVReady(ctx context.Context, client *http.Client, address, token string, c clock.Clock) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	deadline := c.Now().Add(3 * time.Second)
	for c.Now().Before(deadline) {
		err := baoProbeKVReady(ctx, client, address, token)
		if !errors.Is(err, errBaoKVUpgrading) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.After(25 * time.Millisecond):
		}
	}
	return context.DeadlineExceeded
}

func baoProbeKVReady(ctx context.Context, client *http.Client, address, token string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address+"/v1/runtime-kv/config", nil)
	if err != nil {
		return errors.New("owned KV fixture request invalid")
	}
	req.Header.Set("X-Vault-Token", token)
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("owned KV fixture transport unavailable")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
	if err != nil || len(raw) > 64<<10 {
		return errors.New("owned KV fixture response invalid")
	}
	var body struct {
		Data   map[string]any `json:"data"`
		Errors []string       `json:"errors"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return errors.New("owned KV fixture response invalid")
	}
	if response.StatusCode == http.StatusOK && body.Data != nil && len(body.Errors) == 0 {
		return nil
	}
	if response.StatusCode == http.StatusBadRequest && len(body.Errors) == 1 && body.Errors[0] == baoKVUpgradingMessage {
		return errBaoKVUpgrading
	}
	return errors.New("owned KV fixture readiness refused")
}

func TestOpenBaoKVReadinessWaitsForMountNotGeneralHealth(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: feedTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Method != http.MethodGet || r.URL.Path != "/v1/runtime-kv/config" || r.Header.Get("X-Vault-Token") != "synthetic-root-only" {
			t.Error("readiness did not use the owned mount's readonly endpoint")
		}
		status, body := http.StatusOK, `{"data":{"max_versions":10}}`
		if calls <= 2 {
			status = http.StatusBadRequest
			raw, _ := json.Marshal(map[string]any{"errors": []string{baoKVUpgradingMessage}})
			body = string(raw)
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	if err := baoWaitKVReady(context.Background(), client, "https://owned.test", "synthetic-root-only", clock.NewFake(time.Now())); err != nil {
		t.Fatalf("mount initialization was not awaited: %v", err)
	}
	if calls != 3 {
		t.Fatalf("readiness probes=%d, want3", calls)
	}
}

func TestOpenBaoKVReadinessRefusesOtherFailures(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
	}{
		{"permission", 403, `{"errors":["permission denied synthetic-sensitive"]}`},
		{"unknown400", 400, `{"errors":["synthetic-sensitive"]}`},
		{"cas", 400, `{"errors":["check-and-set parameter did not match synthetic-sensitive"]}`},
		{"mixed", 400, `{"errors":["` + baoKVUpgradingMessage + `","synthetic-sensitive"]}`},
		{"server", 500, `{"errors":["` + baoKVUpgradingMessage + `"]}`},
		{"malformed", 200, `not-json synthetic-sensitive`},
		{"missing-data", 200, `{}`},
		{"oversized", 400, strings.Repeat("x", 64<<10+1)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: feedTransport(func(*http.Request) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(tc.body)), Header: make(http.Header)}, nil
			})}
			err := baoWaitKVReady(context.Background(), client, "https://owned.test", "synthetic-root-only", clock.NewFake(time.Now()))
			if err == nil || strings.Contains(err.Error(), "synthetic-sensitive") || calls != 1 {
				t.Fatal("readiness retried or disclosed an unexpected failure")
			}
		})
	}
}

func TestOpenBaoKVReadinessBoundsUpgradeWait(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: feedTransport(func(*http.Request) (*http.Response, error) {
		calls++
		raw, _ := json.Marshal(map[string]any{"errors": []string{baoKVUpgradingMessage}})
		return &http.Response{StatusCode: 400, Body: io.NopCloser(strings.NewReader(string(raw))), Header: make(http.Header)}, nil
	})}
	c := clock.NewFake(time.Now())
	start := c.Now()
	err := baoWaitKVReady(context.Background(), client, "https://owned.test", "synthetic-root-only", c)
	if !errors.Is(err, context.DeadlineExceeded) || c.Now().Sub(start) > 3*time.Second || calls > 120 {
		t.Fatal("KV initialization wait was not bounded")
	}
}

func TestOpenBaoKVReadinessCanceledContextSendsNothing(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	client := &http.Client{Transport: feedTransport(func(*http.Request) (*http.Response, error) {
		t.Error("canceled readiness sent request")
		return nil, errors.New("synthetic-sensitive")
	})}
	if err := baoWaitKVReady(ctx, client, "https://owned.test", "synthetic-root-only", clock.NewFake(time.Now())); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation ignored")
	}
}
