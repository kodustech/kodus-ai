package injector

import (
	"context"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// LiveClaimPolicies is the injector's store populated only by control.Server
// after verifying the configured agent's Ed25519 signature over the policy.
type LiveClaimPolicies interface {
	ForClaim(string) (policy.ClaimPolicy, bool)
}

// PolicyClaimAuthorizer never infers an environment from the caller. Legacy
// egress policies without a signed environment remain valid for networking,
// but cannot authorize binding or release of any credential.
type PolicyClaimAuthorizer struct {
	Policies LiveClaimPolicies
	Now      func() time.Time
}

func (a PolicyClaimAuthorizer) AuthorizeBinding(ctx context.Context, b Binding) (ClaimAuthority, error) {
	if err := ctx.Err(); err != nil {
		return ClaimAuthority{}, err
	}
	normalized, err := normalizeBinding(b)
	if err != nil || a.Policies == nil {
		return ClaimAuthority{}, ErrVaultDenied
	}
	p, ok := a.Policies.ForClaim(normalized.Scope.ClaimID)
	if err := ctx.Err(); err != nil {
		return ClaimAuthority{}, err
	}
	now := time.Now()
	if a.Now != nil {
		now = a.Now()
	}
	scope := ClaimScope{SecretScope: SecretScope{OrganizationID: p.OrgID, EnvironmentID: p.EnvironmentID}, ClaimID: p.ClaimID}
	if !ok || !validClaimScope(scope) || scope != normalized.Scope || !now.Before(p.ExpiresAt) || normalized.ExpiresAt.After(p.ExpiresAt) || !p.Allows(normalized.Host) || !p.Injects(normalized.Host) || (p.Phase != policy.PhaseBuild && p.Phase != policy.PhaseTest) {
		return ClaimAuthority{}, ErrVaultDenied
	}
	return ClaimAuthority{Scope: scope, ExpiresAt: p.ExpiresAt.UTC(), CredentialHosts: []string{normalized.Host}}, nil
}
