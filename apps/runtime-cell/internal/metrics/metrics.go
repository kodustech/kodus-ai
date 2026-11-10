// Package metrics is the cell's counters and gauges, served in the
// Prometheus text format (version 0.0.4) on a local listener. The cell has
// no other telemetry path: its logs go to stderr as JSON and the hub only
// sees protocol frames, so the numbers an operator alarms on (refused
// frames, settle give-ups, reaper kills, certificate time left) are here.
// No dependency: the exposition format is a few lines.
//
// Every method is safe on a nil *Vec, so a component built without a
// registry (tests) records nothing.
package metrics

import (
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
)

type kind string

const (
	counterKind kind = "counter"
	gaugeKind   kind = "gauge"
)

type family struct {
	name, help string
	kind       kind
	labels     []string
	mu         sync.Mutex
	values     map[string]float64 // by encoded label values
	fn         func() float64     // gauge func, no labels
}

type Registry struct {
	mu       sync.Mutex
	families map[string]*family
}

func NewRegistry() *Registry { return &Registry{families: map[string]*family{}} }

func (r *Registry) add(f *family) *family {
	r.mu.Lock()
	defer r.mu.Unlock()
	if prev, ok := r.families[f.name]; ok {
		return prev
	}
	r.families[f.name] = f
	return f
}

// Vec is a counter or a gauge with fixed label names.
type Vec struct{ f *family }

// Counter registers (or returns) a counter family.
func (r *Registry) Counter(name, help string, labels ...string) *Vec {
	if r == nil {
		return nil
	}
	return &Vec{r.add(&family{name: name, help: help, kind: counterKind, labels: labels, values: map[string]float64{}})}
}

// Gauge registers (or returns) a gauge family.
func (r *Registry) Gauge(name, help string, labels ...string) *Vec {
	if r == nil {
		return nil
	}
	return &Vec{r.add(&family{name: name, help: help, kind: gaugeKind, labels: labels, values: map[string]float64{}})}
}

// GaugeFunc is a gauge read at scrape time.
func (r *Registry) GaugeFunc(name, help string, fn func() float64) {
	if r == nil {
		return
	}
	r.add(&family{name: name, help: help, kind: gaugeKind, fn: fn})
}

func (v *Vec) key(values []string) string {
	if len(values) != len(v.f.labels) {
		panic(fmt.Sprintf("metrics: %s takes %d labels, got %d", v.f.name, len(v.f.labels), len(values)))
	}
	return strings.Join(values, "\x00")
}

func (v *Vec) Inc(labelValues ...string) { v.Add(1, labelValues...) }

func (v *Vec) Add(n float64, labelValues ...string) {
	if v == nil {
		return
	}
	k := v.key(labelValues)
	v.f.mu.Lock()
	v.f.values[k] += n
	v.f.mu.Unlock()
}

func (v *Vec) Set(n float64, labelValues ...string) {
	if v == nil {
		return
	}
	k := v.key(labelValues)
	v.f.mu.Lock()
	v.f.values[k] = n
	v.f.mu.Unlock()
}

// Value reads one series (tests).
func (v *Vec) Value(labelValues ...string) float64 {
	if v == nil {
		return 0
	}
	k := v.key(labelValues)
	v.f.mu.Lock()
	defer v.f.mu.Unlock()
	return v.f.values[k]
}

// WriteText writes every family in the Prometheus text format, sorted.
func (r *Registry) WriteText(w io.Writer) error {
	r.mu.Lock()
	fams := make([]*family, 0, len(r.families))
	for _, f := range r.families {
		fams = append(fams, f)
	}
	r.mu.Unlock()
	sort.Slice(fams, func(i, j int) bool { return fams[i].name < fams[j].name })
	var b strings.Builder
	for _, f := range fams {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s %s\n", f.name, escapeHelp(f.help), f.name, f.kind)
		if f.fn != nil {
			fmt.Fprintf(&b, "%s %s\n", f.name, formatValue(f.fn()))
			continue
		}
		f.mu.Lock()
		keys := make([]string, 0, len(f.values))
		for k := range f.values {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			b.WriteString(f.name)
			if len(f.labels) > 0 {
				vals := strings.Split(k, "\x00")
				b.WriteByte('{')
				for i, l := range f.labels {
					if i > 0 {
						b.WriteByte(',')
					}
					fmt.Fprintf(&b, "%s=\"%s\"", l, escapeLabel(vals[i]))
				}
				b.WriteByte('}')
			}
			fmt.Fprintf(&b, " %s\n", formatValue(f.values[k]))
		}
		f.mu.Unlock()
	}
	_, err := io.WriteString(w, b.String())
	return err
}

// Handler serves WriteText.
func (r *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_ = r.WriteText(w)
	})
}

func formatValue(v float64) string {
	switch {
	case math.IsInf(v, 1):
		return "+Inf"
	case math.IsInf(v, -1):
		return "-Inf"
	case math.IsNaN(v):
		return "NaN"
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}

func escapeHelp(s string) string {
	return strings.NewReplacer(`\`, `\\`, "\n", `\n`).Replace(s)
}

// escapeLabel is the text format's escaping: backslash, quote, newline.
func escapeLabel(s string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(s)
}
