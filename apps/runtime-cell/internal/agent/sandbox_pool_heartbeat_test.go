package agent

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// The heartbeat carries the warm pool (target and ready) only to a hub that
// accepts sandboxPool, and only a cell that keeps a pool names the feature.
func TestHeartbeatCarriesTheSandboxPoolOnlyToAHubThatAcceptsIt(t *testing.T) {
	h := newHarness(t, withSandboxes(t.TempDir(), 4))
	if !slices.Contains(h.a.Hello().Features, protocol.FeatureSandboxPool) {
		t.Fatalf("a cell with a pool does not name sandboxPool: %v", h.a.Hello().Features)
	}
	if hb := h.a.Heartbeat(); hb.SandboxPool != nil {
		t.Fatalf("sent to a hub that did not accept it: %+v", hb.SandboxPool)
	}
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureSandboxPool}})
	h.a.sandboxPool.mu.Lock()
	h.a.sandboxPool.ready = append(h.a.sandboxPool.ready, &pooledSandbox{}, &pooledSandbox{}, &pooledSandbox{})
	h.a.sandboxPool.mu.Unlock()
	hb := h.a.Heartbeat()
	if hb.SandboxPool == nil || hb.SandboxPool.Target != 4 || hb.SandboxPool.Ready != 3 {
		t.Fatalf("heartbeat sandboxPool %+v, want target 4 ready 3", hb.SandboxPool)
	}
	raw, _ := json.Marshal(hb)
	var wire struct {
		SandboxPool struct{ Target, Ready int64 } `json:"sandboxPool"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil || wire.SandboxPool.Target != 4 || wire.SandboxPool.Ready != 3 {
		t.Fatalf("wire %s: %v", raw, err)
	}
}

func TestACellWithoutAPoolNamesNoSandboxPoolAndSendsNone(t *testing.T) {
	h := newHarness(t)
	if slices.Contains(h.a.Hello().Features, protocol.FeatureSandboxPool) {
		t.Fatal("named by a cell without a pool")
	}
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureSandboxPool}})
	if hb := h.a.Heartbeat(); hb.SandboxPool != nil {
		t.Fatalf("sent without a pool: %+v", hb.SandboxPool)
	}
}

// A heartbeat of a cell older than the field decodes, with no pool.
func TestAnOldSchemaHeartbeatWithoutSandboxPoolStillDecodes(t *testing.T) {
	var hb protocol.HeartbeatBody
	if err := json.Unmarshal([]byte(`{"claims":[],"freeSlots":2}`), &hb); err != nil || hb.SandboxPool != nil || hb.FreeSlots != 2 {
		t.Fatalf("%+v %v", hb, err)
	}
}
