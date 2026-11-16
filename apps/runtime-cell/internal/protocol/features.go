package protocol

import "slices"

// Hello features: CellFeatures and HubAcceptedFeatures (constants_gen.go,
// from CELL_FEATURES and HUB_ACCEPTED_FEATURES in
// libs/runtime/protocol/messages.ts). The hub leaves out of claim.acquire
// every field the cell did not name, so a newer hub never sends a field this
// build's strict decoder refuses. The other way, the cell sends a field of
// HubAcceptedFeatures only when the hub's hello ack names the feature in
// accepts, so an older hub's strict decoder never sees it.

// cellSent are the features whose fields this cell sends, so only an ack's
// accepts can turn them on.
var cellSent = setOf(HubAcceptedFeatures)

// setOf is a generated list as a set.
func setOf(list []string) map[string]bool {
	out := make(map[string]bool, len(list))
	for _, s := range list {
		out[s] = true
	}
	return out
}

// Features lists what this build understands: optional claim.acquire fields,
// recipe execution semantics, and outgoing fields a hub may accept. The agent
// filters execution features whose runtime ports are not enabled before hello.
func Features() []string {
	return slices.Clone(CellFeatures)
}

// Accepted is the set of features a hello ack accepts, of those this build
// sends: an ack without accepts (an older hub) accepts none.
func Accepted(ack *AckBody) map[string]bool {
	out := map[string]bool{}
	if ack == nil {
		return out
	}
	for _, f := range ack.Accepts {
		if cellSent[f] {
			out[f] = true
		}
	}
	return out
}

// The machine sizes a claim may ask are MACHINE_SIZE_LIMITS
// (MinMachineMemoryMB..MaxMachineCPUs in constants_gen.go), which bound both
// claim.acquire size and hello maxClaimSize. A cell whose driver grants more
// advertises the maximum: no claim asks above it, and a larger number would
// not pass the hello schema.

// MaxClaimSize is the hello maxClaimSize for a driver that grants memoryMB
// and cpus at most: clamped to the protocol's maximum, nil when the driver
// grants no size a claim could ask (below the protocol's minimum).
func MaxClaimSize(memoryMB, cpus int64) *MachineSize {
	if memoryMB < MinMachineMemoryMB || cpus < MinMachineCPUs {
		return nil
	}
	return &MachineSize{MemoryMb: min(memoryMB, MaxMachineMemoryMB), Cpus: min(cpus, MaxMachineCPUs)}
}
