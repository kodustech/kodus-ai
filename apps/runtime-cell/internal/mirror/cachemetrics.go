package mirror

import "github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"

// CacheMetrics are the OCI cache's counters. Labels come from fixed sets
// (kind: blob, manifest; outcome: hit, miss, revalidated, stale), never from
// a repository or a claim. A nil *CacheMetrics records nothing.
type CacheMetrics struct {
	requests  *metrics.Vec
	evictions *metrics.Vec
	bytes     *metrics.Vec
}

func NewCacheMetrics(r *metrics.Registry) *CacheMetrics {
	return &CacheMetrics{
		requests:  r.Counter("cell_mirror_cache_requests_total", "OCI mirror requests by what the cache did", "kind", "outcome"),
		evictions: r.Counter("cell_mirror_cache_evictions_total", "blobs evicted from the OCI mirror cache"),
		bytes:     r.Gauge("cell_mirror_cache_bytes", "bytes held by the OCI mirror cache"),
	}
}

func (m *CacheMetrics) count(kind, outcome string) {
	if m != nil {
		m.requests.Inc(kind, outcome)
	}
}

func (m *CacheMetrics) evicted() {
	if m != nil {
		m.evictions.Inc()
	}
}

func (m *CacheMetrics) setBytes(n int64) {
	if m != nil {
		m.bytes.Set(float64(n))
	}
}

// Count is one counter's value (tests).
func (m *CacheMetrics) Count(kind, outcome string) float64 {
	if m == nil {
		return 0
	}
	return m.requests.Value(kind, outcome)
}

// Evictions is the eviction counter's value (tests).
func (m *CacheMetrics) Evictions() float64 {
	if m == nil {
		return 0
	}
	return m.evictions.Value()
}
