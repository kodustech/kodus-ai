package egress

import (
	"crypto/ed25519"
	"net/http"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
)

// Control is the proxy's control port: the policy protocol (package
// control), the refusals as GET /v1/events, its security alerts as GET
// /v1/alerts and the counters as GET /metrics. Only the cell agent's group reaches it, with mTLS; there is no
// other route from the proxy to the agent.
type Control struct {
	Policies *policy.Store
	Events   *Events
	// Connections are the ones let through, as GET /v1/connections.
	Connections *Events
	// Alerts are the proxy's security alerts (a placeholder over plain
	// HTTP), as GET /v1/alerts: the agent's feed, beside the injector's.
	Alerts   *Alerts
	AgentKey ed25519.PublicKey
	Now      func() time.Time
	// Enforceable refuses a policy the proxy cannot enforce as signed
	// (Proxy.Enforceable); nil takes every verified policy.
	Enforceable func(policy.ClaimPolicy) error
	OnPolicy    func(policy.ClaimPolicy)
	OnDelete    func(claimID string)
	Metrics     *Metrics
	// DenyFingerprint is the proxy's operator deny list
	// (netguard.DenyList.Fingerprint), on every push answer
	// (control.Server.DenyFingerprint).
	DenyFingerprint string
}

func (c *Control) Handler() http.Handler {
	mux := http.NewServeMux()
	(&control.Server{Policies: c.Policies, AgentKey: c.AgentKey, Now: c.Now, Enforceable: c.Enforceable, OnPolicy: c.OnPolicy, OnDelete: c.OnDelete, DenyFingerprint: c.DenyFingerprint}).Register(mux)
	if c.Events != nil {
		mux.HandleFunc("GET /v1/events", c.Events.log.Handler())
	}
	if c.Connections != nil {
		mux.HandleFunc("GET /v1/connections", c.Connections.log.Handler())
	}
	if c.Alerts != nil {
		mux.HandleFunc("GET /v1/alerts", c.Alerts.Handler())
	}
	if c.Metrics != nil {
		mux.Handle("GET /metrics", c.Metrics)
	}
	return mux
}
