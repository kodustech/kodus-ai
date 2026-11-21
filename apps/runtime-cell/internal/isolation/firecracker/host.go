package firecracker

import "github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hostcheck"

// Host policies (Config.HostPolicy): the shared ones (internal/hostcheck).
const (
	HostShared    = hostcheck.Shared
	HostDedicated = hostcheck.Dedicated
)

// HostState is what the cell found of its host (hostcheck.State).
type HostState = hostcheck.State

// ProbeHost reads the host under root with the backend's checks.
func ProbeHost(c *Checks, root, policy string) HostState {
	if c == nil {
		c = defaultChecks()
	}
	return hostcheck.Probe(c.ReadFile, root, policy)
}
