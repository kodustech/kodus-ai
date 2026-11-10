package agent

import (
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// readyBody is claim.ready: the claim is bound on the hub only once it
// reads this. The manifest is the driver's (Config.Manifests) when it knows
// what it booted, else the one claim.acquire implies.
func (a *Agent) readyBody(c *claims.Claim) *protocol.ClaimReadyBody {
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
// driver's boot phases when it measures them (Config.BootTimes).
func (a *Agent) readyTiming(c *claims.Claim) *protocol.ReadyTiming {
	end := c.BoundAt()
	if end.IsZero() {
		end = a.clock.Now()
	}
	t := &protocol.ReadyTiming{PrepareMs: 0}
	if !c.AcquiredAt.IsZero() && end.After(c.AcquiredAt) {
		t.PrepareMs = end.Sub(c.AcquiredAt).Milliseconds()
	}
	if a.cfg.BootTimes != nil {
		if b, ok := a.cfg.BootTimes.BootTiming(c.ID); ok {
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
