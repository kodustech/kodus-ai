package injector

import (
	"context"
	"errors"
	"slices"
)

// RegisterExternalVersion accepts metadata through a trusted owner boundary;
// it neither writes a secret value nor grants a claim permission to read it.
func (v *EncryptedVault) RegisterExternalVersion(ctx context.Context, metadata ExternalSecretVersion) error {
	if v.externalValues == nil || !validExternalVersion(metadata) {
		return ErrVaultDenied
	}
	record := versionRecord{SecretVersion: SecretVersion{Scope: metadata.Scope, ID: metadata.ID, Version: metadata.Version, ExpiresAt: metadata.ExpiresAt}, External: true}
	return v.putVersionRecord(ctx, record)
}

func validExternalVersion(s ExternalSecretVersion) bool {
	return validSecretScope(s.Scope) && vaultID.MatchString(s.ID) && s.Version > 0 && s.Version <= 1<<53 && !s.ExpiresAt.IsZero()
}

func (v *EncryptedVault) validVersionRecord(record versionRecord) bool {
	if v.externalValues == nil {
		return !record.External && validVersion(record.SecretVersion)
	}
	return record.External && record.Value == "" && validExternalVersion(ExternalSecretVersion{Scope: record.Scope, ID: record.ID, Version: record.Version, ExpiresAt: record.ExpiresAt})
}

// externalCredential never holds the grant gate during backend/authority I/O.
// The final gate check linearizes a read before or after durable revocation.
func (v *EncryptedVault) externalCredential(ctx context.Context, orgID, claimID, host string, binding Binding, claim claimRecord, version versionRecord) (Credential, error) {
	if v.externalValues == nil {
		return Credential{}, ErrVaultNotConfigured
	}
	// The initial authority check itself may have raced a removal. Do not
	// contact the value backend after the ledger has already refused access.
	if err := v.enter(ctx); err != nil {
		return Credential{}, err
	}
	current, currentClaim, currentVersion, ok := v.credentialRecord(orgID, claimID, host)
	v.leave()
	if !ok || !equalBinding(current, binding) || currentClaim != claim || currentVersion != version {
		return Credential{}, ErrVaultDenied
	}
	ref := SecretVersionRef{Scope: version.Scope, ID: version.ID, Version: version.Version}
	value, err := v.externalValues.ReadVersion(ctx, ref)
	if err != nil {
		if ctx.Err() != nil {
			return Credential{}, ctx.Err()
		}
		// Never propagate implementation errors, including an arbitrary token,
		// URL or response embedded by a failed external backend.
		if errors.Is(err, ErrVaultDenied) {
			return Credential{}, ErrVaultDenied
		}
		if errors.Is(err, ErrVaultNotConfigured) {
			return Credential{}, ErrVaultNotConfigured
		}
		return Credential{}, ErrVaultUnavailable
	}
	if err := ctx.Err(); err != nil {
		return Credential{}, err
	}
	if value.Scope != ref.Scope || value.ID != ref.ID || value.Version != ref.Version || !validVersion(value) {
		return Credential{}, ErrVaultDenied
	}
	if err = v.authorizeCredential(ctx, binding, claim); err != nil {
		return Credential{}, err
	}
	if err = v.enter(ctx); err != nil {
		return Credential{}, err
	}
	defer v.leave()
	current, currentClaim, currentVersion, ok = v.credentialRecord(orgID, claimID, host)
	if !ok || !equalBinding(current, binding) || currentClaim != claim || currentVersion != version || !v.now().Before(value.ExpiresAt) {
		return Credential{}, ErrVaultDenied
	}
	expiresAt := minExpiry(current.ExpiresAt, minExpiry(currentVersion.ExpiresAt, value.ExpiresAt))
	return Credential{Header: current.Header, Value: value.Value, ExpiresAt: expiresAt, Baits: slices.Clone(current.Baits)}, nil
}
