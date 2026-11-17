package agent

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubprotocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// runUntil runs the agent against url until done says so or 3 s pass.
func runUntil(t *testing.T, h *harness, url string, rc RunConfig, done func() bool) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() { defer close(stopped); _ = h.a.Run(ctx, rc) }()
	deadline := time.Now().Add(3 * time.Second)
	for !done() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-stopped
}

// After the hub accepts the hello, the host keeps what the hub said: the
// version it chose and the cell protocols it accepts, for cell update. The
// hello names cellProtocols, so a hub that knows the field sends it.
func TestAnAcceptedHelloRecordsTheProtocolsTheHubAccepts(t *testing.T) {
	state := filepath.Join(t.TempDir(), "state", hubprotocol.StateName)
	h := newHarness(t, func(c *Config) { c.HubProtocolState = state })
	var named atomic.Bool
	url, tlsCfg := scriptedHub(t, func(m *protocol.Message, answerWith func(body any)) {
		if hello, ok := m.Body.(*protocol.HelloBody); ok {
			named.Store(slices.Contains(hello.Features, protocol.FeatureCellProtocols))
			v := int64(protocol.ProtocolVersion)
			answerWith(&protocol.AckBody{Version: &v, CellProtocols: &protocol.AckBodyCellProtocols{Min: 1, Max: v + 1}})
		}
	})
	runUntil(t, h, url, RunConfig{HubURL: url, TLS: tlsCfg, AckTimeout: time.Second}, func() bool { _, err := os.Stat(state); return err == nil })
	if !named.Load() {
		t.Fatal("the hello does not name cellProtocols")
	}
	got, ok, err := hubprotocol.Load(state)
	if err != nil || !ok {
		t.Fatalf("no state after an accepted hello: %v %v\n%s", ok, err, h.logs.String())
	}
	if got.Version != int64(protocol.ProtocolVersion) || got.Accepts == nil || *got.Accepts != (hubprotocol.Range{Min: 1, Max: int64(protocol.ProtocolVersion) + 1}) || got.At.IsZero() {
		t.Fatalf("state %+v", got)
	}
	if fi, _ := os.Stat(state); fi.Mode().Perm() != 0o600 {
		t.Fatalf("state mode %v, want 0600", fi.Mode())
	}
}

// A hub that does not name the range (one before the field) leaves the
// version it chose, and no range.
func TestAnAckWithoutTheRangeRecordsTheChosenVersionOnly(t *testing.T) {
	state := filepath.Join(t.TempDir(), hubprotocol.StateName)
	h := newHarness(t, func(c *Config) { c.HubProtocolState = state })
	url, tlsCfg := scriptedHub(t, func(m *protocol.Message, answerWith func(body any)) {
		if _, ok := m.Body.(*protocol.HelloBody); ok {
			v := int64(protocol.ProtocolVersion)
			answerWith(&protocol.AckBody{Version: &v})
		}
	})
	runUntil(t, h, url, RunConfig{HubURL: url, TLS: tlsCfg, AckTimeout: time.Second}, func() bool { _, err := os.Stat(state); return err == nil })
	got, ok, err := hubprotocol.Load(state)
	if err != nil || !ok || got.Version != int64(protocol.ProtocolVersion) || got.Accepts != nil {
		t.Fatalf("state %+v %v %v", got, ok, err)
	}
}

// A hello the hub refuses records nothing: the state of the last hub that
// accepted this cell stays as it was.
func TestARefusedHelloRecordsNothing(t *testing.T) {
	state := filepath.Join(t.TempDir(), hubprotocol.StateName)
	before := hubprotocol.State{Version: 1, Accepts: &hubprotocol.Range{Min: 1, Max: 1}, At: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)}
	if err := hubprotocol.Save(state, before); err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, func(c *Config) { c.HubProtocolState = state })
	var hellos atomic.Int64
	url, tlsCfg := scriptedHub(t, func(m *protocol.Message, answerWith func(body any)) {
		if _, ok := m.Body.(*protocol.HelloBody); ok {
			hellos.Add(1)
			answerWith(&protocol.NackBody{Code: protocol.HelloRefusedCellTooNew, Message: "upgrade the hub first"})
		}
	})
	runUntil(t, h, url, RunConfig{HubURL: url, TLS: tlsCfg, AckTimeout: time.Second, RefusedBackoff: time.Hour}, func() bool { return hellos.Load() > 0 })
	time.Sleep(20 * time.Millisecond)
	got, ok, err := hubprotocol.Load(state)
	if err != nil || !ok || !got.At.Equal(before.At) || *got.Accepts != *before.Accepts {
		t.Fatalf("a refused hello changed the state: %+v %v %v", got, ok, err)
	}
}

// Without a path (a test cell, a dev run), nothing is written.
func TestWithoutAPathNothingIsRecorded(t *testing.T) {
	h := newHarness(t)
	var acked atomic.Bool
	url, tlsCfg := scriptedHub(t, func(m *protocol.Message, answerWith func(body any)) {
		if _, ok := m.Body.(*protocol.HelloBody); ok {
			v := int64(protocol.ProtocolVersion)
			answerWith(&protocol.AckBody{Version: &v, CellProtocols: &protocol.AckBodyCellProtocols{Min: 1, Max: v}})
			acked.Store(true)
		}
	})
	runUntil(t, h, url, RunConfig{HubURL: url, TLS: tlsCfg, AckTimeout: time.Second}, acked.Load)
	if entries, _ := os.ReadDir(h.a.cfg.WorkDir); len(entries) != 0 {
		t.Fatalf("wrote %v into the work dir with no state path", entries)
	}
}
