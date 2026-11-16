package agent

import (
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type fakeBuildStates []driver.EvictedBuildState

func (f fakeBuildStates) EvictedBuildStates() []driver.EvictedBuildState { return f }

// The cell evicted every environment's build state and the hub heard
// nothing: the environments stayed "active" while their builds ran cold. The
// heartbeat names them to a hub that accepts it, and to no other.
func TestTheHeartbeatNamesTheEnvironmentsWhoseBuildStateWasEvicted(t *testing.T) {
	at := time.Date(2026, 11, 13, 7, 31, 31, 0, time.UTC)
	h := newHarness(t, func(c *Config) {
		c.Parts.BuildStates = fakeBuildStates{{Org: "org-1", Env: "env-calcom", At: at}, {Org: "", Env: "env-unnamed", At: at}}
	})
	if hb := h.a.Heartbeat(); hb.EvictedBuildStates != nil {
		t.Fatalf("a hub that does not accept it got %+v", hb.EvictedBuildStates)
	}
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureBuildStateEvicted}})
	got := h.a.Heartbeat().EvictedBuildStates
	want := protocol.HeartbeatBodyEvictedBuildStatesItem{OrgID: "org-1", EnvironmentID: "env-calcom", EvictedAt: protocol.FormatTime(at)}
	if len(got) != 1 || got[0] != want {
		t.Fatalf("evictedBuildStates = %+v, want [%+v]", got, want)
	}
}

// The hub cannot tell a pull request that would build cold past its ceiling
// from one that would not: the heartbeat says what each evicted state took to
// make, to a hub that accepts it, and nothing for a state never measured.
func TestTheHeartbeatSaysWhatAnEvictedStateTookToMake(t *testing.T) {
	at := time.Date(2026, 11, 13, 7, 31, 31, 0, time.UTC)
	h := newHarness(t, func(c *Config) {
		c.Parts.BuildStates = fakeBuildStates{{Org: "org-1", Env: "env-calcom", At: at, Rebuild: 2050 * time.Second}, {Org: "org-1", Env: "env-old", At: at}}
	})
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureBuildStateEvicted}})
	for _, e := range h.a.Heartbeat().EvictedBuildStates {
		if e.RebuildSeconds != nil {
			t.Fatalf("a hub that does not accept the cost got it: %+v", e)
		}
	}
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureBuildStateEvicted, protocol.FeatureBuildStateRebuildCost}})
	got := h.a.Heartbeat().EvictedBuildStates
	if len(got) != 2 || got[0].RebuildSeconds == nil || *got[0].RebuildSeconds != 2050 || got[1].RebuildSeconds != nil {
		t.Fatalf("evictedBuildStates = %+v, want calcom at 2050 s and the unmeasured one without a cost", got)
	}
}
