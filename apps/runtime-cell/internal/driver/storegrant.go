package driver

import (
	"log/slog"
	"sync"
	"time"
)

// The shared image store's credential for one claim (docs/runtime/shared-image-store.md
// section 4): a bearer token the hub minted, scoped to the named repositories and
// short-lived. The cell holds it in memory, moves the files itself, and never gives it
// to a builder or writes it to disk. The repository names are the hub's: the cell never
// builds one.

// StoreRepo is one repository a grant names and what the token may do there.
type StoreRepo struct {
	Scope string // main, pr or cache
	Name  string // the full repository name, prefix included
	Pull  bool
	Push  bool
}

// StoreGrant is what claim.acquire (and a later claim.renew) carries.
type StoreGrant struct {
	Endpoint  string
	Prefix    string
	Token     string
	ExpiresAt time.Time
	Repos     []StoreRepo
}

// Repo is the grant's repository of a scope.
func (g StoreGrant) Repo(scope string) (StoreRepo, bool) {
	for _, r := range g.Repos {
		if r.Scope == scope {
			return r, true
		}
	}
	return StoreRepo{}, false
}

// String never says the token, so a log line that formats a grant cannot leak it.
func (g StoreGrant) String() string { return "store-grant[redacted]" }

// GoString is String's twin for %#v.
func (g StoreGrant) GoString() string { return g.String() }

// LogValue keeps the token out of a structured log: slog's JSON handler writes a struct's fields and never calls String.
func (g StoreGrant) LogValue() slog.Value { return slog.StringValue(g.String()) }

// MarshalJSON and MarshalText never say the token either.
func (g StoreGrant) MarshalJSON() ([]byte, error) { return []byte(`"` + g.String() + `"`), nil }

// MarshalText is MarshalJSON's twin for encoders that prefer it.
func (g StoreGrant) MarshalText() ([]byte, error) { return []byte(g.String()), nil }

// StoreCreds holds a claim's grant, renewed with the claim's lease. A renewal moves the
// token and its expiry and never the repositories: what a claim may reach is what its
// acquire said.
type StoreCreds struct {
	mu sync.RWMutex
	g  StoreGrant
	// changed is closed by the next renewal and replaced, so a holder of a copy of the token (a file a
	// builder reads) learns to refresh it.
	changed chan struct{}
}

// NewStoreCreds holds g.
func NewStoreCreds(g StoreGrant) *StoreCreds {
	return &StoreCreds{g: g, changed: make(chan struct{})}
}

// Changed is closed when the token next changes; call it again after it fires for the one after.
func (c *StoreCreds) Changed() <-chan struct{} {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.changed
}

// Current is the grant now.
func (c *StoreCreds) Current() StoreGrant {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.g
}

// Token is the bearer token now, for a client that asks on every request.
func (c *StoreCreds) Token() string { return c.Current().Token }

// Renew takes a later token and expiry; an older or an empty one changes nothing.
func (c *StoreCreds) Renew(g StoreGrant) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if g.Token == "" || !g.ExpiresAt.After(c.g.ExpiresAt) {
		return
	}
	c.g.Token, c.g.ExpiresAt = g.Token, g.ExpiresAt
	if c.changed != nil {
		close(c.changed)
	}
	c.changed = make(chan struct{})
}

// Live is whether the token has not expired at now.
func (c *StoreCreds) Live(now time.Time) bool { return c.Current().ExpiresAt.After(now) }

// String never says the token.
func (c *StoreCreds) String() string { return "store-creds[redacted]" }

// LogValue is String for a structured log.
func (c *StoreCreds) LogValue() slog.Value { return slog.StringValue(c.String()) }

// PushedImage is one service image the PR side pushed: its build fingerprint and the
// manifest digest the hub gives the suite's shards.
type PushedImage struct {
	Fingerprint string
	Digest      string
	Bytes       int64
	PushMs      int64
}

// PRPush is what the PR side's push came to (image.pushed): ok with the images it pushed,
// or failed with a short code. Never a path, a name or a layer.
type PRPush struct {
	OK     bool
	Reason string
	Images []PushedImage
}
