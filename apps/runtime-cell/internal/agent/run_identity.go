package agent

import (
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// claimIdentity is the env of a Run's drawn identifiers (claim.acquire
// identity, S-36): its hostname, seed user and seed domain under the
// protocol's names, so a recipe's seed and the app read the Run's values
// and a PR cannot pin the ones its probes use. Never a setup's: a setup's
// workload may become the environment's image, and a Run's values baked in
// it would be every later Run's. Nil without them.
func claimIdentity(acq protocol.ClaimAcquireBody) (env map[string]string, hostname string) {
	id := acq.Identity
	if acq.Consumer == protocol.ConsumerSetup || id == nil {
		return nil, ""
	}
	return map[string]string{
		protocol.RunIdentityHostnameEnv: id.Hostname,
		protocol.RunIdentityUserEnv:     id.User,
		protocol.RunIdentityDomainEnv:   id.Domain,
	}, id.Hostname
}
