package injector

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
)

func TestExternalVersionConfigCannotBypassRefusingDefault(t *testing.T) {
	reader := externalVersionReaderFunc(func(context.Context, SecretVersionRef) (SecretVersion, error) {
		t.Error("configuration read a value")
		return SecretVersion{}, ErrVaultUnavailable
	})
	for _, cfg := range []VaultConfig{
		{ExternalValues: reader}, {ExternalSourceID: "source-a"}, {ExternalValues: reader, ExternalSourceID: "source-a"}, {ExternalValues: reader, ExternalSourceID: "../source"},
	} {
		if v, err := OpenConfiguredVault(cfg); !errors.Is(err, ErrVaultConfig) {
			if v != nil {
				_ = v.Close()
			}
			t.Fatal("external settings were silently ignored")
		}
	}
	v, err := OpenConfiguredVault(VaultConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if err = v.RegisterExternalVersion(context.Background(), ExternalSecretVersion{}); !errors.Is(err, ErrVaultNotConfigured) {
		t.Fatal("default vault did not refuse metadata registration")
	}
}

// This is a literal format1 payload/AAD from before external records existed,
// not a round trip through today's vaultState serializer.
func TestExternalVersionKeepsHistoricalFormatOneReadableAndUnchanged(t *testing.T) {
	cfg, secret, binding := vaultFixture(t)
	plain := []byte(`{"version":1,"cellId":"cell-a","versions":{"org-a|env-a|payments|1":{"scope":{"organizationId":"org-a","environmentId":"env-a"},"id":"payments","version":1,"value":"Bearer synthetic-owner-test-value","expiresAt":"2030-01-01T02:00:00Z","revoked":false}},"bindings":{},"claims":{}}`)
	block, err := aes.NewCipher(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := bytes.Repeat([]byte{3}, aead.NonceSize())
	encrypted := aead.Seal(nil, nonce, plain, []byte("kodus-runtime/injector-vault/v1\x00cell-a"))
	raw := []byte(fmt.Sprintf(`{"version":1,"nonce":"%s","ciphertext":"%s"}`, base64.RawStdEncoding.EncodeToString(nonce), base64.RawStdEncoding.EncodeToString(encrypted)))
	path := filepath.Join(cfg.Directory, "vault.json")
	if err = os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	v, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatalf("historical format1 refused: %v", err)
	}
	if err = v.Bind(context.Background(), binding); err != nil {
		t.Fatal(err)
	}
	got, err := v.Credential(context.Background(), "org-a", "claim-a", binding.Host)
	if err != nil || got.Value != secret.Value {
		t.Fatal("historical value path changed")
	}
	if err = v.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	reader := externalVersionReaderFunc(func(context.Context, SecretVersionRef) (SecretVersion, error) {
		t.Error("incompatible mode contacted reader")
		return SecretVersion{}, ErrVaultUnavailable
	})
	cfg.ExternalValues, cfg.ExternalSourceID = reader, "profile-a"
	if opened, err := OpenConfiguredVault(cfg); !errors.Is(err, ErrVaultConfig) {
		if opened != nil {
			_ = opened.Close()
		}
		t.Fatal("historical state was implicitly migrated")
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("refused mode rewrote historical data")
	}
}

func TestExternalVersionRejectsMixedOrUnpinnedPersistedState(t *testing.T) {
	for _, kind := range []string{"local_record", "populated_value", "source", "format"} {
		t.Run(kind, func(t *testing.T) {
			reader := externalVersionReaderFunc(func(context.Context, SecretVersionRef) (SecretVersion, error) {
				t.Error("state validation contacted reader")
				return SecretVersion{}, ErrVaultUnavailable
			})
			cfg, value, binding := externalVersionFixture(t, reader)
			managed := registerExternalBinding(t, cfg, value, binding)
			v := managed.(*EncryptedVault)
			if err := v.enter(context.Background()); err != nil {
				t.Fatal(err)
			}
			next := v.clone()
			record := next.Versions[versionKey(value.Scope, value.ID, value.Version)]
			switch kind {
			case "local_record":
				record.External = false
			case "populated_value":
				record.Value = value.Value
			case "source":
				next.ExternalSourceID = "other-profile"
			case "format":
				next.Version = 1
			}
			next.Versions[versionKey(value.Scope, value.ID, value.Version)] = record
			err := v.save(context.Background(), next)
			v.leave()
			if err != nil {
				t.Fatal(err)
			}
			if err = v.Close(); err != nil {
				t.Fatal(err)
			}
			if opened, err := OpenConfiguredVault(cfg); !errors.Is(err, ErrVaultConfig) {
				if opened != nil {
					_ = opened.Close()
				}
				t.Fatal("mixed/unpinned external state reopened")
			}
		})
	}
}

func TestExternalVersionUnrelatedClaimWriteDoesNotInvalidateRead(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var value SecretVersion
	reader := externalVersionReaderFunc(func(ctx context.Context, _ SecretVersionRef) (SecretVersion, error) {
		close(entered)
		select {
		case <-release:
			return value, nil
		case <-ctx.Done():
			return SecretVersion{}, ctx.Err()
		}
	})
	cfg, secret, binding := externalVersionFixture(t, reader)
	value = secret
	v := registerExternalBinding(t, cfg, secret, binding)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		got, err := v.Credential(ctx, "org-a", "claim-a", binding.Host)
		if err == nil && got.Value != value.Value {
			err = ErrVaultDenied
		}
		done <- err
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("read did not start")
	}
	other := externalVersionMetadata(secret)
	other.Scope = SecretScope{OrganizationID: "org-b", EnvironmentID: "env-b"}
	err := v.RegisterExternalVersion(ctx, other)
	if err == nil {
		b := binding
		b.Scope = ClaimScope{SecretScope: other.Scope, ClaimID: "claim-b"}
		err = v.Bind(ctx, b)
	}
	close(release)
	if err != nil {
		t.Fatalf("unrelated metadata write blocked: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal("unrelated state invalidated valid read")
		}
	case <-ctx.Done():
		t.Fatal("read did not complete")
	}
}

func TestExternalVersionSignedPolicyNarrowingDuringReadIsRechecked(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var value SecretVersion
	reader := externalVersionReaderFunc(func(ctx context.Context, _ SecretVersionRef) (SecretVersion, error) {
		close(entered)
		select {
		case <-release:
			return value, nil
		case <-ctx.Done():
			return SecretVersion{}, ctx.Err()
		}
	})
	cfg, secret, binding := externalVersionFixture(t, reader)
	value = secret
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	store := policy.NewStore(cfg.Now)
	handler := (&control.Server{Policies: store, AgentKey: pub, Now: cfg.Now}).Handler()
	original := signedPolicyForBinding(binding, cfg.Now())
	installSignedPolicy(t, handler, key, original)
	cfg.Claims = PolicyClaimAuthorizer{Policies: store, Now: cfg.Now}
	v := registerExternalBinding(t, cfg, secret, binding)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		got, err := v.Credential(ctx, "org-a", "claim-a", binding.Host)
		if got.Value != "" {
			err = nil
		}
		done <- err
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("read did not start")
	}
	narrowed := original
	narrowed.CredentialHosts = nil
	installSignedPolicy(t, handler, key, narrowed)
	close(release)
	select {
	case err := <-done:
		if !errors.Is(err, ErrVaultDenied) {
			t.Fatal("signed policy narrowing did not prevent value release")
		}
	case <-ctx.Done():
		t.Fatal("read did not complete")
	}
}

// A decoded external record's intentionally empty value field must not become
// a hidden local cache on a successful read.
func TestExternalVersionReadDoesNotPopulatePersistedValue(t *testing.T) {
	var value SecretVersion
	cfg, secret, binding := externalVersionFixture(t, externalVersionReaderFunc(func(context.Context, SecretVersionRef) (SecretVersion, error) { return value, nil }))
	value = secret
	v := registerExternalBinding(t, cfg, secret, binding)
	if _, err := v.Credential(context.Background(), "org-a", "claim-a", binding.Host); err != nil {
		t.Fatal(err)
	}
	assertExternalLedgerContainsOnlyMetadata(t, v, cfg.ExternalSourceID)
	managed := v.(*EncryptedVault)
	if err := managed.enter(context.Background()); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(managed.state)
	managed.leave()
	if err != nil || bytes.Contains(raw, []byte(secret.Value)) {
		t.Fatal("external value entered serialized grant state")
	}
}

func TestExternalVersionWrappedBackendDenialsKeepSafeClassification(t *testing.T) {
	for _, sentinel := range []error{ErrVaultDenied, ErrVaultNotConfigured} {
		cfg, secret, binding := externalVersionFixture(t, externalVersionReaderFunc(func(context.Context, SecretVersionRef) (SecretVersion, error) {
			return SecretVersion{}, fmt.Errorf("synthetic-private-backend-detail: %w", sentinel)
		}))
		v := registerExternalBinding(t, cfg, secret, binding)
		got, err := v.Credential(context.Background(), "org-a", "claim-a", binding.Host)
		if err != sentinel || got.Value != "" {
			t.Fatal("wrapped denial lost safe classification or leaked backend detail")
		}
	}
}
