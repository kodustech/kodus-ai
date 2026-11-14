package metrics

import (
	"strings"
	"testing"
)

func TestWriteTextIsPrometheusFormat(t *testing.T) {
	r := NewRegistry()
	c := r.Counter("cell_nacks_sent_total", "Nacks the cell sent.", "code")
	c.Inc("unknown_claim")
	c.Add(2, `we"ird`)
	r.Gauge("cell_claims", "Claims by state.", "state").Set(3, "ready")
	r.GaugeFunc("cell_up", "Always 1.", func() float64 { return 1 })
	var b strings.Builder
	if err := r.WriteText(&b); err != nil {
		t.Fatal(err)
	}
	want := `# HELP cell_claims Claims by state.
# TYPE cell_claims gauge
cell_claims{state="ready"} 3
# HELP cell_nacks_sent_total Nacks the cell sent.
# TYPE cell_nacks_sent_total counter
cell_nacks_sent_total{code="unknown_claim"} 1
cell_nacks_sent_total{code="we\"ird"} 2
# HELP cell_up Always 1.
# TYPE cell_up gauge
cell_up 1
`
	if b.String() != want {
		t.Fatalf("got\n%s\nwant\n%s", b.String(), want)
	}
}

func TestNilVecIsANoOp(t *testing.T) {
	var r *Registry
	v := r.Counter("x", "y")
	v.Inc()
	if v.Value() != 0 {
		t.Fatal("nil vec counted")
	}
}
