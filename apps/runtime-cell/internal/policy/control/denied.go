package control

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"time"
)

// Denial is one name the egress refused a claim: at the proxy (the host and
// port it dialled) or at the resolver (port 53: the name never got an
// address, so where the app meant to connect is unknown).
type Denial struct {
	Host string
	Port int
	At   time.Time
	// Platform: the platform deny list refused it; no approval lifts it.
	Platform bool
}

// DeniedReader reads what the egress proxy (GET /v1/events) and the cell
// resolver (GET /v1/queries) refused a claim, for the failure bundle: the
// product's catalog turns a denied host into "approve this host". One entry
// per host, the first refusal, oldest first.
type DeniedReader struct {
	Endpoints []Endpoint
	HTTP      *http.Client
}

// maxDeniedBody bounds what one endpoint may answer (its logs are bounded
// too: 10 000 events, the claim's last queries).
const maxDeniedBody = 8 << 20

func (r DeniedReader) Denied(ctx context.Context, claimID string) ([]Denial, error) {
	seen := map[string]bool{}
	var out []Denial
	add := func(host string, port int, at time.Time, platform bool) {
		if host == "" || seen[host] {
			return
		}
		seen[host] = true
		out = append(out, Denial{Host: host, Port: port, At: at, Platform: platform})
	}
	var firstErr error
	if u := URL(r.Endpoints, EndpointEgress); u != "" {
		var events []struct {
			ClaimID string    `json:"claimId"`
			Host    string    `json:"host"`
			Port    int       `json:"port"`
			Reason  string    `json:"reason"`
			At      time.Time `json:"at"`
		}
		if err := r.get(ctx, u+"/v1/events?after=0", &events); err != nil {
			firstErr = err
		}
		for _, e := range events {
			// What the claim's allowlist refused (a person can approve it) and
			// what the platform deny list refused ("denied": no approval lifts it).
			if e.ClaimID == claimID && (e.Reason == "not_allowed" || e.Reason == "denied") {
				add(e.Host, e.Port, e.At, e.Reason == "denied")
			}
		}
	}
	if u := URL(r.Endpoints, EndpointResolver); u != "" {
		var queries []struct {
			Name     string    `json:"name"`
			Denied   bool      `json:"denied"`
			Platform bool      `json:"platform"`
			At       time.Time `json:"at"`
		}
		if err := r.get(ctx, u+"/v1/queries?claim="+url.QueryEscape(claimID), &queries); err != nil && firstErr == nil {
			firstErr = err
		}
		for _, q := range queries {
			if q.Denied || q.Platform {
				add(q.Name, 53, q.At, q.Platform)
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	return out, firstErr
}

func (r DeniedReader) get(ctx context.Context, u string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	resp, err := r.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("control: GET %s: %s", req.URL.Path, resp.Status)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, maxDeniedBody)).Decode(into)
}
