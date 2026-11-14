package protocol

// Hello features (CELL_FEATURES in libs/runtime/protocol/messages.ts): the
// optional claim.acquire fields and recipe execution semantics this cell
// supports. The hub leaves out of claim.acquire every field the cell did not
// name, so a newer hub never
// sends a field this build's strict decoder refuses.
//
// One goes the other way (HUB_ACCEPTED_FEATURES): an optional field this
// cell may send. It sends it only when the hub's hello ack names the feature
// in accepts, so an older hub's strict decoder never sees it.
const (
	// FeatureSeedsCache is claim.acquire seedsCache.
	FeatureSeedsCache = "seedsCache"
	// FeatureClaimSize is claim.acquire size.
	FeatureClaimSize = "claimSize"
	// FeatureEgressAllow is claim.acquire egressAllow.
	FeatureEgressAllow = "egressAllow"
	// FeaturePoolMachineSize is pool.target machineSize.
	FeaturePoolMachineSize = "poolMachineSize"
	// FeatureAuthoredFiles is claim.acquire recipe.files: this build writes
	// them into the checkout (agent.writeAuthoredFiles) before it boots.
	FeatureAuthoredFiles = "authoredFiles"
	// FeatureReadyBuildSteps is claim.ready timing.buildSteps, sent only to a
	// hub whose hello ack accepts it (Accepted).
	FeatureReadyBuildSteps = "readyBuildSteps"
	// FeatureCellMemory is heartbeat memory (ADR-070): what the cell may
	// commit to claims and what it has committed, sent only to a hub whose
	// hello ack accepts it.
	FeatureCellMemory = "cellMemory"

	// The evidence a cell captures around a step (EVIDENCE-CAPTURE-DESIGN).
	// Both ways: the hub sends probe.run/exec evidence (what to capture, the
	// upload grants) only to a cell that names the feature, and the cell
	// sends the result's field only to a hub that accepts it.
	//
	// FeatureTimedRequests is probe requests[].at.
	FeatureTimedRequests = "timedRequests"
	// FeatureServiceLogs is probe evidence.logs and the logs upload.
	FeatureServiceLogs = "serviceLogs"
	// FeatureDBEffects is probe evidence.db and the db upload.
	FeatureDBEffects = "dbEffects"
	// FeatureOutboundCalls is probe evidence.outbound.
	FeatureOutboundCalls = "outboundCalls"
	// FeatureExecCast is exec refs (the cast upload).
	FeatureExecCast = "execCast"
	// FeatureBrowser is browser probes in the cell's browser runner (ADR-071):
	// the browser capture, its grants and baseline in probe.run, and
	// probe.browser steps, pixels, network and console in the result.
	FeatureBrowser = "browser"
	// FeatureCanaries is claim.acquire canaries: the Run's decoys, which the
	// cell plants in the workload (ADR-043) and never sends back.
	FeatureCanaries = "canaries"
	// FeatureBrowserExplore is local native exploration, separate from replay.
	FeatureBrowserExplore = "browserExplore"
	// Recipe execution semantics; advertised only when their runtime ports are enabled.
	FeatureRecipeFakes = "recipeFakes"
	FeatureSeededSQL   = "seededSQL"
)

// cellSent are the features whose fields this cell sends, so only an ack's
// accepts can turn them on.
var cellSent = map[string]bool{
	FeatureReadyBuildSteps: true,
	FeatureCellMemory:      true,
	FeatureTimedRequests:   true,
	FeatureServiceLogs:     true,
	FeatureDBEffects:       true,
	FeatureOutboundCalls:   true,
	FeatureExecCast:        true,
	FeatureBrowser:         true,
	FeatureBrowserExplore:  true,
}

// Features lists what this build understands: optional claim.acquire fields,
// recipe execution semantics, and outgoing fields a hub may accept. The agent
// filters execution features whose runtime ports are not enabled before hello.
func Features() []string {
	return []string{
		FeatureSeedsCache, FeatureClaimSize, FeatureEgressAllow, FeaturePoolMachineSize, FeatureAuthoredFiles, FeatureReadyBuildSteps, FeatureCellMemory,
		FeatureTimedRequests, FeatureServiceLogs, FeatureDBEffects, FeatureOutboundCalls, FeatureExecCast, FeatureBrowser, FeatureCanaries, FeatureBrowserExplore, FeatureRecipeFakes, FeatureSeededSQL,
	}
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

// The machine sizes a claim may ask (MACHINE_SIZE_LIMITS, which bounds
// both claim.acquire size and hello maxClaimSize). A cell whose driver
// grants more advertises the maximum: no claim asks above it, and a larger
// number would not pass the hello schema.
const (
	MinMachineMemoryMB = 512
	MaxMachineMemoryMB = 262_144
	MinMachineCPUs     = 1
	MaxMachineCPUs     = 64
)

// MaxClaimSize is the hello maxClaimSize for a driver that grants memoryMB
// and cpus at most: clamped to the protocol's maximum, nil when the driver
// grants no size a claim could ask (below the protocol's minimum).
func MaxClaimSize(memoryMB, cpus int64) *MachineSize {
	if memoryMB < MinMachineMemoryMB || cpus < MinMachineCPUs {
		return nil
	}
	return &MachineSize{MemoryMb: min(memoryMB, MaxMachineMemoryMB), Cpus: min(cpus, MaxMachineCPUs)}
}
