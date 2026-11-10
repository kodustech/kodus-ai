package injector

import (
	"context"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

func validVersion(s SecretVersion) bool {
	if !validSecretScope(s.Scope) || !vaultID.MatchString(s.ID) || s.Version == 0 || s.Version > 1<<53 || len(s.Value) == 0 || len(s.Value) > maxVaultValue || !utf8.ValidString(s.Value) || s.ExpiresAt.IsZero() {
		return false
	}
	for _, r := range s.Value {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}
func normalizeBinding(b Binding) (Binding, error) {
	host, err := policy.NormalizeHost(b.Host)
	if err != nil || net.ParseIP(host) != nil || !validClaimScope(b.Scope) || !vaultID.MatchString(b.SecretID) || b.Version == 0 || b.Version > 1<<53 || !validHeader(b.Header) || b.ExpiresAt.IsZero() || len(b.Baits) > 3 {
		return Binding{}, ErrVaultDenied
	}
	for _, s := range b.Baits {
		if len(s) < 16 || len(s) > 192 || !utf8.ValidString(s) || strings.ContainsAny(s, "\x00\r\n") {
			return Binding{}, ErrVaultDenied
		}
	}
	b.Host = host
	b.Header = http.CanonicalHeaderKey(b.Header)
	b.Baits = slices.Clone(b.Baits)
	b.ExpiresAt = b.ExpiresAt.UTC()
	return b, nil
}
func (v *EncryptedVault) validState() bool {
	s := v.state
	if s.Version != v.format || s.CellID != v.cellID || s.ExternalSourceID != v.externalSourceID || s.Versions == nil || s.Bindings == nil || s.Claims == nil || len(s.Versions) > maxVaultVersions || len(s.Bindings) > maxVaultBindings || len(s.Claims) > maxVaultClaims {
		return false
	}
	for key, r := range s.Versions {
		if !v.validVersionRecord(r) || key != versionKey(r.Scope, r.ID, r.Version) {
			return false
		}
	}
	for id, c := range s.Claims {
		if !validClaimScope(c.Scope) || id != c.Scope.ClaimID || c.ExpiresAt.IsZero() {
			return false
		}
	}
	for key, b := range s.Bindings {
		normalized, err := normalizeBinding(b)
		if err != nil || normalized.Host != b.Host || normalized.Header != b.Header || key != bindingKey(b.Scope.ClaimID, b.Host) {
			return false
		}
		c, ok := s.Claims[b.Scope.ClaimID]
		if !ok || c.Scope != b.Scope || b.ExpiresAt.After(c.ExpiresAt) {
			return false
		}
		r, ok := s.Versions[versionKey(b.Scope.SecretScope, b.SecretID, b.Version)]
		if !ok || b.ExpiresAt.After(r.ExpiresAt) {
			return false
		}
	}
	return true
}
func (v *EncryptedVault) PutVersion(ctx context.Context, s SecretVersion) error {
	if v.externalValues != nil || !validVersion(s) {
		return ErrVaultDenied
	}
	return v.putVersionRecord(ctx, versionRecord{SecretVersion: s})
}

func (v *EncryptedVault) putVersionRecord(ctx context.Context, record versionRecord) error {
	record.ExpiresAt = record.ExpiresAt.UTC()
	if err := v.enter(ctx); err != nil {
		return err
	}
	defer v.leave()
	if !v.now().Before(record.ExpiresAt) {
		return ErrVaultDenied
	}
	key := versionKey(record.Scope, record.ID, record.Version)
	if prev, ok := v.state.Versions[key]; ok {
		if prev == record && !prev.Revoked {
			return nil
		}
		return ErrVaultConflict
	}
	for _, prev := range v.state.Versions {
		// Local writes create values in order. External registration only
		// references an existing immutable version, including older versions.
		if !record.External && prev.Scope == record.Scope && prev.ID == record.ID && prev.Version >= record.Version {
			return ErrVaultConflict
		}
	}
	if len(v.state.Versions) >= maxVaultVersions {
		return ErrVaultCapacity
	}
	next := v.clone()
	v.pruneClaims(&next)
	next.Versions[key] = record
	return v.save(ctx, next)
}
func (v *EncryptedVault) Bind(ctx context.Context, b Binding) error {
	var err error
	b, err = normalizeBinding(b)
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if v.claims == nil {
		return ErrVaultDenied
	}
	fence, err := v.beginBinding(ctx, b.Scope.ClaimID)
	if err != nil {
		return err
	}
	defer v.endBinding(b.Scope.ClaimID, fence)
	// The trusted authority returns scope and hard expiry independently of the
	// caller's binding. A raw claim id or a caller-supplied expiry grants nothing.
	authorityInput := b
	authorityInput.Baits = slices.Clone(b.Baits)
	authority, err := v.claims.AuthorizeBinding(ctx, authorityInput)
	if err != nil {
		if cancelled := ctx.Err(); cancelled != nil {
			return cancelled
		}
		return ErrVaultDenied
	}
	if authority.Scope != b.Scope || authority.ExpiresAt.IsZero() || b.ExpiresAt.After(authority.ExpiresAt) || !slices.Contains(authority.CredentialHosts, b.Host) {
		return ErrVaultDenied
	}
	if err = v.enter(ctx); err != nil {
		return err
	}
	defer v.leave()
	if fence.revoked {
		return ErrVaultDenied
	}
	if !v.now().Before(b.ExpiresAt) || !v.now().Before(authority.ExpiresAt) {
		return ErrVaultDenied
	}
	version, ok := v.state.Versions[versionKey(b.Scope.SecretScope, b.SecretID, b.Version)]
	if !ok || version.Revoked || !v.now().Before(version.ExpiresAt) || b.ExpiresAt.After(version.ExpiresAt) {
		return ErrVaultDenied
	}
	if c, exists := v.state.Claims[b.Scope.ClaimID]; exists && (c.Scope != b.Scope || c.Revoked || !c.ExpiresAt.Equal(authority.ExpiresAt)) {
		return ErrVaultDenied
	}
	key := bindingKey(b.Scope.ClaimID, b.Host)
	if previous, exists := v.state.Bindings[key]; exists {
		if equalBinding(previous, b) {
			return nil
		}
		return ErrVaultConflict
	}
	next := v.clone()
	v.pruneClaims(&next)
	if len(next.Bindings) >= maxVaultBindings {
		return ErrVaultCapacity
	}
	if _, exists := next.Claims[b.Scope.ClaimID]; !exists && len(next.Claims) >= maxVaultClaims {
		return ErrVaultCapacity
	}
	next.Bindings[key] = b
	next.Claims[b.Scope.ClaimID] = claimRecord{Scope: b.Scope, ExpiresAt: authority.ExpiresAt.UTC()}
	return v.save(ctx, next)
}
func equalBinding(a, b Binding) bool {
	return a.Scope == b.Scope && a.SecretID == b.SecretID && a.Version == b.Version && a.Host == b.Host && a.Header == b.Header && a.ExpiresAt.Equal(b.ExpiresAt) && slices.Equal(a.Baits, b.Baits)
}

func (v *EncryptedVault) beginBinding(ctx context.Context, claimID string) (*bindingFence, error) {
	if err := v.enter(ctx); err != nil {
		return nil, err
	}
	defer v.leave()
	if v.activeBinds >= maxVaultClaims {
		return nil, ErrVaultCapacity
	}
	if v.binds == nil {
		v.binds = make(map[string]*bindingFence)
	}
	fence := v.binds[claimID]
	if fence == nil {
		fence = &bindingFence{}
		v.binds[claimID] = fence
	}
	fence.pending++
	v.activeBinds++
	return fence, nil
}
func (v *EncryptedVault) endBinding(claimID string, fence *bindingFence) {
	// Cleanup must also work after cancellation, an uncertain write or Close.
	v.gate <- struct{}{}
	defer v.leave()
	if v.binds[claimID] != fence {
		return
	}
	fence.pending--
	v.activeBinds--
	if fence.pending == 0 {
		delete(v.binds, claimID)
	}
}
func (v *EncryptedVault) Credential(ctx context.Context, orgID, claimID, host string) (Credential, error) {
	normalized, err := policy.NormalizeHost(host)
	if err != nil || !vaultID.MatchString(orgID) || !vaultID.MatchString(claimID) {
		return Credential{}, ErrVaultDenied
	}
	if err = v.enter(ctx); err != nil {
		return Credential{}, err
	}
	b, claim, secret, ok := v.credentialRecord(orgID, claimID, normalized)
	v.leave()
	if !ok || v.claims == nil {
		return Credential{}, ErrVaultDenied
	}
	if err = v.authorizeCredential(ctx, b, claim); err != nil {
		return Credential{}, err
	}
	if secret.External {
		return v.externalCredential(ctx, orgID, claimID, normalized, b, claim, secret)
	}
	if err = v.enter(ctx); err != nil {
		return Credential{}, err
	}
	defer v.leave()
	current, currentClaim, secret, ok := v.credentialRecord(orgID, claimID, normalized)
	// Revocation, expiry or an immutable-record change while authority was
	// checked must not release the value captured before that check.
	if !ok || !equalBinding(current, b) || !currentClaim.ExpiresAt.Equal(claim.ExpiresAt) {
		return Credential{}, ErrVaultDenied
	}
	return Credential{Header: current.Header, Value: secret.Value, ExpiresAt: minExpiry(current.ExpiresAt, secret.ExpiresAt), Baits: slices.Clone(current.Baits)}, nil
}

// This live-authority rule is shared by local reads and both sides of a remote
// read. No vault gate is held while consulting an independent policy store.
func (v *EncryptedVault) authorizeCredential(ctx context.Context, binding Binding, claim claimRecord) error {
	input := binding
	input.Baits = slices.Clone(binding.Baits)
	authority, err := v.claims.AuthorizeBinding(ctx, input)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrVaultDenied
	}
	if authority.Scope != binding.Scope || !authority.ExpiresAt.Equal(claim.ExpiresAt) || binding.ExpiresAt.After(authority.ExpiresAt) || !slices.Contains(authority.CredentialHosts, binding.Host) {
		return ErrVaultDenied
	}
	return nil
}

// credentialRecord is called only under gate and never returns its value to
// a caller until live authority and a second state check have both passed.
func (v *EncryptedVault) credentialRecord(orgID, claimID, host string) (Binding, claimRecord, versionRecord, bool) {
	b, ok := v.state.Bindings[bindingKey(claimID, host)]
	if !ok || b.Scope.OrganizationID != orgID || !v.now().Before(b.ExpiresAt) {
		return Binding{}, claimRecord{}, versionRecord{}, false
	}
	c, ok := v.state.Claims[claimID]
	if !ok || c.Scope != b.Scope || c.Revoked || !v.now().Before(c.ExpiresAt) {
		return Binding{}, claimRecord{}, versionRecord{}, false
	}
	secret, ok := v.state.Versions[versionKey(b.Scope.SecretScope, b.SecretID, b.Version)]
	if !ok || secret.Revoked || !v.now().Before(secret.ExpiresAt) {
		return Binding{}, claimRecord{}, versionRecord{}, false
	}
	return b, c, secret, true
}

func minExpiry(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
func (v *EncryptedVault) RevokeVersion(ctx context.Context, scope SecretScope, id string, version uint64) error {
	if !validSecretScope(scope) || !vaultID.MatchString(id) || version == 0 {
		return ErrVaultDenied
	}
	if err := v.enter(ctx); err != nil {
		return err
	}
	defer v.leave()
	key := versionKey(scope, id, version)
	record, ok := v.state.Versions[key]
	if !ok {
		return ErrVaultDenied
	}
	if record.Revoked {
		return nil
	}
	next := v.clone()
	record.Revoked = true
	next.Versions[key] = record
	return v.save(ctx, next)
}
func (v *EncryptedVault) RevokeClaim(ctx context.Context, scope ClaimScope) error {
	if !validClaimScope(scope) {
		return ErrVaultDenied
	}
	if err := v.enter(ctx); err != nil {
		return err
	}
	defer v.leave()
	record, ok := v.state.Claims[scope.ClaimID]
	if !ok || record.Scope != scope {
		return ErrVaultDenied
	}
	if record.Revoked {
		return nil
	}
	next := v.clone()
	record.Revoked = true
	next.Claims[scope.ClaimID] = record
	return v.save(ctx, next)
}
func (v *EncryptedVault) RevokeKnownClaim(ctx context.Context, claimID string) error {
	if !vaultID.MatchString(claimID) {
		return ErrVaultDenied
	}
	if err := v.enter(ctx); err != nil {
		return err
	}
	defer v.leave()
	if fence := v.binds[claimID]; fence != nil {
		fence.revoked = true
	}
	record, ok := v.state.Claims[claimID]
	if !ok || record.Revoked {
		return nil
	}
	next := v.clone()
	record.Revoked = true
	next.Claims[claimID] = record
	return v.save(ctx, next)
}
func (v *EncryptedVault) ListVersions(ctx context.Context, scope SecretScope) ([]SecretVersionInfo, error) {
	if !validSecretScope(scope) {
		return nil, ErrVaultDenied
	}
	if err := v.enter(ctx); err != nil {
		return nil, err
	}
	out := []SecretVersionInfo{}
	for _, r := range v.state.Versions {
		if r.Scope == scope {
			out = append(out, SecretVersionInfo{Scope: r.Scope, ID: r.ID, Version: r.Version, ExpiresAt: r.ExpiresAt, Revoked: r.Revoked})
		}
	}
	// The snapshot is independent of mutable state; sorting need not delay
	// a credential check or durable revocation waiting for the gate.
	v.leave()
	slices.SortFunc(out, func(a, b SecretVersionInfo) int {
		if d := strings.Compare(a.ID, b.ID); d != 0 {
			return d
		}
		if a.Version < b.Version {
			return -1
		}
		if a.Version > b.Version {
			return 1
		}
		return 0
	})
	return out, nil
}
