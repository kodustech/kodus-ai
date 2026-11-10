package agent

import (
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// claimCanaries are the Run's decoys a claim plants (claim.acquire
// canaries, ADR-043). Never a setup's: what a setup's workload holds may
// become the environment's (a bake), and a decoy in a baked image or volume
// would reach every later claim. They live in the claim's acquire only,
// never in a log, a tag or a frame the cell sends.
func claimCanaries(acq protocol.ClaimAcquireBody) []driver.Canary {
	if acq.Consumer == protocol.ConsumerSetup || len(acq.Canaries) == 0 {
		return nil
	}
	out := make([]driver.Canary, 0, len(acq.Canaries))
	for _, c := range acq.Canaries {
		out = append(out, driver.Canary{Slot: string(c.Slot), Value: c.Value})
	}
	return out
}
