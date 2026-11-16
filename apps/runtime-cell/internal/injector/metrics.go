package injector

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
)

// Metrics are the injector's counters (docs/runtime/observability.md):
// requests whose placeholders it swapped or refused, the alerts it raised,
// and whether its OpenBao answers unsealed. Every method is safe on a nil
// *Metrics: an injector built without a registry records nothing.
type Metrics struct {
	swaps     *metrics.Vec
	alerts    *metrics.Vec
	up        *metrics.Vec
	inspected *metrics.Vec
}

// NewMetrics registers the injector's families on reg.
func NewMetrics(reg *metrics.Registry) *Metrics {
	return &Metrics{
		swaps:  reg.Counter("cell_injector_swaps_total", "Requests whose placeholders the injector swapped for a secret, or refused (outcome: swapped, no_secret, refused).", "outcome"),
		alerts: reg.Counter("cell_injector_alerts_total", "Placeholders or credentials the injector saw going to a host they were not for, by kind.", "kind"),
		up:     reg.Gauge("cell_openbao_up", "1 when the injector's last OpenBao health read answered unsealed, 0 when sealed, uninitialized or unreachable."),
		inspected: reg.Counter("cell_injector_inspected_requests_total",
			"Requests to a host of the inspected tier, by outcome (allowed, or the refusal: inspect_method, inspect_path, inspect_body, inspect_uri, inspect_git_push, placeholder).", "outcome"),
	}
}

func (m *Metrics) inspect(outcome string) {
	if m != nil {
		m.inspected.Inc(outcome)
	}
}

func (m *Metrics) swap(outcome string) {
	if m != nil {
		m.swaps.Inc(outcome)
	}
}

func (m *Metrics) alert(kind string) {
	if m != nil {
		m.alerts.Inc(kind)
	}
}

// SetOpenBaoUp records one health read.
func (m *Metrics) SetOpenBaoUp(up bool) {
	if m == nil {
		return
	}
	v := 0.0
	if up {
		v = 1
	}
	m.up.Set(v)
}

// Healthy reads OpenBao's /v1/sys/health (no token): unsealed is 200 (active)
// or 429 (an unsealed standby); 503 is sealed, 501 not initialized, anything
// else or no answer is unreachable.
func (s *OpenBaoSecrets) Healthy(ctx context.Context) bool {
	if s == nil || s.client == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.address+"/v1/sys/health", nil)
	if err != nil {
		return false
	}
	res, err := s.client.Do(req)
	if err != nil {
		return false
	}
	defer func() { _ = res.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	return res.StatusCode == http.StatusOK || res.StatusCode == http.StatusTooManyRequests
}

// WatchOpenBao reads the health every interval until ctx ends, and records it.
func (m *Metrics) WatchOpenBao(ctx context.Context, s *OpenBaoSecrets, every time.Duration) {
	m.SetOpenBaoUp(s.Healthy(ctx))
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.SetOpenBaoUp(s.Healthy(ctx))
		}
	}
}
