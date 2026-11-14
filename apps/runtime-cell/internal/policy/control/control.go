// Package control is the policy control protocol between the cell agent and
// the data-plane components that enforce a claim's policy (the egress
// proxy, the resolver, the credential injector). Each component serves it
// on its control port, behind mTLS: signed policies come in, signed removals
// drop them. The agent's side is Pusher.
package control

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

const (
	// SignatureHeader carries the agent's signature over a removal.
	SignatureHeader = "X-Kodus-Signature"
	// SignedAtHeader is the unix time the removal was signed at.
	SignedAtHeader = "X-Kodus-Signed-At"
	// MaxRemovalSkew is how far a removal's signing time may be from now.
	MaxRemovalSkew = 5 * time.Minute
	// maxPolicyBytes fits a large go.sum's pins (ClaimPolicy.GoPins: a few
	// thousand module@version); the policy is signed and sent over mTLS.
	maxPolicyBytes = 2 << 20
)

func removalMessage(claimID string, at int64) []byte {
	return []byte("delete:" + claimID + ":" + strconv.FormatInt(at, 10))
}

// SignRemoval is what the agent sends to drop a claim's policy: the
// signature and the time it signed at.
func SignRemoval(key ed25519.PrivateKey, claimID string, at time.Time) (signature, signedAt string) {
	ts := at.Unix()
	return base64.StdEncoding.EncodeToString(ed25519.Sign(key, removalMessage(claimID, ts))), strconv.FormatInt(ts, 10)
}

// Server serves PUT /v1/policy and DELETE /v1/policy/{claim}.
type Server struct {
	Policies *policy.Store
	AgentKey ed25519.PublicKey
	Now      func() time.Time
	// DurableDelete durably revokes credentials held for a verified removal.
	// Only the injector wires it; other policy consumers need no vault.
	// Memory policy and connection callbacks are dropped first; failure never
	// keeps authority live, but returns 503 instead of claiming durability.
	DurableDelete func(context.Context, string) error
	// OnPolicy and OnDelete run after the store changed: the proxy
	// re-checks the claim's live connections, the resolver drops its
	// answers.
	OnPolicy func(policy.ClaimPolicy)
	OnDelete func(claimID string)
}

func (s *Server) now() time.Time {
	if s.Now == nil {
		return time.Now()
	}
	return s.Now()
}

// Register adds the policy routes to mux.
func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc("PUT /v1/policy", s.put)
	mux.HandleFunc("DELETE /v1/policy/{claim}", s.remove)
}

// Handler is a mux with only the policy routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	s.Register(mux)
	return mux
}

func (s *Server) put(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxPolicyBytes))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var signed policy.Signed
	if err := json.Unmarshal(raw, &signed); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	p, err := policy.Verify(s.AgentKey, signed, s.now())
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, policy.ErrBadSignature) {
			code = http.StatusForbidden
		}
		http.Error(w, err.Error(), code)
		return
	}
	if err := s.Policies.Put(p); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	if s.OnPolicy != nil {
		s.OnPolicy(p)
	}
	w.WriteHeader(http.StatusNoContent)
}

// remove drops a claim. Deleting only narrows egress, but it is still the
// agent's call: the request is signed for this claim at a recent time.
func (s *Server) remove(w http.ResponseWriter, r *http.Request) {
	claim := r.PathValue("claim")
	at, err := strconv.ParseInt(r.Header.Get(SignedAtHeader), 10, 64)
	sig, derr := base64.StdEncoding.DecodeString(r.Header.Get(SignatureHeader))
	if err != nil || derr != nil || !ed25519.Verify(s.AgentKey, removalMessage(claim, at), sig) {
		http.Error(w, "bad signature", http.StatusForbidden)
		return
	}
	if d := s.now().Sub(time.Unix(at, 0)); d > MaxRemovalSkew || d < -MaxRemovalSkew {
		http.Error(w, "removal signed too long ago", http.StatusForbidden)
		return
	}
	s.Policies.Delete(claim)
	if s.OnDelete != nil {
		s.OnDelete(claim)
	}
	if s.DurableDelete != nil && s.DurableDelete(r.Context(), claim) != nil {
		http.Error(w, "policy removal unavailable", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// The components that enforce a claim's policy, by the name the cell's
// -egress-control flag gives them.
const (
	EndpointEgress   = "egress"
	EndpointResolver = "resolver"
	EndpointInjector = "injector"
)

// RequiredEndpoints are the components every claim's policy goes to: a
// policy the injector never got leaves the claim's credentials unguarded.
var RequiredEndpoints = []string{EndpointEgress, EndpointResolver, EndpointInjector}

// Endpoint is one component's control URL.
type Endpoint struct {
	Name string
	URL  string
}

// ParseEndpoints reads "egress=https://h:9443,resolver=https://h:9444,
// injector=https://h:9445": every name once, each of required present, each
// URL https.
func ParseEndpoints(s string, required ...string) ([]Endpoint, error) {
	var out []Endpoint
	seen := map[string]bool{}
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, raw, ok := strings.Cut(part, "=")
		if !ok || name == "" {
			return nil, fmt.Errorf("control: %q is not name=url", part)
		}
		if seen[name] {
			return nil, fmt.Errorf("control: endpoint %s given twice", name)
		}
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return nil, fmt.Errorf("control: endpoint %s: %q is not https://host:port", name, raw)
		}
		seen[name] = true
		out = append(out, Endpoint{Name: name, URL: strings.TrimRight(raw, "/")})
	}
	for _, r := range required {
		if !seen[r] {
			return nil, fmt.Errorf("control: no %s endpoint (want %s)", r, strings.Join(required, ", "))
		}
	}
	return out, nil
}

// URL is the named endpoint's URL ("" when absent).
func URL(eps []Endpoint, name string) string {
	for _, e := range eps {
		if e.Name == name {
			return e.URL
		}
	}
	return ""
}

// Pusher is the agent's side: it signs each claim's policy and pushes it to
// every endpoint (the proxy's, the resolver's, the injector's control URL).
type Pusher struct {
	Endpoints []Endpoint
	HTTP      *http.Client
	Key       ed25519.PrivateKey
	Now       func() time.Time
}

func (c Pusher) now() time.Time {
	if c.Now == nil {
		return time.Now()
	}
	return c.Now()
}

func (c Pusher) Push(ctx context.Context, p policy.ClaimPolicy) error {
	s, err := policy.Sign(c.Key, p)
	if err != nil {
		return err
	}
	body, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return c.each(ctx, func(ep Endpoint) (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodPut, ep.URL+"/v1/policy", bytes.NewReader(body))
	})
}

func (c Pusher) Remove(ctx context.Context, claimID string) error {
	sig, at := SignRemoval(c.Key, claimID, c.now())
	return c.each(ctx, func(ep Endpoint) (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodDelete, ep.URL+"/v1/policy/"+url.PathEscape(claimID), nil)
		if err == nil {
			req.Header.Set(SignatureHeader, sig)
			req.Header.Set(SignedAtHeader, at)
		}
		return req, err
	})
}

// each sends one request per endpoint; every endpoint that did not answer
// 204 is in the error, by name.
func (c Pusher) each(ctx context.Context, build func(ep Endpoint) (*http.Request, error)) error {
	if len(c.Endpoints) == 0 {
		return errors.New("control: no endpoints")
	}
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	var errs []error
	for _, ep := range c.Endpoints {
		req, err := build(ep)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", ep.Name, err))
			continue
		}
		resp, err := hc.Do(req)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", ep.Name, err))
			continue
		}
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			errs = append(errs, fmt.Errorf("%s: status %d: %s", ep.Name, resp.StatusCode, bytes.TrimSpace(msg)))
		}
	}
	return errors.Join(errs...)
}
