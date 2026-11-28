package agent

import (
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// readyBody is claim.ready: the claim is bound on the hub only once it
// reads this. The manifest is the driver's (Config.Manifests) when it knows
// what it booted, else the one claim.acquire implies. start (cold, pool or
// bake) goes only to a hub that accepts it: an older hub's strict decoder
// refuses the field.
func (a *Agent) readyBody(c *claims.Claim) *protocol.ClaimReadyBody {
	if isSandbox(c) {
		return a.sandboxReadyBody(c)
	}
	body := a.workloadReadyBody(c)
	if start := protocol.ClaimReadyBodyStart(c.Start()); start != "" && a.hubAccepts(protocol.FeatureReadyStart) {
		body.Start = &start
	}
	return body
}

func (a *Agent) workloadReadyBody(c *claims.Claim) *protocol.ClaimReadyBody {
	m := c.Machines()
	observer := protocol.ObserverState{ID: m.Observer.MachineID, State: protocol.ObserverPhaseReady}
	if a.cfg.Manifests != nil {
		if man, ok := a.cfg.Manifests.Manifest(c.ID); ok {
			if man.Services == nil {
				man.Services = []protocol.ManifestService{}
			}
			if man.Expose == nil {
				man.Expose = []protocol.Expose{}
			}
			if man.ImageID == "" {
				man.ImageID = m.Workload.ImageID
			}
			if man.ImageID == "" {
				man.ImageID = c.Acquire.ImageID
			}
			if man.SeedSha == "" {
				man.SeedSha = "unknown"
			}
			return &protocol.ClaimReadyBody{Manifest: man, Observer: observer, Timing: a.readyTiming(c)}
		}
	}
	acq := c.Acquire
	expose := acq.Expose
	if expose == nil {
		expose = []protocol.Expose{}
	}
	services := []protocol.ManifestService{}
	seen := map[string]bool{}
	for _, e := range expose {
		if seen[e.Service] || len(services) == 64 {
			continue
		}
		seen[e.Service] = true
		services = append(services, protocol.ManifestService{Name: e.Service, Health: protocol.ServiceHealthOk})
	}
	image := m.Workload.ImageID
	if image == "" {
		image = acq.ImageID
	}
	return &protocol.ClaimReadyBody{
		Manifest: protocol.Manifest{Services: services, Expose: expose, ImageID: image, SeedSha: "unknown"},
		Observer: observer,
		Timing:   a.readyTiming(c),
	}
}

// readyTiming is claim.ready.timing: the agent's prepare time, plus the
// driver's boot phases when it measures them (Config.Parts.BootTimes).
func (a *Agent) readyTiming(c *claims.Claim) *protocol.ReadyTiming {
	end := c.BoundAt()
	if end.IsZero() {
		end = a.clock.Now()
	}
	t := &protocol.ReadyTiming{PrepareMs: 0}
	if !c.AcquiredAt.IsZero() && end.After(c.AcquiredAt) {
		t.PrepareMs = end.Sub(c.AcquiredAt).Milliseconds()
	}
	t.Phases = a.bootPhases(c)
	if a.cfg.Parts.BootTimes != nil {
		if b, ok := a.cfg.Parts.BootTimes.BootTiming(c.ID); ok {
			t.BootMs, t.BuildMs, t.UpMs, t.SeedMs, t.ReadyMs = &b.TotalMs, &b.BuildMs, &b.UpMs, &b.SeedMs, &b.ReadyMs
			if b.SnapshotMs > 0 {
				t.SnapshotMs = &b.SnapshotMs // only when the boot took one: absent is "no snapshot", not 0 ms
			}
			// Only to a hub that accepts it: an older hub's strict decoder refuses the field.
			if b.BuildSteps != nil && a.hubAccepts(protocol.FeatureReadyBuildSteps) {
				t.BuildSteps = readyBuildSteps(*b.BuildSteps)
			}
		}
	}
	return t
}

// Bounds of claim.ready timing.buildSteps (the protocol schema's).
const (
	maxReadyStepCount = 100_000
	maxReadySlowest   = 8
)

// readyBuildSteps is a boot's build steps as claim.ready carries them,
// within the schema's bounds.
func readyBuildSteps(s driver.BuildSteps) *protocol.ReadyTimingBuildSteps {
	count := func(n int) int64 { return int64(min(max(n, 0), maxReadyStepCount)) }
	out := &protocol.ReadyTimingBuildSteps{Steps: count(s.Steps), Done: count(s.Done), Cached: count(s.Cached), Errored: count(s.Errored), Slowest: []protocol.ReadyTimingBuildStepsSlowestItem{}}
	for _, st := range s.Slowest {
		if len(out.Slowest) == maxReadySlowest || st.Service == "" || st.Name == "" {
			continue
		}
		out.Slowest = append(out.Slowest, protocol.ReadyTimingBuildStepsSlowestItem{Service: st.Service, Name: st.Name, Ms: max(st.Ms, 0)})
	}
	return out
}

// bootPhases is where the claim's boot spent its time, in words, for a hub
// that accepts it (claim.ready timing.phases, claim.failed phases): the
// driver's phases of the boot (its builds, moving the image into Docker,
// compose up, the first healthy answer) and the agent's own (fetch, upload,
// the recipe's steps), slowest first, at most driver.MaxPhases. The agent's
// compose phase is the driver's boot whole: left out when the driver split it.
func (a *Agent) bootPhases(c *claims.Claim) []protocol.BootPhase {
	if !a.hubAccepts(protocol.FeatureBootPhases) {
		return nil
	}
	var booted []driver.BootPhase
	if p := a.cfg.Parts.BootPhases; p != nil {
		booted, _ = p.BootPhases(c.ID)
	}
	var own []driver.BootPhase
	for _, ph := range c.PrepPhases() {
		if ph.Name == "compose" && len(booted) > 0 {
			continue
		}
		if label, ok := prepPhaseLabels[ph.Name]; ok {
			ph.Name = label
		}
		own = append(own, ph)
	}
	all := driver.MergePhases(-1, booted, own)
	if rest := a.unmeasured(c, all); rest.Ms > 0 {
		all = driver.MergePhases(-1, all, []driver.BootPhase{rest})
	}
	return protocolPhases(driver.MergePhases(driver.MaxPhases, all), a.claimRedactor(c))
}

// PhaseNotMeasured is the part of a claim's preparation that no phase
// covers: its time, minus every phase's. It is a phase of its own so the Run
// shows it; a regression (a step nobody timed, or one that got slow) is then
// a number on the page, not a gap.
const PhaseNotMeasured = "not measured"

// minUnmeasured is the remainder below which nothing is said: a few
// milliseconds between steps are not a step nobody timed.
const minUnmeasured = time.Second

// unmeasured is the claim's preparation time (from its acquire to its bound,
// or to now while it runs) minus the sum of all its phases (one still running
// counts until now, as it does in the phase). Phases that ran
// side by side (BuildKit's steps) add up to more than the wall time, so this
// is a lower bound on the time outside every phase; never negative.
func (a *Agent) unmeasured(c *claims.Claim, phases []driver.BootPhase) driver.BootPhase {
	if c.AcquiredAt.IsZero() {
		return driver.BootPhase{}
	}
	end := c.BoundAt()
	if end.IsZero() {
		end = a.clock.Now()
	}
	rest := end.Sub(c.AcquiredAt)
	for _, p := range phases {
		rest -= time.Duration(p.Ms) * time.Millisecond
	}
	if rest < minUnmeasured {
		return driver.BootPhase{}
	}
	return driver.BootPhase{Name: PhaseNotMeasured, Ms: rest.Milliseconds()}
}

// protocolPhases are phases as the protocol carries them, within its bounds.
// A name comes from what a build printed (BuildKit names a step with the
// build's arguments in it), so it is redacted with the claim's own values
// (r) before it is cut, as every line the claim sends is.
func protocolPhases(merged []driver.BootPhase, r *redact.Redactor) []protocol.BootPhase {
	return redactPhases(r, bootPhasesToProtocol(merged))
}

// bootPhasesToProtocol is the phases as a frame carries them, not yet
// redacted.
func bootPhasesToProtocol(merged []driver.BootPhase) []protocol.BootPhase {
	if len(merged) == 0 {
		return nil
	}
	out := make([]protocol.BootPhase, 0, len(merged))
	for _, ph := range merged {
		bp := protocol.BootPhase{Name: ph.Name, Ms: ph.Ms}
		if ph.Running {
			bp.Running = new(true)
		}
		out = append(out, bp)
	}
	return out
}

// redactPhases masks and bounds each phase's name (BuildKit's step names
// carry the build's arguments); a phase left with no name is dropped.
func redactPhases(r *redact.Redactor, phases []protocol.BootPhase) []protocol.BootPhase {
	if len(phases) == 0 {
		return nil
	}
	out := make([]protocol.BootPhase, 0, len(phases))
	for _, ph := range phases {
		ph.Name, _ = r.String(ph.Name)
		ph.Name, _ = redact.Clip(ph.Name, maxPhaseName)
		if ph.Name == "" {
			continue
		}
		out = append(out, ph)
	}
	return out
}

// prepPhaseLabels name the agent's phases as the product shows them.
var prepPhaseLabels = map[string]string{
	"network": "claim network", "machines": "start machines", "fetch": "fetch code", "upload": "upload code",
	"compose": "boot", "egress": "egress policy", "recipe": "recipe steps", "sql_observer": "observer database",
}

// maxPhaseName is the protocol's bound on a phase's name (BootPhasesSchema).
const maxPhaseName = 48
