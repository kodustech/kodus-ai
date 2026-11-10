package control

import (
	"context"
	"net/http"
	"sort"
	"time"
)

// OutboundCall is one connection a claim's machines made through the egress
// proxy: let through (Allowed) or refused.
type OutboundCall struct {
	Host    string
	Port    int
	At      time.Time
	Allowed bool
}

// OutboundReader reads the egress proxy's connections (GET /v1/connections)
// and refusals (GET /v1/events) of one claim in a window, for a probe
// round's outbound evidence (EVIDENCE-CAPTURE-DESIGN). A proxy without the
// connections log answers refusals only.
type OutboundReader struct {
	Endpoints []Endpoint
	HTTP      *http.Client
}

// Outbound returns the claim's calls in [since, until], oldest first.
func (r OutboundReader) Outbound(ctx context.Context, claimID string, since, until time.Time) ([]OutboundCall, error) {
	u := URL(r.Endpoints, EndpointEgress)
	if u == "" {
		return nil, nil
	}
	type event struct {
		ClaimID string    `json:"claimId"`
		Host    string    `json:"host"`
		Port    int       `json:"port"`
		Reason  string    `json:"reason"`
		At      time.Time `json:"at"`
	}
	get := DeniedReader(r).get
	var out []OutboundCall
	in := func(e event) bool {
		return e.ClaimID == claimID && e.Host != "" && !e.At.Before(since) && !e.At.After(until)
	}
	var refused []event
	err := get(ctx, u+"/v1/events?after=0", &refused)
	for _, e := range refused {
		if in(e) {
			out = append(out, OutboundCall{Host: e.Host, Port: e.Port, At: e.At})
		}
	}
	var allowed []event
	if aerr := get(ctx, u+"/v1/connections?after=0", &allowed); aerr != nil && err == nil {
		err = aerr
	}
	for _, e := range allowed {
		if in(e) && e.Reason == "allowed" {
			out = append(out, OutboundCall{Host: e.Host, Port: e.Port, At: e.At, Allowed: true})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	return out, err
}
