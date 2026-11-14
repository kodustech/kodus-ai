package injector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type allowVaultClaim struct{ denied bool }

func (a allowVaultClaim) AuthorizeBinding(_ context.Context, b Binding) (ClaimAuthority, error) {
	if a.denied {
		return ClaimAuthority{}, ErrVaultDenied
	}
	return ClaimAuthority{Scope: b.Scope, ExpiresAt: time.Date(2030, 1, 1, 1, 0, 0, 0, time.UTC), CredentialHosts: []string{b.Host}}, nil
}
func vaultFixture(t *testing.T) (VaultConfig, SecretVersion, Binding) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(base, "vault")
	if err = os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	key := filepath.Join(base, "owner.key")
	if err = os.WriteFile(key, bytes.Repeat([]byte{7}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	scope := SecretScope{OrganizationID: "org-a", EnvironmentID: "env-a"}
	version := SecretVersion{Scope: scope, ID: "payments", Version: 1, Value: "Bearer synthetic-owner-test-value", ExpiresAt: now.Add(2 * time.Hour)}
	binding := Binding{Scope: ClaimScope{SecretScope: scope, ClaimID: "claim-a"}, SecretID: version.ID, Version: 1, Host: "api.example.test", Header: "Authorization", ExpiresAt: now.Add(30 * time.Minute)}
	return VaultConfig{Directory: dir, KeyFile: key, CellID: "cell-a", Claims: allowVaultClaim{}, Now: func() time.Time { return now }}, version, binding
}
func TestEncryptedVaultPersistsCiphertextAndScopedLookup(t *testing.T) {
	cfg, secret, binding := vaultFixture(t)
	v, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err = v.PutVersion(ctx, secret); err != nil {
		t.Fatal(err)
	}
	if err = v.Bind(ctx, binding); err != nil {
		t.Fatal(err)
	}
	got, err := v.Credential(ctx, "org-a", "claim-a", binding.Host)
	if err != nil || got.Value != secret.Value {
		t.Fatalf("credential failed: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(cfg.Directory, "vault.json"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(secret.Value)) || bytes.Contains(raw, []byte(secret.ID)) {
		t.Fatal("plaintext escaped into persisted envelope")
	}
	if err = v.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, err = reopened.Credential(ctx, "org-b", "claim-a", binding.Host); !errors.Is(err, ErrVaultDenied) {
		t.Fatalf("cross-org lookup: %v", err)
	}
	if _, err = reopened.Credential(ctx, "org-a", "claim-b", binding.Host); !errors.Is(err, ErrVaultDenied) {
		t.Fatalf("cross-claim lookup: %v", err)
	}
	if _, err = reopened.Credential(ctx, "org-a", "claim-a", "other.example.test"); !errors.Is(err, ErrVaultDenied) {
		t.Fatalf("cross-host lookup: %v", err)
	}
	got, err = reopened.Credential(ctx, "org-a", "claim-a", binding.Host)
	if err != nil || got.Value != secret.Value {
		t.Fatalf("recovery failed: %v", err)
	}
}
func TestVaultRevocationSurvivesRestart(t *testing.T) {
	cfg, secret, binding := vaultFixture(t)
	v, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err = v.PutVersion(ctx, secret); err != nil {
		t.Fatal(err)
	}
	if err = v.Bind(ctx, binding); err != nil {
		t.Fatal(err)
	}
	if err = v.RevokeVersion(ctx, secret.Scope, secret.ID, secret.Version); err != nil {
		t.Fatal(err)
	}
	if err = v.Close(); err != nil {
		t.Fatal(err)
	}
	v, err = OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	if _, err = v.Credential(ctx, "org-a", "claim-a", binding.Host); !errors.Is(err, ErrVaultDenied) {
		t.Fatalf("revoked credential recovered: %v", err)
	}
}
func TestVaultRefusesUnconfiguredPartialAndUnsafeKey(t *testing.T) {
	v, err := OpenConfiguredVault(VaultConfig{})
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	if _, err = v.Credential(context.Background(), "org-a", "claim-a", "api.example.test"); !errors.Is(err, ErrVaultNotConfigured) {
		t.Fatalf("unconfigured: %v", err)
	}
	cfg, _, _ := vaultFixture(t)
	cfg.KeyFile = ""
	if _, err = OpenConfiguredVault(cfg); !errors.Is(err, ErrVaultConfig) {
		t.Fatalf("partial configuration: %v", err)
	}
	cfg, _, _ = vaultFixture(t)
	if err = os.Chmod(cfg.KeyFile, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = OpenConfiguredVault(cfg); !errors.Is(err, ErrVaultConfig) {
		t.Fatalf("public key file: %v", err)
	}
}
func TestVaultRequiresAuthorityAndMatchingEnvironment(t *testing.T) {
	cfg, secret, binding := vaultFixture(t)
	cfg.Claims = nil
	v, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	ctx := context.Background()
	if err = v.PutVersion(ctx, secret); err != nil {
		t.Fatal(err)
	}
	if err = v.Bind(ctx, binding); !errors.Is(err, ErrVaultDenied) {
		t.Fatalf("unconfigured authority: %v", err)
	}
}

func TestVaultRejectsWrongKeyCellAndTamperedCiphertext(t *testing.T) {
	for _, kind := range []string{"wrong_key", "wrong_cell", "tamper", "noncanonical"} {
		t.Run(kind, func(t *testing.T) {
			cfg, secret, _ := vaultFixture(t)
			v, err := OpenConfiguredVault(cfg)
			if err != nil {
				t.Fatal(err)
			}
			if err = v.PutVersion(context.Background(), secret); err != nil {
				t.Fatal(err)
			}
			v.Close()
			switch kind {
			case "wrong_key":
				if err = os.WriteFile(cfg.KeyFile, bytes.Repeat([]byte{8}, 32), 0600); err != nil {
					t.Fatal(err)
				}
			case "wrong_cell":
				cfg.CellID = "cell-b"
			case "tamper":
				p := filepath.Join(cfg.Directory, "vault.json")
				raw, _ := os.ReadFile(p)
				raw[len(raw)-8] ^= 1
				if err = os.WriteFile(p, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "noncanonical":
				p := filepath.Join(cfg.Directory, "vault.json")
				raw, _ := os.ReadFile(p)
				if err = os.WriteFile(p, append(raw, '\n'), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err = OpenConfiguredVault(cfg); !errors.Is(err, ErrVaultConfig) {
				t.Fatalf("opened unsafe vault: %v", err)
			}
		})
	}
}
func TestVaultExclusiveOwnerAndPrivatePaths(t *testing.T) {
	cfg, _, _ := vaultFixture(t)
	v, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = OpenConfiguredVault(cfg); !errors.Is(err, ErrVaultUnavailable) {
		t.Fatalf("second controller: %v", err)
	}
	if err = v.Close(); err != nil {
		t.Fatal(err)
	}
	if err = v.Close(); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"symlink_key", "symlink_dir", "public_dir", "public_store", "fifo_key", "hardlink_key"} {
		t.Run(kind, func(t *testing.T) {
			cfg, secret, _ := vaultFixture(t)
			switch kind {
			case "symlink_key":
				p := cfg.KeyFile + ".link"
				if err = os.Symlink(cfg.KeyFile, p); err != nil {
					t.Fatal(err)
				}
				cfg.KeyFile = p
			case "symlink_dir":
				p := cfg.Directory + ".link"
				if err = os.Symlink(cfg.Directory, p); err != nil {
					t.Fatal(err)
				}
				cfg.Directory = p
			case "public_dir":
				os.Chmod(cfg.Directory, 0755)
			case "public_store":
				v, err := OpenConfiguredVault(cfg)
				if err != nil {
					t.Fatal(err)
				}
				if err = v.PutVersion(context.Background(), secret); err != nil {
					t.Fatal(err)
				}
				v.Close()
				os.Chmod(filepath.Join(cfg.Directory, "vault.json"), 0644)
			case "fifo_key":
				os.Remove(cfg.KeyFile)
				if err = unix.Mkfifo(cfg.KeyFile, 0600); err != nil {
					t.Fatal(err)
				}
			case "hardlink_key":
				if err = os.Link(cfg.KeyFile, cfg.KeyFile+".copy"); err != nil {
					t.Fatal(err)
				}
			}
			if _, err = OpenConfiguredVault(cfg); !errors.Is(err, ErrVaultConfig) {
				t.Fatalf("unsafe path accepted: %v", err)
			}
		})
	}
}

type vaultAuthorityFunc func(context.Context, Binding) (ClaimAuthority, error)

func (f vaultAuthorityFunc) AuthorizeBinding(ctx context.Context, b Binding) (ClaimAuthority, error) {
	return f(ctx, b)
}
func TestVaultBindingAuthorityScopeAndTTLCannotBeSuppliedByCaller(t *testing.T) {
	for _, kind := range []string{"denied", "org", "environment", "claim", "host", "ttl", "version_ttl", "cross_environment", "reserved_header", "immutable_binding"} {
		t.Run(kind, func(t *testing.T) {
			cfg, secret, b := vaultFixture(t)
			cfg.Claims = vaultAuthorityFunc(func(ctx context.Context, b Binding) (ClaimAuthority, error) {
				a, _ := (allowVaultClaim{}).AuthorizeBinding(ctx, b)
				switch kind {
				case "denied":
					return ClaimAuthority{}, ErrVaultDenied
				case "org":
					a.Scope.OrganizationID = "org-b"
				case "environment":
					a.Scope.EnvironmentID = "env-b"
				case "claim":
					a.Scope.ClaimID = "claim-b"
				case "host":
					a.CredentialHosts = []string{"other.example.test"}
				case "ttl":
					a.ExpiresAt = b.ExpiresAt.Add(-time.Second)
				}
				return a, nil
			})
			v, err := OpenConfiguredVault(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer v.Close()
			if err = v.PutVersion(context.Background(), secret); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "version_ttl":
				b.ExpiresAt = secret.ExpiresAt.Add(time.Second)
			case "cross_environment":
				b.Scope.EnvironmentID = "env-b"
			case "reserved_header":
				b.Header = "hOsT"
			case "immutable_binding":
				if err = v.Bind(context.Background(), b); err != nil {
					t.Fatal(err)
				}
				b.Header = "X-Api-Key"
			}
			err = v.Bind(context.Background(), b)
			if !errors.Is(err, ErrVaultDenied) && !errors.Is(err, ErrVaultConflict) {
				t.Fatalf("unsafe grant accepted: %v", err)
			}
		})
	}
}
func TestVaultExpiryAndClaimRevocation(t *testing.T) {
	cfg, secret, b := vaultFixture(t)
	now := cfg.Now()
	cfg.Now = func() time.Time { return now }
	v, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err = v.PutVersion(ctx, secret); err != nil {
		t.Fatal(err)
	}
	if err = v.Bind(ctx, b); err != nil {
		t.Fatal(err)
	}
	now = b.ExpiresAt
	if _, err = v.Credential(ctx, "org-a", "claim-a", b.Host); !errors.Is(err, ErrVaultDenied) {
		t.Fatalf("expired grant: %v", err)
	}
	now = now.Add(-time.Minute)
	if err = v.RevokeClaim(ctx, b.Scope); err != nil {
		t.Fatal(err)
	}
	v.Close()
	v, err = OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	if _, err = v.Credential(ctx, "org-a", "claim-a", b.Host); !errors.Is(err, ErrVaultDenied) {
		t.Fatalf("revoked claim recovered: %v", err)
	}
	if err = v.Bind(ctx, b); !errors.Is(err, ErrVaultDenied) {
		t.Fatalf("revoked claim rebound: %v", err)
	}
}
func TestVaultUncertainRevocationFailsClosedAndRecoversCommittedState(t *testing.T) {
	cfg, secret, b := vaultFixture(t)
	managed, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	v := managed.(*EncryptedVault)
	ctx := context.Background()
	if err = v.PutVersion(ctx, secret); err != nil {
		t.Fatal(err)
	}
	if err = v.Bind(ctx, b); err != nil {
		t.Fatal(err)
	}
	v.syncDir = func() error { return errors.New("synthetic fsync failure") }
	if err = v.RevokeVersion(ctx, secret.Scope, secret.ID, secret.Version); !errors.Is(err, ErrVaultUnavailable) {
		t.Fatalf("fsync uncertainty: %v", err)
	}
	if _, err = v.Credential(ctx, "org-a", "claim-a", b.Host); !errors.Is(err, ErrVaultUnavailable) {
		t.Fatalf("uncertain state still served: %v", err)
	}
	v.Close()
	reopened, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, err = reopened.Credential(ctx, "org-a", "claim-a", b.Host); !errors.Is(err, ErrVaultDenied) {
		t.Fatalf("committed revocation lost: %v", err)
	}
}
func TestVaultCancellationDoesNotPersistOrWaitForLock(t *testing.T) {
	cfg, secret, b := vaultFixture(t)
	managed, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	v := managed.(*EncryptedVault)
	defer v.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err = v.PutVersion(ctx, secret); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled put: %v", err)
	}
	if _, err = os.Stat(filepath.Join(cfg.Directory, "vault.json")); !os.IsNotExist(err) {
		t.Fatal("cancelled put persisted")
	}
	v.gate <- struct{}{}
	_, err = v.Credential(ctx, "org-a", b.Scope.ClaimID, b.Host)
	<-v.gate
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled lookup waited: %v", err)
	}
}
func TestVaultCleansOnlyBoundedPrivatePendingFiles(t *testing.T) {
	cfg, _, _ := vaultFixture(t)
	p := filepath.Join(cfg.Directory, "pending-0123456789abcdef01234567")
	if err := os.WriteFile(p, []byte("synthetic encrypted pending"), 0600); err != nil {
		t.Fatal(err)
	}
	v, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	v.Close()
	if _, err = os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("abandoned temporary file remains")
	}
	foreign := filepath.Join(cfg.Directory, "do-not-delete")
	if err = os.WriteFile(foreign, []byte("synthetic unrelated"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = OpenConfiguredVault(cfg); !errors.Is(err, ErrVaultConfig) {
		t.Fatalf("unknown file accepted: %v", err)
	}
	if _, err = os.Stat(foreign); err != nil {
		t.Fatal("foreign file was removed")
	}
}
func TestVaultCiphertextChangesAndMetadataNeverReturnsValues(t *testing.T) {
	cfg, secret, b := vaultFixture(t)
	v, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	ctx := context.Background()
	if err = v.PutVersion(ctx, secret); err != nil {
		t.Fatal(err)
	}
	old, _ := os.ReadFile(filepath.Join(cfg.Directory, "vault.json"))
	if err = v.Bind(ctx, b); err != nil {
		t.Fatal(err)
	}
	next, _ := os.ReadFile(filepath.Join(cfg.Directory, "vault.json"))
	if bytes.Equal(old, next) {
		t.Fatal("nonce/ciphertext reused")
	}
	listed, err := v.ListVersions(ctx, secret.Scope)
	if err != nil || len(listed) != 1 {
		t.Fatalf("metadata listing failed: %v", err)
	}
	raw, _ := json.Marshal(listed)
	if bytes.Contains(raw, []byte(secret.Value)) {
		t.Fatal("metadata leaked secret")
	}
	if raw := fmt.Sprintf("%v %#v", secret, secret); strings.Contains(raw, secret.Value) {
		t.Fatal("formatted version leaked")
	}
	for _, name := range []string{"Host", "Connection", "Proxy-Authorization", "content-length", "Transfer-Encoding", "Accept-Encoding"} {
		if validHeader(name) {
			t.Fatalf("reserved header accepted: %s", name)
		}
	}
}
func TestEncryptedVaultWorksThroughInjectorAndRevocation(t *testing.T) {
	cfg, version, b := vaultFixture(t)
	version.Value = secret
	b.Host = host
	b.Scope.ClaimID = "claim-1"
	v, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	ctx := context.Background()
	if err = v.PutVersion(ctx, version); err != nil {
		t.Fatal(err)
	}
	if err = v.Bind(ctx, b); err != nil {
		t.Fatal(err)
	}
	rig := newRig(t, func(in *Injector) { in.Vault = v })
	resp, err := rig.vm.Get("https://" + host + "/echo")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal("credentialed request refused")
	}
	if (<-rig.seen).Get("Authorization") != secret {
		t.Fatal("upstream credential mismatch")
	}
	noSecret(t, "encrypted vault response", body)
	if err = v.RevokeVersion(ctx, version.Scope, version.ID, version.Version); err != nil {
		t.Fatal(err)
	}
	resp, err = rig.vm.Get("https://" + host + "/echo")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatal("revoked credential still forwarded")
	}
}

func TestVaultClaimsArePrunedAfterHardExpiryButLiveRevocationRemains(t *testing.T) {
	cfg, secret, b := vaultFixture(t)
	managed, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	v := managed.(*EncryptedVault)
	defer v.Close()
	ctx := context.Background()
	if err = v.PutVersion(ctx, secret); err != nil {
		t.Fatal(err)
	}
	if err = v.Bind(ctx, b); err != nil {
		t.Fatal(err)
	}
	if err = v.RevokeClaim(ctx, b.Scope); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxVaultClaims-1; i++ {
		scope := b.Scope
		scope.ClaimID = fmt.Sprintf("expired-%d", i)
		v.state.Claims[scope.ClaimID] = claimRecord{Scope: scope, ExpiresAt: cfg.Now().Add(-time.Second)}
	}
	other := b
	other.Scope.ClaimID = "new-claim"
	if err = v.Bind(ctx, other); err != nil {
		t.Fatalf("expired records blocked admission: %v", err)
	}
	if len(v.state.Claims) != 2 || !v.state.Claims[b.Scope.ClaimID].Revoked {
		t.Fatal("cleanup deleted live revocation or retained expired claims")
	}
}
func TestVaultBoundsImmutableVersionsAndConcurrentCalls(t *testing.T) {
	cfg, secret, _ := vaultFixture(t)
	managed, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	v := managed.(*EncryptedVault)
	defer v.Close()
	ctx := context.Background()
	if err = v.PutVersion(ctx, secret); err != nil {
		t.Fatal(err)
	}
	changed := secret
	changed.Value = "synthetic changed"
	if err = v.PutVersion(ctx, changed); !errors.Is(err, ErrVaultConflict) {
		t.Fatalf("overwrote immutable version: %v", err)
	}
	var wg sync.WaitGroup
	problems := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			item := secret
			item.ID = fmt.Sprintf("parallel-%d", i)
			if err := v.PutVersion(ctx, item); err != nil {
				problems <- err
			}
			for j := 0; j < 10; j++ {
				if _, err := v.ListVersions(ctx, secret.Scope); err != nil {
					problems <- err
					return
				}
			}
		}(i)
	}
	wg.Wait()
	close(problems)
	for err := range problems {
		t.Fatal(err)
	}
	for len(v.state.Versions) < maxVaultVersions {
		item := secret
		item.ID = fmt.Sprintf("capacity-%d", len(v.state.Versions))
		v.state.Versions[versionKey(item.Scope, item.ID, item.Version)] = versionRecord{SecretVersion: item}
	}
	extra := secret
	extra.ID = "full"
	if err = v.PutVersion(ctx, extra); !errors.Is(err, ErrVaultCapacity) {
		t.Fatalf("unbounded versions: %v", err)
	}
}
func TestVaultRefusesInvalidValuesAndCancelledAuthority(t *testing.T) {
	cfg, secret, b := vaultFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cfg.Claims = vaultAuthorityFunc(func(context.Context, Binding) (ClaimAuthority, error) {
		cancel()
		return ClaimAuthority{}, context.Canceled
	})
	v, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	for _, value := range []string{"", "contains\nnewline", string([]byte{0xff}), strings.Repeat("x", maxVaultValue+1)} {
		copy := secret
		copy.Value = value
		if err = v.PutVersion(context.Background(), copy); !errors.Is(err, ErrVaultDenied) {
			t.Fatalf("invalid value accepted: %v", err)
		}
	}
	if err = v.PutVersion(context.Background(), secret); err != nil {
		t.Fatal(err)
	}
	if err = v.Bind(ctx, b); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled authority lost: %v", err)
	}
}

func TestVaultNeverTreatsOwnerKeyAsPendingCiphertext(t *testing.T) {
	// A key named like our temporary ciphertext inside the store used to be
	// deleted by startup cleanup after it had already been read into memory.
	cfg, _, _ := vaultFixture(t)
	inside := filepath.Join(cfg.Directory, "pending-0123456789abcdef01234567")
	if err := os.Rename(cfg.KeyFile, inside); err != nil {
		t.Fatal(err)
	}
	cfg.KeyFile = inside
	v, err := OpenConfiguredVault(cfg)
	if v != nil {
		v.Close()
	}
	if !errors.Is(err, ErrVaultConfig) {
		t.Fatalf("key inside ciphertext directory accepted: %v", err)
	}
	if _, err = os.Stat(inside); err != nil {
		t.Fatal("owner key was removed")
	}
}

func TestVaultKeyIdentityRejectsCaseAliasBeforeCleanup(t *testing.T) {
	// Lexical containment does not establish ownership on case-insensitive or
	// aliased filesystems: this owner key must never be removed as pending data.
	cfg, _, _ := vaultFixture(t)
	alias := filepath.Join(filepath.Dir(cfg.Directory), strings.ToUpper(filepath.Base(cfg.Directory)))
	if _, err := os.Stat(alias); os.IsNotExist(err) {
		t.Skip("filesystem is case-sensitive")
	}
	key := filepath.Join(cfg.Directory, "pending-abcdef0123456789abcdef01")
	if err := os.Rename(cfg.KeyFile, key); err != nil {
		t.Fatal(err)
	}
	cfg.KeyFile = filepath.Join(alias, filepath.Base(key))
	v, err := OpenConfiguredVault(cfg)
	if v != nil {
		v.Close()
	}
	if !errors.Is(err, ErrVaultConfig) {
		t.Fatalf("aliased key inside store accepted: %v", err)
	}
	if _, err = os.Stat(key); err != nil {
		t.Fatal("aliased owner key was removed")
	}
}

func TestVaultCredentialRechecksCurrentAuthority(t *testing.T) {
	for _, change := range []string{"denied", "organization", "environment", "claim", "host", "shorter_hard_expiry", "longer_hard_expiry"} {
		t.Run(change, func(t *testing.T) {
			cfg, secret, b := vaultFixture(t)
			authority, _ := (allowVaultClaim{}).AuthorizeBinding(context.Background(), b)
			denied := false
			cfg.Claims = vaultAuthorityFunc(func(context.Context, Binding) (ClaimAuthority, error) {
				if denied {
					return ClaimAuthority{}, ErrVaultDenied
				}
				return authority, nil
			})
			v, err := OpenConfiguredVault(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer v.Close()
			ctx := context.Background()
			if err = v.PutVersion(ctx, secret); err != nil {
				t.Fatal(err)
			}
			if err = v.Bind(ctx, b); err != nil {
				t.Fatal(err)
			}
			switch change {
			case "denied":
				denied = true
			case "organization":
				authority.Scope.OrganizationID = "org-b"
			case "environment":
				authority.Scope.EnvironmentID = "env-b"
			case "claim":
				authority.Scope.ClaimID = "claim-b"
			case "host":
				authority.CredentialHosts = []string{"other.example.test"}
			case "shorter_hard_expiry":
				authority.ExpiresAt = authority.ExpiresAt.Add(-time.Second)
			case "longer_hard_expiry":
				authority.ExpiresAt = authority.ExpiresAt.Add(time.Second)
			}
			if _, err = v.Credential(ctx, "org-a", b.Scope.ClaimID, b.Host); !errors.Is(err, ErrVaultDenied) {
				t.Fatalf("stale authority still released a credential: %v", err)
			}
		})
	}
}

func TestVaultAuthorizerCannotMutateStoredBaits(t *testing.T) {
	cfg, version, b := vaultFixture(t)
	b.Baits = []string{bait}
	cfg.Claims = vaultAuthorityFunc(func(ctx context.Context, input Binding) (ClaimAuthority, error) {
		if len(input.Baits) > 0 {
			input.Baits[0] = "synthetic-mutated-canary"
		}
		return (allowVaultClaim{}).AuthorizeBinding(ctx, input)
	})
	vault, err := OpenConfiguredVault(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer vault.Close()
	ctx := context.Background()
	if err = vault.PutVersion(ctx, version); err != nil {
		t.Fatal(err)
	}
	if err = vault.Bind(ctx, b); err != nil {
		t.Fatal(err)
	}
	got, err := vault.Credential(ctx, "org-a", b.Scope.ClaimID, b.Host)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Baits) != 1 || got.Baits[0] != bait {
		t.Fatal("authority mutated persisted grant through shared slice")
	}
}
