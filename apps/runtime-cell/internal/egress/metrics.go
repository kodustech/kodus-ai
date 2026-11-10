package egress

import (
	"fmt"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
)

// Metrics are the proxy's counters, served in the Prometheus text format:
// connections allowed and denied (by reason), live connections, bytes.
type Metrics struct {
	mu      sync.Mutex
	denied  map[string]*atomic.Int64
	allowed atomic.Int64
	live    atomic.Int64
	up      atomic.Int64
	down    atomic.Int64
}

func NewMetrics() *Metrics { return &Metrics{denied: map[string]*atomic.Int64{}} }

func (m *Metrics) deny(reason string) {
	m.mu.Lock()
	c := m.denied[reason]
	if c == nil {
		c = &atomic.Int64{}
		m.denied[reason] = c
	}
	m.mu.Unlock()
	c.Add(1)
}

// Denied is the count for one reason (tests, logs).
func (m *Metrics) Denied(reason string) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c := m.denied[reason]; c != nil {
		return c.Load()
	}
	return 0
}

func (m *Metrics) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	m.mu.Lock()
	reasons := make([]string, 0, len(m.denied))
	for r := range m.denied {
		reasons = append(reasons, r)
	}
	sort.Strings(reasons)
	fmt.Fprintln(w, "# TYPE kodus_egress_denied_total counter")
	for _, r := range reasons {
		fmt.Fprintf(w, "kodus_egress_denied_total{reason=%q} %d\n", r, m.denied[r].Load())
	}
	m.mu.Unlock()
	fmt.Fprintf(w, "# TYPE kodus_egress_allowed_total counter\nkodus_egress_allowed_total %d\n", m.allowed.Load())
	fmt.Fprintf(w, "# TYPE kodus_egress_live_connections gauge\nkodus_egress_live_connections %d\n", m.live.Load())
	fmt.Fprintf(w, "# TYPE kodus_egress_bytes_total counter\nkodus_egress_bytes_total{direction=\"up\"} %d\nkodus_egress_bytes_total{direction=\"down\"} %d\n", m.up.Load(), m.down.Load())
}
