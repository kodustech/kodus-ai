package agent

import (
	"slices"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// A microVM cell names hostHardening in hello and sends what it found of
// its host (SMT, KSM, swap, unmitigated CPU vulnerabilities, microcode,
// its policy) in heartbeats, only to a hub that accepts it: an older hub's
// strict decoder would refuse the field. A cell with no report names none.
func TestTheHostReportGoesOnlyToAHubThatAcceptsIt(t *testing.T) {
	host := &protocol.HeartbeatBodyHost{Policy: protocol.HeartbeatBodyHostPolicyDedicated, Smt: "on", Ksm: "off", Swap: "off", Vulnerable: []string{"mds"}}
	h := newHarness(t, func(c *Config) { c.Host = host })
	if !slices.Contains(h.a.Hello().Features, protocol.FeatureHostHardening) {
		t.Fatal("hello does not name hostHardening")
	}
	if hb := h.a.Heartbeat(); hb.Host != nil {
		t.Fatalf("sent to a hub that did not accept it: %+v", hb.Host)
	}
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureHostHardening}})
	if hb := h.a.Heartbeat(); hb.Host == nil || hb.Host.Smt != "on" || !slices.Equal(hb.Host.Vulnerable, []string{"mds"}) {
		t.Fatalf("heartbeat host %+v", hb.Host)
	}
	plain := newHarness(t)
	if slices.Contains(plain.a.Hello().Features, protocol.FeatureHostHardening) {
		t.Fatal("a cell with no host report names hostHardening")
	}
}
