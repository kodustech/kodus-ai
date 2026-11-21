package agent

import (
	"reflect"
	"slices"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// hello names every optional claim.acquire field this build decodes and the
// largest size its driver grants, so the hub sends only what the cell reads
// and routes a sized claim only to a cell whose maximum fits it. The frame
// passes the cell's own encoder (the hello schema).
func TestHelloAdvertisesFeaturesAndTheDriversMaxClaimSize(t *testing.T) {
	for name, c := range map[string]struct {
		max  driver.ClaimSize
		want *protocol.MachineSize
	}{
		"grants a size":             {driver.ClaimSize{MemoryMB: 16384, CPUs: 8}, &protocol.MachineSize{MemoryMb: 16384, Cpus: 8}},
		"grants none":               {driver.ClaimSize{}, nil},
		"below what a claim asks":   {driver.ClaimSize{MemoryMB: 256, CPUs: 2}, nil},
		"above the protocol limits": {driver.ClaimSize{MemoryMB: 1 << 20, CPUs: 128}, &protocol.MachineSize{MemoryMb: protocol.MaxMachineMemoryMB, Cpus: protocol.MaxMachineCPUs}},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, func(cfg *Config) { cfg.Driver.(*fake.Driver).MaxClaimSize = c.max })
			hello := h.a.Hello()
			if !reflect.DeepEqual(hello.Features, []string{
				protocol.FeatureSeedsCache, protocol.FeatureClaimSize, protocol.FeatureEgressAllow, protocol.FeaturePoolMachineSize, protocol.FeatureAuthoredFiles, protocol.FeatureReadyBuildSteps, protocol.FeatureBootPhases, protocol.FeatureCellMemory,
				protocol.FeatureTimedRequests, protocol.FeatureServiceLogs, protocol.FeatureDBEffects, protocol.FeatureOutboundCalls, protocol.FeatureExecCast, protocol.FeatureBrowser, protocol.FeatureCanaries, protocol.FeatureSecrets,
				protocol.FeatureReadyStart, protocol.FeatureTraceContext, protocol.FeatureEgressTiers, protocol.FeatureRunIdentity,
			}) {
				t.Fatalf("features %v", hello.Features)
			}
			if !reflect.DeepEqual(hello.MaxClaimSize, c.want) {
				t.Fatalf("maxClaimSize %+v, want %+v", hello.MaxClaimSize, c.want)
			}
			if _, err := protocol.Encode(protocol.Header{ID: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", CellID: "cell-1"}, hello); err != nil {
				t.Fatalf("the cell refuses to send its own hello: %v", err)
			}
		})
	}
}

// hello says what the cell's machines can be: the driver's isolation
// backends, the host's KVM and arch, nested containers, the largest size and
// the default one, so the hub can place a claim by the isolation it asks and
// record the vCPUs of a claim that asks no size. The frame passes
// the cell's own encoder.
func TestHelloAnnouncesTheBackendsAndTheHostTheMachinesRunOn(t *testing.T) {
	h := newHarness(t, func(cfg *Config) {
		d := cfg.Driver.(*fake.Driver)
		d.Isolation, d.Backends, d.KVM, d.HostArch = driver.IsolationSandboxedContainer, []string{"gvisor"}, true, "x86_64"
		d.MaxClaimSize = driver.ClaimSize{MemoryMB: 16384, CPUs: 8}
		d.DefaultClaimSize = driver.ClaimSize{MemoryMB: 4096, CPUs: 2}
	})
	hello := h.a.Hello()
	want := &protocol.HelloCapabilities{
		Backends: []string{"gvisor"}, NestedDocker: true, Kvm: true, Arch: protocol.MachineArchX8664,
		MaxSize: &protocol.MachineSize{MemoryMb: 16384, Cpus: 8}, DefaultSize: &protocol.MachineSize{MemoryMb: 4096, Cpus: 2},
	}
	if hello.Isolation != protocol.IsolationSandboxedContainer || !reflect.DeepEqual(hello.Capabilities, want) {
		t.Fatalf("isolation %q, capabilities %+v", hello.Isolation, hello.Capabilities)
	}
	if _, err := protocol.Encode(protocol.Header{ID: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", CellID: "cell-1"}, hello); err != nil {
		t.Fatalf("the cell refuses to send its own hello: %v", err)
	}
	// A driver that names no backend still sends the list, empty, and the cell's own arch.
	plain := newHarness(t).a.Hello().Capabilities
	if plain == nil || plain.Backends == nil || len(plain.Backends) != 0 || plain.Arch == "" {
		t.Fatalf("plain capabilities %+v", plain)
	}
}

// exercisedLines is named when the cell answers claim.exercised, whatever
// the count (an older hub's refusal trims the next hello: session.go), and
// never by a cell that does not; a trimmed hello leaves it out first.
func TestHelloNamesExercisedLinesOnlyWhenOnAndATrimmedHelloLeavesItOut(t *testing.T) {
	if got := newHarness(t, func(*Config) {}).a.Hello().Features; slices.Contains(got, protocol.FeatureExercisedLines) {
		t.Fatalf("named without the port: %v", got)
	}
	h := newHarness(t, func(cfg *Config) { cfg.ExercisedLines = true })
	got := h.a.Hello().Features
	if !slices.Contains(got, protocol.FeatureExercisedLines) {
		t.Fatalf("not named when on: %v", got)
	}
	limit := olderHubFeatureLimit
	olderHubFeatureLimit = len(got) - 1
	t.Cleanup(func() { olderHubFeatureLimit = limit })
	if trimmed := h.a.hello(true).Features; len(trimmed) != len(got)-1 || slices.Contains(trimmed, protocol.FeatureExercisedLines) {
		t.Fatalf("trimmed hello %v", trimmed)
	}
	if again := h.a.Hello().Features; !slices.Contains(again, protocol.FeatureExercisedLines) {
		t.Fatalf("an untrimmed hello lost it: %v", again)
	}
}

// bakeShare is named only by a cell whose driver pushes and pulls baked
// images (-gvisor-bake-share), and a hello trimmed for a hub older than the
// 64 features leaves it out with exercisedLines: that hub never sends
// sharedImages and never gets image.shared.
func TestHelloNamesBakeShareOnlyWhenTheDriverSharesAndATrimmedHelloLeavesItOut(t *testing.T) {
	if got := newHarness(t).a.Hello().Features; slices.Contains(got, protocol.FeatureBakeShare) {
		t.Fatalf("named by a driver that shares no bake: %v", got)
	}
	h := newHarness(t, func(cfg *Config) {
		cfg.ExercisedLines = true
		cfg.Driver.(*fake.Driver).ShareBakes = true
	})
	got := h.a.Hello().Features
	if !slices.Contains(got, protocol.FeatureBakeShare) {
		t.Fatalf("not named by a driver that shares: %v", got)
	}
	limit := olderHubFeatureLimit
	olderHubFeatureLimit = len(got) - 2
	t.Cleanup(func() { olderHubFeatureLimit = limit })
	if trimmed := h.a.hello(true).Features; len(trimmed) != len(got)-2 || slices.Contains(trimmed, protocol.FeatureBakeShare) || slices.Contains(trimmed, protocol.FeatureExercisedLines) {
		t.Fatalf("trimmed hello %v", trimmed)
	}
}

// A hello trimmed for a hub older than the 64 features always fits that
// hub's limit, however many features the cell names: it drops the newest
// ones (those such a hub never knew) until it does, never a fixed pair.
func TestATrimmedHelloAlwaysFitsTheOlderHubLimit(t *testing.T) {
	h := newHarness(t, func(cfg *Config) {
		cfg.ExercisedLines = true
		cfg.Driver.(*fake.Driver).ShareBakes = true
	})
	got := h.a.Hello().Features
	limit := olderHubFeatureLimit
	olderHubFeatureLimit = len(got) - 3
	t.Cleanup(func() { olderHubFeatureLimit = limit })
	trimmed := h.a.hello(true).Features
	if len(trimmed) > olderHubFeatureLimit {
		t.Fatalf("trimmed hello of %d features, over the limit %d: %v", len(trimmed), olderHubFeatureLimit, trimmed)
	}
	if want := got[:len(got)-3]; !slices.Equal(trimmed, want) {
		t.Fatalf("trimmed hello %v, want the oldest %v", trimmed, want)
	}
}

// Every feature the cell can name, and one more added after them, still
// trims to the real limit of an older hub.
func TestTrimForOlderHubFitsTheRealLimitWithEveryFeature(t *testing.T) {
	all := append(slices.Clone(protocol.CellFeatures), "aFeatureAddedLater")
	trimmed := trimForOlderHub(all, protocol.MaxHelloFeaturesOlderHub)
	if len(trimmed) > protocol.MaxHelloFeaturesOlderHub {
		t.Fatalf("trimmed to %d features, over %d", len(trimmed), protocol.MaxHelloFeaturesOlderHub)
	}
	if !slices.Equal(trimmed, all[:protocol.MaxHelloFeaturesOlderHub]) {
		t.Fatalf("trimmed %v, want the oldest %d", trimmed, protocol.MaxHelloFeaturesOlderHub)
	}
	if short := []string{"a", "b"}; !slices.Equal(trimForOlderHub(short, protocol.MaxHelloFeaturesOlderHub), short) {
		t.Fatal("a hello within the limit changed")
	}
}
