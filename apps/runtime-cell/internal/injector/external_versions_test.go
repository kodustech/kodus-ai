package injector

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type externalVersionReaderFunc func(context.Context, SecretVersionRef) (SecretVersion, error)

func (f externalVersionReaderFunc) ReadVersion(ctx context.Context, ref SecretVersionRef) (SecretVersion, error) {
	return f(ctx, ref)
}

func externalVersionMetadata(s SecretVersion) ExternalSecretVersion {
	return ExternalSecretVersion{Scope: s.Scope, ID: s.ID, Version: s.Version, ExpiresAt: s.ExpiresAt}
}

func externalVersionFixture(t *testing.T, reader SecretVersionReader) (VaultConfig, SecretVersion, Binding) {
	t.Helper()
	cfg, value, binding := vaultFixture(t)
	cfg.ExternalValues = reader
	cfg.ExternalSourceID = "owner-openbao-profile-a"
	return cfg, value, binding
}

func registerExternalBinding(t *testing.T, cfg VaultConfig, value SecretVersion, binding Binding) ManagedVault {
	t.Helper()
	v, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal("external ledger did not open")
	}
	t.Cleanup(func() { _ = v.Close() })
	if err = v.RegisterExternalVersion(context.Background(), externalVersionMetadata(value)); err != nil {
		t.Fatal("external metadata registration failed")
	}
	if err = v.Bind(context.Background(), binding); err != nil {
		t.Fatal("external metadata could not be bound")
	}
	return v
}

func assertExternalLedgerContainsOnlyMetadata(t *testing.T, managed ManagedVault, sourceID string) {
	t.Helper()
	v := managed.(*EncryptedVault)
	if err := v.enter(context.Background()); err != nil {
		t.Fatal("metadata ledger unavailable")
	}
	defer v.leave()
	if v.state.Version != 2 || v.state.ExternalSourceID != sourceID {
		t.Fatal("external state lost its format or owner source pin")
	}
	if len(v.state.Versions) == 0 {
		t.Fatal("external version metadata was not stored")
	}
	for _, record := range v.state.Versions {
		if !record.External || record.Value != "" {
			t.Fatal("external ledger materialized a local secret value")
		}
	}
}

// Remote values had no grant-ledger integration: an external mode must keep
// only pinned metadata on disk and consult the reader on every allowed lookup.
func TestExternalVersionReadsOnlyAfterGrantAuthorizationAndPersistsNoValue(t *testing.T) {
	var reads atomic.Int32
	var remote SecretVersion
	reader := externalVersionReaderFunc(func(_ context.Context, ref SecretVersionRef) (SecretVersion, error) {
		reads.Add(1)
		if ref.Scope != remote.Scope || ref.ID != remote.ID || ref.Version != remote.Version {
			t.Error("reader received an unpinned identity")
		}
		return remote, nil
	})
	cfg, value, binding := externalVersionFixture(t, reader)
	remote = value
	v := registerExternalBinding(t, cfg, value, binding)
	if reads.Load() != 0 {
		t.Fatal("registration or binding read an external value")
	}
	for i := int32(1); i <= 2; i++ {
		got, err := v.Credential(context.Background(), value.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host)
		if err != nil || got.Value != value.Value || got.Header != binding.Header || !got.ExpiresAt.Equal(binding.ExpiresAt) || reads.Load() != i {
			t.Fatal("external lookup bypassed authorization, pinning, expiry or fresh read")
		}
	}
	assertExternalLedgerContainsOnlyMetadata(t, v, cfg.ExternalSourceID)
	raw, err := os.ReadFile(filepath.Join(cfg.Directory, "vault.json"))
	if err != nil || bytes.Contains(raw, []byte(value.Value)) {
		t.Fatal("external ledger persisted a plaintext value")
	}
	if err = v.Close(); err != nil {
		t.Fatal(err)
	}
	recovered, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal("external metadata ledger did not recover")
	}
	defer recovered.Close()
	assertExternalLedgerContainsOnlyMetadata(t, recovered, cfg.ExternalSourceID)
	if reads.Load() != 2 {
		t.Fatal("opening metadata ledger fetched a value")
	}
	if _, err = recovered.Credential(context.Background(), value.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host); err != nil || reads.Load() != 3 {
		t.Fatal("recovered grant did not make a fresh external read")
	}
	if err = recovered.RevokeKnownClaim(context.Background(), binding.Scope.ClaimID); err != nil {
		t.Fatal(err)
	}
	if err = recovered.Close(); err != nil {
		t.Fatal(err)
	}
	revoked, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer revoked.Close()
	if got, err := revoked.Credential(context.Background(), value.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host); !errors.Is(err, ErrVaultDenied) || got.Value != "" || reads.Load() != 3 {
		t.Fatal("recovered revoked claim reached external values")
	}
}

func TestExternalVersionRegistrationValidatesMetadataAndNeverReactivatesRevocation(t *testing.T) {
	reader := externalVersionReaderFunc(func(context.Context, SecretVersionRef) (SecretVersion, error) {
		t.Error("metadata management fetched a value")
		return SecretVersion{}, ErrVaultUnavailable
	})
	for _, kind := range []string{"org", "env", "id", "version_zero", "version_large", "expiry_zero", "expiry_past", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			cfg, value, _ := externalVersionFixture(t, reader)
			v, err := OpenConfiguredVault(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer v.Close()
			metadata := externalVersionMetadata(value)
			ctx := context.Background()
			switch kind {
			case "org":
				metadata.Scope.OrganizationID = "../org"
			case "env":
				metadata.Scope.EnvironmentID = ""
			case "id":
				metadata.ID = "../secret"
			case "version_zero":
				metadata.Version = 0
			case "version_large":
				metadata.Version = 1<<53 + 1
			case "expiry_zero":
				metadata.ExpiresAt = time.Time{}
			case "expiry_past":
				metadata.ExpiresAt = cfg.Now()
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			if err = v.RegisterExternalVersion(ctx, metadata); err == nil {
				t.Fatal("unsafe external metadata registered")
			}
		})
	}
	cfg, value, _ := externalVersionFixture(t, reader)
	v, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	metadata := externalVersionMetadata(value)
	metadata.Version = 4
	if err = v.RegisterExternalVersion(context.Background(), metadata); err != nil {
		t.Fatal("existing remote version4 metadata refused")
	}
	metadata.Version = 3
	if err = v.RegisterExternalVersion(context.Background(), metadata); err != nil {
		t.Fatal("pinned remote version3 refused after registering version4")
	}
	if err = v.RevokeVersion(context.Background(), metadata.Scope, metadata.ID, metadata.Version); err != nil {
		t.Fatal(err)
	}
	if err = v.RegisterExternalVersion(context.Background(), metadata); !errors.Is(err, ErrVaultConflict) {
		t.Fatal("revoked external version reactivated")
	}
}

func TestExternalVersionRejectsUnauthorizedLookupBeforeReaderIO(t *testing.T) {
	for _, kind := range []string{"org", "claim", "host", "policy", "expired_grant", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			var reads atomic.Int32
			reader := externalVersionReaderFunc(func(context.Context, SecretVersionRef) (SecretVersion, error) {
				reads.Add(1)
				return SecretVersion{}, errors.New("unexpected external read")
			})
			cfg, value, binding := externalVersionFixture(t, reader)
			var denied atomic.Bool
			cfg.Claims = vaultAuthorityFunc(func(ctx context.Context, b Binding) (ClaimAuthority, error) {
				if denied.Load() {
					return ClaimAuthority{}, ErrVaultDenied
				}
				return (allowVaultClaim{}).AuthorizeBinding(ctx, b)
			})
			var now atomic.Int64
			now.Store(cfg.Now().UnixNano())
			cfg.Now = func() time.Time { return time.Unix(0, now.Load()).UTC() }
			v := registerExternalBinding(t, cfg, value, binding)
			org, claim, host := value.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host
			ctx := context.Background()
			switch kind {
			case "org":
				org = "org-b"
			case "claim":
				claim = "unknown-claim"
			case "host":
				host = "other.example.test"
			case "policy":
				denied.Store(true)
			case "expired_grant":
				now.Store(binding.ExpiresAt.UnixNano())
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			if got, err := v.Credential(ctx, org, claim, host); err == nil || got.Value != "" || reads.Load() != 0 {
				t.Fatal("denied lookup released or fetched a value")
			}
		})
	}
}

// Remote I/O must not hold the ledger gate. A successful remote response
// cannot release a value after authorization or ledger state changed meanwhile.
func TestExternalVersionRevalidatesAfterBlockedReader(t *testing.T) {
	for _, kind := range []string{"claim", "known_claim", "version", "policy", "close", "cancel", "grant_expiry", "remote_expiry"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			entered, release := make(chan struct{}), make(chan struct{})
			var releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			var remote SecretVersion
			reader := externalVersionReaderFunc(func(ctx context.Context, _ SecretVersionRef) (SecretVersion, error) {
				close(entered)
				select {
				case <-release:
					return remote, nil
				case <-ctx.Done():
					return SecretVersion{}, ctx.Err()
				}
			})
			cfg, value, binding := externalVersionFixture(t, reader)
			remote = value
			if kind == "remote_expiry" {
				remote.ExpiresAt = cfg.Now().Add(10 * time.Minute)
			}
			var denied atomic.Bool
			cfg.Claims = vaultAuthorityFunc(func(ctx context.Context, b Binding) (ClaimAuthority, error) {
				if denied.Load() {
					return ClaimAuthority{}, ErrVaultDenied
				}
				return (allowVaultClaim{}).AuthorizeBinding(ctx, b)
			})
			var now atomic.Int64
			now.Store(cfg.Now().UnixNano())
			cfg.Now = func() time.Time { return time.Unix(0, now.Load()).UTC() }
			v := registerExternalBinding(t, cfg, value, binding)
			defer unblock()
			type result struct {
				credential Credential
				err        error
			}
			done := make(chan result, 1)
			go func() {
				credential, err := v.Credential(ctx, value.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host)
				done <- result{credential, err}
			}()
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal("lookup did not reach external reader")
			}
			changed := make(chan error, 1)
			go func() {
				var err error
				switch kind {
				case "claim":
					err = v.RevokeClaim(ctx, binding.Scope)
				case "known_claim":
					err = v.RevokeKnownClaim(ctx, binding.Scope.ClaimID)
				case "version":
					err = v.RevokeVersion(ctx, value.Scope, value.ID, value.Version)
				case "policy":
					denied.Store(true)
				case "close":
					err = v.Close()
				case "cancel":
					cancel()
				case "grant_expiry":
					now.Store(binding.ExpiresAt.UnixNano())
				case "remote_expiry":
					now.Store(remote.ExpiresAt.UnixNano())
				}
				changed <- err
			}()
			select {
			case err := <-changed:
				if err != nil {
					t.Fatal("state change failed while reader was blocked")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("external read held the ledger gate")
			}
			unblock()
			select {
			case got := <-done:
				if got.err == nil || got.credential.Value != "" {
					t.Fatal("remote response bypassed post-I/O revocation, expiry or cancellation")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("external lookup did not finish")
			}
		})
	}
}

func TestExternalVersionValidatesReturnedIdentityValueAndExpiry(t *testing.T) {
	for _, kind := range []string{"org", "env", "id", "version", "empty", "header_injection", "large", "invalid_utf8", "expired", "zero_expiry", "reader_error"} {
		t.Run(kind, func(t *testing.T) {
			var remote SecretVersion
			reader := externalVersionReaderFunc(func(context.Context, SecretVersionRef) (SecretVersion, error) {
				if kind == "reader_error" {
					return remote, errors.New("synthetic-private-reader-value")
				}
				return remote, nil
			})
			cfg, value, binding := externalVersionFixture(t, reader)
			remote = value
			switch kind {
			case "org":
				remote.Scope.OrganizationID = "org-b"
			case "env":
				remote.Scope.EnvironmentID = "env-b"
			case "id":
				remote.ID = "other"
			case "version":
				remote.Version++
			case "empty":
				remote.Value = ""
			case "header_injection":
				remote.Value = "token\r\nX-Injected: yes"
			case "large":
				remote.Value = strings.Repeat("x", 8193)
			case "invalid_utf8":
				remote.Value = string([]byte{0xff})
			case "expired":
				remote.ExpiresAt = cfg.Now()
			case "zero_expiry":
				remote.ExpiresAt = time.Time{}
			}
			v := registerExternalBinding(t, cfg, value, binding)
			got, err := v.Credential(context.Background(), value.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host)
			if err == nil || got.Value != "" || strings.Contains(err.Error(), "synthetic-private") {
				t.Fatal("invalid external value or raw backend error escaped")
			}
		})
	}
}

func TestExternalVersionCapsExpiryWithoutSelectingLatest(t *testing.T) {
	for _, kind := range []string{"remote_shorter", "remote_longer", "metadata_shorter"} {
		t.Run(kind, func(t *testing.T) {
			var remote SecretVersion
			cfg, value, binding := externalVersionFixture(t, externalVersionReaderFunc(func(context.Context, SecretVersionRef) (SecretVersion, error) { return remote, nil }))
			remote = value
			want := binding.ExpiresAt
			switch kind {
			case "remote_shorter":
				remote.ExpiresAt = cfg.Now().Add(10 * time.Minute)
				want = remote.ExpiresAt
			case "remote_longer":
				remote.ExpiresAt = value.ExpiresAt.Add(time.Hour)
			case "metadata_shorter":
				value.ExpiresAt = cfg.Now().Add(15 * time.Minute)
				binding.ExpiresAt = value.ExpiresAt
				want = value.ExpiresAt
			}
			v := registerExternalBinding(t, cfg, value, binding)
			got, err := v.Credential(context.Background(), value.Scope.OrganizationID, binding.Scope.ClaimID, binding.Host)
			if err != nil || !got.ExpiresAt.Equal(want) {
				t.Fatal("credential exceeded the minimum authorized lifetime")
			}
		})
	}
}

func TestExternalVersionModeAndSourceCannotBeSilentlyChanged(t *testing.T) {
	reader := externalVersionReaderFunc(func(context.Context, SecretVersionRef) (SecretVersion, error) {
		return SecretVersion{}, ErrVaultUnavailable
	})
	cfg, value, binding := externalVersionFixture(t, reader)
	v := registerExternalBinding(t, cfg, value, binding)
	if err := v.PutVersion(context.Background(), value); !errors.Is(err, ErrVaultDenied) {
		t.Fatal("external mode accepted a local value")
	}
	if err := v.RegisterExternalVersion(context.Background(), externalVersionMetadata(value)); err != nil {
		t.Fatal("identical external metadata registration was not idempotent")
	}
	changed := externalVersionMetadata(value)
	changed.ExpiresAt = changed.ExpiresAt.Add(time.Minute)
	if err := v.RegisterExternalVersion(context.Background(), changed); !errors.Is(err, ErrVaultConflict) {
		t.Fatal("external version metadata changed in place")
	}
	if err := v.Close(); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"different_source", "local_mode"} {
		other := cfg
		if kind == "different_source" {
			other.ExternalSourceID = "owner-openbao-profile-b"
		} else {
			other.ExternalValues = nil
			other.ExternalSourceID = ""
		}
		opened, err := OpenConfiguredVault(other)
		if err == nil {
			opened.Close()
			t.Fatal("persisted external source or mode was silently changed")
		}
	}
	local, value, _ := vaultFixture(t)
	managed, err := OpenConfiguredVault(local)
	if err != nil {
		t.Fatal(err)
	}
	if err = managed.RegisterExternalVersion(context.Background(), externalVersionMetadata(value)); !errors.Is(err, ErrVaultDenied) {
		t.Fatal("local mode accepted external metadata")
	}
	if err = managed.PutVersion(context.Background(), value); err != nil {
		t.Fatal("local mode no longer accepts its original value path")
	}
	if err = managed.Close(); err != nil {
		t.Fatal(err)
	}
	local.ExternalValues, local.ExternalSourceID = reader, "owner-openbao-profile-a"
	if opened, err := OpenConfiguredVault(local); err == nil {
		opened.Close()
		t.Fatal("format1 local ledger was implicitly migrated")
	}
	for _, kind := range []string{"reader_only", "source_only"} {
		partial, _, _ := externalVersionFixture(t, reader)
		if kind == "reader_only" {
			partial.ExternalSourceID = ""
		} else {
			partial.ExternalValues = nil
		}
		if opened, err := OpenConfiguredVault(partial); err == nil {
			opened.Close()
			t.Fatal("partial external configuration was accepted")
		}
	}
}
