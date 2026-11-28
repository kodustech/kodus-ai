package agent

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// bootPhaser is a driver that says where a boot went, failed or not.
type bootPhaser struct {
	bootTimes
	phases []driver.BootPhase
}

func (b bootPhaser) BootPhases(string) ([]driver.BootPhase, bool) { return b.phases, true }

// A hub that accepts the phases hears where the boot spent its time: the
// driver's split of the boot with the agent's own steps around it, slowest
// first, the agent's whole-boot phase left out as the driver split it. A hub
// that does not accept them hears none (its decoder would refuse them).
func TestTheHubHearsWhereTheBootSpentItsTime(t *testing.T) {
	drv := bootPhaser{phases: []driver.BootPhase{
		{Name: "export layers", Ms: 1_260_400}, {Name: "yarn install", Ms: 1_005_300}, {Name: "docker load", Ms: 61_000}, {Name: "compose up", Ms: 21_000},
	}}
	body := func(accepts []string) (*protocol.ClaimReadyBody, *protocol.ClaimFailedBody) {
		h := newHarness(t, func(c *Config) { c.Parts.BootTimes, c.Parts.BootPhases = drv, drv })
		h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: accepts})
		c := claims.New("claim-1", protocol.ClaimAcquireBody{ImageID: "img-acq", Expose: []protocol.Expose{}}, h.a.log, h.clk.Now())
		c.AddPrepPhase("fetch", 95_000)
		c.AddPrepPhase("compose", 2_400_000)
		return h.a.readyBody(c), &protocol.ClaimFailedBody{Phases: h.a.bootPhases(c)}
	}
	ready, failed := body([]string{protocol.FeatureBootPhases})
	want := []protocol.BootPhase{{Name: "export layers", Ms: 1_260_400}, {Name: "yarn install", Ms: 1_005_300}, {Name: "fetch code", Ms: 95_000}, {Name: "docker load", Ms: 61_000}, {Name: "compose up", Ms: 21_000}}
	if !reflect.DeepEqual(ready.Timing.Phases, want) || !reflect.DeepEqual(failed.Phases, want) {
		t.Fatalf("phases %+v / %+v, want %+v", ready.Timing.Phases, failed.Phases, want)
	}
	if ready, _ := body(nil); ready.Timing.Phases != nil {
		t.Fatalf("an older hub got phases: %+v", ready.Timing.Phases)
	}
}

// A setup the hub stops at its ceiling sends no claim.failed: while the boot
// runs, its progress says where the time went so far. Two services' builds
// add up, though each numbers its steps from #1, and the step still running
// counts until now.
func TestABootInProgressSaysWhereItsTimeWentSoFar(t *testing.T) {
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	live := newLivePhases(func() time.Time { return now })
	for _, l := range []string{
		"#8 [deps 4/7] RUN yarn install --immutable", "#8 DONE 600.0s",
		"#9 exporting to docker image format", "#9 exporting layers 300.0s done", "#9 DONE 301.0s",
		"kodus: worker built in 15m, image loaded in 1m",
		"#8 [deps 4/7] RUN yarn install --immutable", "#8 DONE 400.0s",
		"#9 exporting to docker image format", "#9 exporting layers",
	} {
		live.line(l)
	}
	now = now.Add(20 * time.Minute)
	got := live.snapshot()
	want := []driver.BootPhase{{Name: "yarn install", Ms: 1_000_000}, {Name: "export layers", Ms: 1_500_000, Running: true}}
	if len(got) != 2 || got[0] != want[1] || got[1] != want[0] {
		t.Fatalf("phases %+v, want %+v", got, want)
	}
}

// A phase is named from what the build printed (BuildKit's step names, with
// the build's arguments in them): a value the claim keeps secret, a download
// token of any of its repositories, never reaches the hub in one.
func TestABootPhaseNeverCarriesAClaimSecret(t *testing.T) {
	const own, other = "tok-own-5f1c9a7e", "tok-api-77d0b2c4"
	drv := bootPhaser{phases: []driver.BootPhase{{Name: "curl " + other, Ms: 9_000}, {Name: "pull x:" + own, Ms: 4_000}}}
	h := newHarness(t, func(c *Config) { c.Parts.BootTimes, c.Parts.BootPhases = drv, drv })
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureBootPhases}})
	acq := protocol.ClaimAcquireBody{
		ImageID: "img-acq", Expose: []protocol.Expose{}, RepoToken: own,
		Repos: []protocol.ClaimAcquireBodyReposItem{{Alias: "api", Repo: protocol.RepoRef{FullName: "acme/api"}, Sha: strings.Repeat("a", 40), RepoToken: other}},
	}
	c := claims.New("claim-1", acq, h.a.log, h.clk.Now())
	for _, phases := range [][]protocol.BootPhase{h.a.readyBody(c).Timing.Phases, h.a.bootPhases(c)} {
		if len(phases) != 2 {
			t.Fatalf("phases %+v", phases)
		}
		for _, p := range phases {
			if strings.Contains(p.Name, own) || strings.Contains(p.Name, other) {
				t.Fatalf("phase %q carries a download token", p.Name)
			}
		}
	}
}

// The customer's PR side took 22 minutes of which the named phases added up to
// under 4: the rest is a phase of its own, "not measured", so a part nobody
// timed (or one that got slow) is a number on the Run. A boot whose phases
// cover its time says nothing of the kind.
func TestTheBootSaysHowMuchOfItsTimeNoPhaseCovers(t *testing.T) {
	drv := bootPhaser{phases: []driver.BootPhase{{Name: "yarn install", Ms: 150_000}, {Name: "compose up", Ms: 78_000}}}
	h := newHarness(t, func(c *Config) { c.Parts.BootTimes, c.Parts.BootPhases = drv, drv })
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureBootPhases}})
	c := claims.New("claim-1", protocol.ClaimAcquireBody{ImageID: "img-acq", Expose: []protocol.Expose{}}, h.a.log, h.clk.Now())
	h.clk.Advance(22 * time.Minute)

	phases := h.a.bootPhases(c)
	if got := phases[0]; got.Name != PhaseNotMeasured || got.Ms != (22*time.Minute).Milliseconds()-228_000 {
		t.Fatalf("phases %+v: want %q first with the 22 min minus the 228 s named", phases, PhaseNotMeasured)
	}

	// Covered: nothing is left over.
	covered := bootPhaser{phases: []driver.BootPhase{{Name: "yarn install", Ms: 21 * 60_000}, {Name: "compose up", Ms: 60_000}}}
	h = newHarness(t, func(c *Config) { c.Parts.BootTimes, c.Parts.BootPhases = covered, covered })
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: []string{protocol.FeatureBootPhases}})
	c = claims.New("claim-1", protocol.ClaimAcquireBody{ImageID: "img-acq", Expose: []protocol.Expose{}}, h.a.log, h.clk.Now())
	h.clk.Advance(22 * time.Minute)
	for _, p := range h.a.bootPhases(c) {
		if p.Name == PhaseNotMeasured {
			t.Fatalf("a covered boot reports %+v", p)
		}
	}
}

// Phases that ran side by side add up to more than the boot took: the
// remainder is never negative.
func TestTheUnmeasuredRemainderIsNeverNegative(t *testing.T) {
	drv := bootPhaser{phases: []driver.BootPhase{{Name: "a", Ms: 90_000}, {Name: "b", Ms: 90_000, Running: true}}}
	h := newHarness(t, func(c *Config) { c.Parts.BootTimes, c.Parts.BootPhases = drv, drv })
	c := claims.New("claim-1", protocol.ClaimAcquireBody{ImageID: "img-acq", Expose: []protocol.Expose{}}, h.a.log, h.clk.Now())
	h.clk.Advance(2 * time.Minute)
	if p := h.a.unmeasured(c, drv.phases); p.Name != "" {
		t.Fatalf("overlapping phases left %+v", p)
	}
	h.clk.Advance(5 * time.Minute)
	if p := h.a.unmeasured(c, drv.phases); p.Name != PhaseNotMeasured || p.Ms != 7*60_000-180_000 {
		t.Fatalf("remainder %+v", p)
	}
}
