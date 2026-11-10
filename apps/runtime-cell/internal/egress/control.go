package egress

import (
	"crypto/ed25519"
	"net/http"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
)

// Control is the proxy's control port: the policy protocol (package
// control), the refusals as GET /v1/events and the counters as GET
// /metrics. Only the cell agent's group reaches it, with mTLS; there is no
// other route from the proxy to the agent.
type Control struct {
	Policies *policy.Store
	Events   *Events
	// Connections are the ones let through, as GET /v1/connections.
	Connections *Events
	AgentKey    ed25519.PublicKey
	Now         func() time.Time
	OnPolicy    func(policy.ClaimPolicy)
	OnDelete    func(claimID string)
	Metrics     *Metrics
}

func (c *Control) Handler() http.Handler {
	mux := http.NewServeMux()
	(&control.Server{Policies: c.Policies, AgentKey: c.AgentKey, Now: c.Now, OnPolicy: c.OnPolicy, OnDelete: c.OnDelete}).Register(mux)
	if c.Events != nil {
		mux.HandleFunc("GET /v1/events", c.Events.log.Handler())
	}
	if c.Connections != nil {
		mux.HandleFunc("GET /v1/connections", c.Connections.log.Handler())
	}
	if c.Metrics != nil {
		mux.Handle("GET /metrics", c.Metrics)
	}
	return mux
}
