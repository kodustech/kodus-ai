package agent

import (
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/pool"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/provenance"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// latestImage in pool.target and claim.acquire is the environment's last
// bake in this cell.
const latestImage = provenance.LatestImage

// poolRequest is what the claim asks of the warm pool: a setup never starts
// from a pool machine, and any other claim takes only a machine of its
// environment, image, size and ceiling.
func poolRequest(acq protocol.ClaimAcquireBody, hard time.Time) pool.Request {
	image := acq.ImageID
	if image == latestImage {
		image = "" // the environment's current one
	}
	return pool.Request{
		OrgID: acq.OrgID, EnvironmentID: acq.EnvironmentID, ImageID: image,
		Setup: acq.Consumer == protocol.ConsumerSetup, Size: claimSize(acq), HardExpiresAt: hard,
	}
}

// takePoolMachine hands the claim a ready pool machine, when one fits.
func (a *Agent) takePoolMachine(acq protocol.ClaimAcquireBody, hard time.Time) (driver.PoolMachine, bool) {
	return a.pool.Take(poolRequest(acq, hard))
}

// hasPoolMachine reports whether takePoolMachine would find one now.
func (a *Agent) hasPoolMachine(acq protocol.ClaimAcquireBody, hard time.Time) bool {
	return a.pool.Has(poolRequest(acq, hard))
}
