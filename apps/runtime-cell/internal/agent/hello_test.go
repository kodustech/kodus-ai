package agent

import (
	"reflect"
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
