package injector

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var (
	ErrVaultNotConfigured = errors.New("injector: vault not configured")
	ErrVaultConfig        = errors.New("injector: unsafe vault configuration")
	ErrVaultUnavailable   = errors.New("injector: vault unavailable")
	ErrVaultDenied        = errors.New("injector: credential access denied")
	ErrVaultConflict      = errors.New("injector: immutable vault record conflicts")
	ErrVaultCapacity      = errors.New("injector: vault capacity reached")
)

// SecretScope is metadata the trusted management boundary authorizes. Values
// are never paths, and a caller-supplied scope is not authorization by itself.
type SecretScope struct {
	OrganizationID string `json:"organizationId"`
	EnvironmentID  string `json:"environmentId"`
}

type ClaimScope struct {
	SecretScope
	ClaimID string `json:"claimId"`
}

// SecretVersion is write-only input. Only Credential returns its value, inside
// the injector; metadata APIs never return it. A version cannot be overwritten.
type SecretVersion struct {
	Scope     SecretScope `json:"scope"`
	ID        string      `json:"id"`
	Version   uint64      `json:"version"`
	Value     string      `json:"value"`
	ExpiresAt time.Time   `json:"expiresAt"`
}

func (SecretVersion) String() string               { return "injector.SecretVersion{redacted}" }
func (s SecretVersion) GoString() string           { return s.String() }
func (s SecretVersion) LogValue() slog.Value       { return slog.StringValue(s.String()) }
func (s SecretVersion) Format(f fmt.State, _ rune) { _, _ = io.WriteString(f, s.String()) }

func (Credential) String() string               { return "injector.Credential{redacted}" }
func (c Credential) GoString() string           { return c.String() }
func (c Credential) LogValue() slog.Value       { return slog.StringValue(c.String()) }
func (c Credential) Format(f fmt.State, _ rune) { _, _ = io.WriteString(f, c.String()) }

// Binding grants one exact version and header to a claim and host. Its fields
// are data; Claims must independently authorize them before a grant is stored.
type Binding struct {
	Scope     ClaimScope `json:"scope"`
	SecretID  string     `json:"secretId"`
	Version   uint64     `json:"version"`
	Host      string     `json:"host"`
	Header    string     `json:"header"`
	ExpiresAt time.Time  `json:"expiresAt"`
	Baits     []string   `json:"baits,omitempty"`
}

type ClaimAuthority struct {
	Scope           ClaimScope
	ExpiresAt       time.Time
	CredentialHosts []string
}

// ClaimAuthorizer lives behind an authenticated, signed claim-management
// boundary. Nil refuses Bind. No management HTTP/WS endpoint is added here.
type ClaimAuthorizer interface {
	AuthorizeBinding(context.Context, Binding) (ClaimAuthority, error)
}

type SecretVersionInfo struct {
	Scope     SecretScope
	ID        string
	Version   uint64
	ExpiresAt time.Time
	Revoked   bool
}

// ExternalSecretVersion registers an immutable reference and an owner's upper
// validity bound. It never contains a value, endpoint, mount or credential.
type ExternalSecretVersion struct {
	Scope     SecretScope `json:"scope"`
	ID        string      `json:"id"`
	Version   uint64      `json:"version"`
	ExpiresAt time.Time   `json:"expiresAt"`
}

// ManagedVault must stay inside the injector process, which owns its lifetime
// file lock. A separate CLI must never modify a running injector's store.
type ManagedVault interface {
	Vault
	PutVersion(context.Context, SecretVersion) error
	RegisterExternalVersion(context.Context, ExternalSecretVersion) error
	Bind(context.Context, Binding) error
	RevokeVersion(context.Context, SecretScope, string, uint64) error
	RevokeClaim(context.Context, ClaimScope) error
	// RevokeKnownClaim is only for the authenticated signed-policy removal
	// boundary. It resolves scope from an existing authorized record; it is
	// not an owner management operation or an authority to create a grant.
	RevokeKnownClaim(context.Context, string) error
	ListVersions(context.Context, SecretScope) ([]SecretVersionInfo, error)
	io.Closer
}

type VaultConfig struct {
	Directory string
	KeyFile   string
	CellID    string
	Claims    ClaimAuthorizer
	Now       func() time.Time
	Context   context.Context
	// Both fields select the metadata-only external mode. Source identity is
	// an immutable owner mapping to the reader's destination/auth config.
	ExternalValues   SecretVersionReader
	ExternalSourceID string
}

// RefusingVault is the explicit unconfigured production mode: it never silently
// falls back to an in-memory secret store.
type RefusingVault struct{}

func (RefusingVault) Credential(context.Context, string, string, string) (Credential, error) {
	return Credential{}, ErrVaultNotConfigured
}
func (RefusingVault) PutVersion(context.Context, SecretVersion) error { return ErrVaultNotConfigured }
func (RefusingVault) RegisterExternalVersion(context.Context, ExternalSecretVersion) error {
	return ErrVaultNotConfigured
}
func (RefusingVault) Bind(context.Context, Binding) error { return ErrVaultNotConfigured }
func (RefusingVault) RevokeVersion(context.Context, SecretScope, string, uint64) error {
	return ErrVaultNotConfigured
}
func (RefusingVault) RevokeClaim(context.Context, ClaimScope) error  { return ErrVaultNotConfigured }
func (RefusingVault) RevokeKnownClaim(context.Context, string) error { return ErrVaultNotConfigured }
func (RefusingVault) ListVersions(context.Context, SecretScope) ([]SecretVersionInfo, error) {
	return nil, ErrVaultNotConfigured
}
func (RefusingVault) Close() error { return nil }

var vaultID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$`)
var vaultHeader = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$")

func validSecretScope(s SecretScope) bool {
	return vaultID.MatchString(s.OrganizationID) && vaultID.MatchString(s.EnvironmentID)
}
func validClaimScope(s ClaimScope) bool {
	return validSecretScope(s.SecretScope) && vaultID.MatchString(s.ClaimID)
}
func validHeader(s string) bool {
	return vaultHeader.MatchString(s) && !hopByHop[http.CanonicalHeaderKey(s)] && !strings.EqualFold(s, "Host") && !strings.EqualFold(s, "Content-Length") && !strings.EqualFold(s, "Accept-Encoding")
}
