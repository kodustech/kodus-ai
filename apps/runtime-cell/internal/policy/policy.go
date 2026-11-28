// Package policy is the per-claim egress policy the cell agent signs and the
// proxy and resolver verify (docs/runtime/egress-allowlist.md, ADR-040, ADR-056).
// The proxy and the resolver hold no credential; they hold the agent's
// public key and nothing else.
package policy

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

type Phase string

const (
	PhaseBuild Phase = "build"
	PhaseTest  Phase = "test"
)

// AppHost is the name the observer and the VM use for the claim's app.
const AppHost = "app.kody.internal"

// MirrorHost is the cell's registry mirror as the VM names it; the
// resolver answers it with the egress address on the claim's network.
const MirrorHost = "mirror.cell.internal"

type ClaimPolicy struct {
	ClaimID string `json:"claimId"`
	OrgID   string `json:"orgId"`
	// Optional for legacy egress policies; credentials require an exact environment.
	EnvironmentID string `json:"environmentId,omitempty"`
	// Sources are the private addresses of the claim's machines; the proxy
	// and the resolver find the claim by the packet's source.
	Sources []string `json:"sources"`
	// Allow holds exact host names. No wildcards.
	Allow []string `json:"allow"`
	// CredentialHosts are the exact hosts with a declared credential (Inc.
	// 5): the proxy sends them to the injector, never straight out.
	CredentialHosts []string `json:"credentialHosts,omitempty"`
	// AppAddress answers app.kody.internal for this claim.
	AppAddress string `json:"appAddress,omitempty"`
	// SteerTo, on a claim network with no route out (docker-gvisor), is the
	// proxy's address on that network: the resolver answers every allowed
	// name with it, and the proxy dials the name itself after checking it.
	// Empty: the resolver answers real addresses and the network routes to
	// the proxy.
	SteerTo string `json:"steerTo,omitempty"`
	// GoPins are the module@version pairs the checkout's go.sum pins,
	// sorted: the claim's whole Go allowlist at the mirror.
	GoPins []string `json:"goPins,omitempty"`
	// ImagePins are the Docker Hub images the checkout's Dockerfiles name
	// (repo:tag or repo@digest), sorted: the claim's whole image allowlist at
	// the mirror.
	ImagePins []string `json:"imagePins,omitempty"`
	// Secrets are the org secrets the machines hold as placeholders; their
	// hosts are on CredentialHosts (secrets.go).
	Secrets []Secret `json:"secrets,omitempty"`
	// Inspected are the hosts of the inspected tier (inspect.go): over
	// plain HTTP the proxy checks each request, over TLS the injector does
	// for the sources on InspectSources. Empty on a policy without them, so
	// its bytes are what a cell before the tier signed.
	Inspected []InspectRule `json:"inspected,omitempty"`
	// InspectSources are the claim's sources whose machines trust the cell
	// CA (the claim's own boot mounted it, or the driver gave it to its image
	// builder's RUN steps). From any other source (a builder without it, a
	// blank pool sandbox) TLS to an inspected host stays SNI passthrough: the
	// cell cannot end TLS a client would refuse.
	InspectSources []string `json:"inspectSources,omitempty"`
	// BuildSources are the image builder's addresses (the driver's own,
	// docker-gvisor's Network.Sources). From them only the hosts on
	// BuildPassthrough leave over TLS uninspected (read-only CDNs, and what an
	// owner gave full access); plain HTTP leaves only to a host with an
	// inspected rule, which the proxy checks, or on BuildPassthrough. A
	// builder whose RUN steps trust the cell CA is an inspect source too: its
	// TLS to an inspected host or a secret's goes through the injector. G1:
	// a Dockerfile RUN npm publish is refused either way (build.go).
	BuildSources     []string `json:"buildSources,omitempty"`
	BuildPassthrough []string `json:"buildPassthrough,omitempty"`
	// Sealed: the claim's egress is closed for good (a sandbox whose checkout
	// is prepared). The policy only says who the claim is: the resolver
	// refuses every name, the proxy every connection and the mirror every
	// request, and validate refuses a sealed policy that still names a host,
	// a pin, a secret or the app.
	Sealed    bool      `json:"sealed,omitempty"`
	Phase     Phase     `json:"phase"`
	ExpiresAt time.Time `json:"expiresAt"`
	IssuedAt  time.Time `json:"issuedAt"`
}

// PinsImage reports whether the claim may pull repo at ref from the mirror:
// a tag its Dockerfiles name, or any digest of a repository they name (what
// a pinned tag resolves to: the index, the platform manifest, the layers).
func (p ClaimPolicy) PinsImage(repo, ref string) bool {
	if strings.HasPrefix(ref, "sha256:") {
		for _, pin := range p.ImagePins {
			if name, _, _ := strings.Cut(pin, "@"); name == repo || strings.HasPrefix(pin, repo+":") {
				return true
			}
		}
		return false
	}
	_, found := slices.BinarySearch(p.ImagePins, repo+":"+ref)
	return found
}

// PinsGo reports whether the claim's go.sum pins module at version.
func (p ClaimPolicy) PinsGo(module, version string) bool {
	_, found := slices.BinarySearch(p.GoPins, module+"@"+version)
	return found
}

type Signed struct {
	Policy    json.RawMessage `json:"policy"`
	Signature []byte          `json:"sig"`
}

// NormalizeHost lowercases, drops the trailing dot and refuses anything
// that is not a plain ASCII host name.
func NormalizeHost(h string) (string, error) {
	h = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(h)), ".")
	if h == "" || len(h) > 253 {
		return "", errors.New("policy: bad host length")
	}
	for _, label := range strings.Split(h, ".") {
		if label == "" || len(label) > 63 {
			return "", fmt.Errorf("policy: bad label in %q", h)
		}
		for _, r := range label {
			if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' && r != '_' {
				return "", fmt.Errorf("policy: bad character in %q", h)
			}
		}
	}
	return h, nil
}

// MergeAllow is the claim's allowlist: the cell's base hosts plus the
// hub's extra hosts (egress.policy), normalized, deduplicated and sorted.
func MergeAllow(base, extra []string) ([]string, error) {
	set := map[string]bool{}
	for _, list := range [][]string{base, extra} {
		for _, h := range list {
			if strings.Contains(h, "*") {
				return nil, fmt.Errorf("policy: wildcard %q; the allowlist holds exact hosts", h)
			}
			n, err := NormalizeHost(h)
			if err != nil {
				return nil, err
			}
			set[n] = true
		}
	}
	out := make([]string, 0, len(set))
	for h := range set {
		out = append(out, h)
	}
	sort.Strings(out)
	return out, nil
}

// Spec is what a claim's policy is built from.
type Spec struct {
	ClaimID, OrgID, EnvironmentID string
	Phase                         Phase
	// Sources are every address the claim's traffic comes from.
	Sources []string
	// Base is the cell's own allowlist, Extra the hub's for this claim
	// (recipe hosts and admin approvals).
	Base, Extra []string
	AppAddress  string
	SteerTo     string
	GoPins      []string
	ImagePins   []string
	// Secrets are the claim's placeholder secrets; their hosts join the
	// allowlist and CredentialHosts unless denied.
	Secrets []Secret
	// Inspect are the inspected tier's rules the cell knows (the Kodus
	// recommended list, approvals made as inspected); only the ones whose
	// host ends on the allowlist are signed. InspectSources are the sources
	// that trust the cell CA.
	Inspect        []InspectRule
	InspectSources []string
	// BuildSources and BuildPassthrough: the image builder's addresses and
	// the hosts it may still reach uninspected (build.go). BuildTrusted: its
	// RUN steps trust the cell CA, so its sources are inspect sources too.
	BuildSources, BuildPassthrough []string
	BuildTrusted                   bool
	// Sealed closes the claim's egress: every list above is ignored and the
	// policy keeps only the claim's identity, sources and steering address.
	Sealed    bool
	ExpiresAt time.Time
	IssuedAt  time.Time
}

// Build is the claim's policy, least privilege: a host Denied refuses never
// reaches the signed allowlist, so a policy never says a host is reachable
// when the proxy will refuse it. It returns those hosts for the caller to
// report; the claim runs without them. Denied is the platform's deny list
// (netguard.DenyList.Denies); nil denies nothing.
func Build(spec Spec, denied func(host string) bool) (ClaimPolicy, []string, error) {
	if spec.Sealed {
		// Nothing a list, an approval, a pin or a secret says reaches a sealed
		// claim: it is built from who it is alone.
		p := ClaimPolicy{
			ClaimID: spec.ClaimID, OrgID: spec.OrgID, EnvironmentID: spec.EnvironmentID, Phase: spec.Phase, Sources: spec.Sources,
			Allow: []string{}, SteerTo: spec.SteerTo, Sealed: true, ExpiresAt: spec.ExpiresAt, IssuedAt: spec.IssuedAt,
		}
		if err := p.validate(); err != nil {
			return ClaimPolicy{}, nil, err
		}
		return p, nil, nil
	}
	allow, err := MergeAllow(spec.Base, spec.Extra)
	if err != nil {
		return ClaimPolicy{}, nil, err
	}
	var refused []string
	if denied != nil {
		kept := allow[:0]
		for _, h := range allow {
			if denied(h) {
				refused = append(refused, h)
			} else {
				kept = append(kept, h)
			}
		}
		allow = kept
	}
	p := ClaimPolicy{
		ClaimID: spec.ClaimID, OrgID: spec.OrgID, EnvironmentID: spec.EnvironmentID, Phase: spec.Phase, Sources: spec.Sources,
		Allow: allow, AppAddress: spec.AppAddress, SteerTo: spec.SteerTo, ExpiresAt: spec.ExpiresAt, IssuedAt: spec.IssuedAt,
	}
	if len(spec.GoPins) > 0 {
		p.GoPins = slices.Sorted(slices.Values(spec.GoPins))
		p.GoPins = slices.Compact(p.GoPins)
	}
	if len(spec.ImagePins) > 0 {
		p.ImagePins = slices.Compact(slices.Sorted(slices.Values(spec.ImagePins)))
	}
	secretsRefused, err := withSecrets(&p, spec.Secrets, denied)
	if err != nil {
		return ClaimPolicy{}, nil, err
	}
	refused = append(refused, secretsRefused...)
	if err := withInspected(&p, spec.Inspect, spec.InspectSources); err != nil {
		return ClaimPolicy{}, nil, err
	}
	withBuild(&p, spec.BuildSources, spec.BuildPassthrough, spec.BuildTrusted)
	if err := p.validate(); err != nil {
		return ClaimPolicy{}, nil, err
	}
	return p, refused, nil
}

var environmentIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$`)

func (p ClaimPolicy) validate() error {
	if p.EnvironmentID != "" && !environmentIDPattern.MatchString(p.EnvironmentID) {
		return errors.New("policy: invalid environment identity")
	}
	if p.ClaimID == "" || p.OrgID == "" {
		return errors.New("policy: claim and org required")
	}
	if p.Phase != PhaseBuild && p.Phase != PhaseTest {
		return fmt.Errorf("policy: bad phase %q", p.Phase)
	}
	if len(p.Sources) == 0 {
		return errors.New("policy: no sources")
	}
	for _, s := range p.Sources {
		// Canonical dotted IPv4 only: the store looks sources up by
		// ip.String(), so "::ffff:10.0.0.1" would be stored and never found.
		ip := net.ParseIP(s)
		if ip == nil || ip.To4() == nil || ip.To4().String() != s {
			return fmt.Errorf("policy: source %q is not a canonical IPv4 address", s)
		}
	}
	if p.AppAddress != "" {
		if ip := net.ParseIP(p.AppAddress); ip == nil || ip.To4() == nil {
			return fmt.Errorf("policy: app address %q is not IPv4", p.AppAddress)
		}
	}
	if p.SteerTo != "" {
		if ip := net.ParseIP(p.SteerTo); ip == nil || ip.To4() == nil || ip.To4().String() != p.SteerTo {
			return fmt.Errorf("policy: steer address %q is not a canonical IPv4 address", p.SteerTo)
		}
	}
	if p.Sealed && (len(p.Allow) > 0 || len(p.CredentialHosts) > 0 || len(p.Inspected) > 0 || len(p.InspectSources) > 0 || len(p.BuildSources) > 0 || len(p.BuildPassthrough) > 0 ||
		len(p.GoPins) > 0 || len(p.ImagePins) > 0 || len(p.Secrets) > 0 || p.AppAddress != "") {
		return errors.New("policy: a sealed policy names nothing to reach")
	}
	for _, h := range p.CredentialHosts {
		if !p.Allows(h) {
			return fmt.Errorf("policy: credential host %q is not on the allowlist", h)
		}
	}
	for _, h := range p.Allow {
		if strings.Contains(h, "*") {
			return fmt.Errorf("policy: wildcard %q; the allowlist holds exact hosts", h)
		}
		n, err := NormalizeHost(h)
		if err != nil {
			return err
		}
		if n != h {
			return fmt.Errorf("policy: host %q not normalized", h)
		}
	}
	if err := p.validateBuild(); err != nil {
		return err
	}
	if err := p.validateInspected(); err != nil {
		return err
	}
	return p.validateSecrets()
}

func Sign(key ed25519.PrivateKey, p ClaimPolicy) (Signed, error) {
	if err := p.validate(); err != nil {
		return Signed{}, err
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return Signed{}, err
	}
	return Signed{Policy: raw, Signature: ed25519.Sign(key, raw)}, nil
}

var ErrBadSignature = errors.New("policy: bad signature")

// Verify checks the agent's signature over the exact bytes, then the policy.
func Verify(pub ed25519.PublicKey, s Signed, now time.Time) (ClaimPolicy, error) {
	if !ed25519.Verify(pub, s.Policy, s.Signature) {
		return ClaimPolicy{}, ErrBadSignature
	}
	var p ClaimPolicy
	dec := json.NewDecoder(strings.NewReader(string(s.Policy)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return ClaimPolicy{}, err
	}
	if err := p.validate(); err != nil {
		return ClaimPolicy{}, err
	}
	if !now.Before(p.ExpiresAt) {
		return ClaimPolicy{}, errors.New("policy: expired")
	}
	return p, nil
}

// Store holds the verified policies, by claim and by source address. An
// expired policy stops counting at once (ForSource) and is evicted by the
// next Put that needs its sources and by Sweep. A deleted claim leaves a
// tombstone until its policy would have expired, so replaying the policy the
// agent signed before the delete does not bring it back.
type Store struct {
	mu       sync.RWMutex
	byClaim  map[string]ClaimPolicy
	bySource map[string]string
	deleted  map[string]tombstone
	now      func() time.Time
}

type tombstone struct {
	at, until time.Time
}

func NewStore(now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{byClaim: map[string]ClaimPolicy{}, bySource: map[string]string{}, deleted: map[string]tombstone{}, now: now}
}

// ErrStale refuses a policy issued before the one the claim already has, or
// before the claim was deleted: a re-push replaces the policy only when it
// is not older.
var ErrStale = errors.New("policy: older than the claim's current policy")

func (s *Store) Put(p ClaimPolicy) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if t, ok := s.deleted[p.ClaimID]; ok && !p.IssuedAt.After(t.at) {
		return ErrStale
	}
	if old, ok := s.byClaim[p.ClaimID]; ok && p.IssuedAt.Before(old.IssuedAt) {
		return ErrStale
	}
	for _, src := range p.Sources {
		owner, ok := s.bySource[src]
		if !ok || owner == p.ClaimID {
			continue
		}
		// A machine address is reused as soon as its claim ends: an owner
		// whose policy expired (its delete was lost) no longer holds it.
		if !now.Before(s.byClaim[owner].ExpiresAt) {
			s.dropLocked(owner)
			continue
		}
		return fmt.Errorf("policy: source %s already belongs to claim %s", src, owner)
	}
	if old, ok := s.byClaim[p.ClaimID]; ok {
		for _, src := range old.Sources {
			delete(s.bySource, src)
		}
	}
	delete(s.deleted, p.ClaimID)
	s.byClaim[p.ClaimID] = p
	for _, src := range p.Sources {
		s.bySource[src] = p.ClaimID
	}
	return nil
}

func (s *Store) dropLocked(claimID string) {
	if old, ok := s.byClaim[claimID]; ok {
		for _, src := range old.Sources {
			if s.bySource[src] == claimID {
				delete(s.bySource, src)
			}
		}
		delete(s.byClaim, claimID)
	}
}

// Delete drops the claim's policy and keeps a tombstone.
func (s *Store) Delete(claimID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	until := now.Add(time.Hour)
	if old, ok := s.byClaim[claimID]; ok && old.ExpiresAt.After(until) {
		until = old.ExpiresAt
	}
	s.dropLocked(claimID)
	s.deleted[claimID] = tombstone{at: now, until: until}
}

// Sweep evicts expired policies and old tombstones and returns the claims
// whose policy it evicted.
func (s *Store) Sweep() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	var gone []string
	for id := range s.byClaim {
		if !now.Before(s.byClaim[id].ExpiresAt) {
			s.dropLocked(id)
			gone = append(gone, id)
		}
	}
	for id, t := range s.deleted {
		if !now.Before(t.until) {
			delete(s.deleted, id)
		}
	}
	sort.Strings(gone)
	return gone
}

// ForSource returns the live (not expired) policy of the claim that owns
// this address.
func (s *Store) ForSource(ip net.IP) (ClaimPolicy, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if ip == nil {
		return ClaimPolicy{}, false
	}
	claim, ok := s.bySource[ip.String()]
	if !ok {
		return ClaimPolicy{}, false
	}
	p := s.byClaim[claim]
	if !s.now().Before(p.ExpiresAt) {
		return ClaimPolicy{}, false
	}
	return p, true
}

// ForClaim returns the claim's live policy.
func (s *Store) ForClaim(claimID string) (ClaimPolicy, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.byClaim[claimID]
	if !ok || !s.now().Before(p.ExpiresAt) {
		return ClaimPolicy{}, false
	}
	return p, true
}

// Injects reports whether the host goes through the credential injector.
func (p ClaimPolicy) Injects(host string) bool {
	for _, h := range p.CredentialHosts {
		if h == host {
			return true
		}
	}
	return false
}

// Allows reports whether the exact host is on the claim's allowlist.
func (p ClaimPolicy) Allows(host string) bool {
	for _, h := range p.Allow {
		if h == host {
			return true
		}
	}
	return false
}

func (s *Store) Claims() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.byClaim))
	for k := range s.byClaim {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
