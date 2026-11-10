package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
)

func TestInjectorVaultFlagsRefuseDefaultAndPartialConfiguration(t *testing.T) {
	for _, args := range [][]string{nil, {"-vault-cell-id", "cell-a"}} {
		fs := flag.NewFlagSet("injector", flag.ContinueOnError)
		options := registerVaultOptions(fs)
		if err := fs.Parse(args); err != nil {
			t.Fatal(err)
		}
		vault, err := options.open(context.Background(), nil)
		if len(args) > 0 {
			if !errors.Is(err, injector.ErrVaultConfig) {
				t.Fatalf("partial configuration: %v", err)
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		defer vault.Close()
		if _, err = vault.Credential(context.Background(), "org-a", "claim-a", "example.test"); !errors.Is(err, injector.ErrVaultNotConfigured) {
			t.Fatalf("default vault did not refuse: %v", err)
		}
	}
}
func TestInjectorVaultFlagsSelectPrivateDurableAdapterWithoutGrantAuthority(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(base, "vault")
	if err = os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	key := filepath.Join(base, "owner.key")
	if err = os.WriteFile(key, bytes.Repeat([]byte{9}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	fs := flag.NewFlagSet("injector", flag.ContinueOnError)
	options := registerVaultOptions(fs)
	if err = fs.Parse([]string{"-vault-dir", dir, "-vault-key-file", key, "-vault-cell-id", "cell-a"}); err != nil {
		t.Fatal(err)
	}
	vault, err := options.open(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer vault.Close()
	scope := injector.SecretScope{OrganizationID: "org-a", EnvironmentID: "env-a"}
	expires := time.Now().Add(time.Hour)
	if err = vault.PutVersion(context.Background(), injector.SecretVersion{Scope: scope, ID: "test-key", Version: 1, Value: "synthetic-command-test", ExpiresAt: expires}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "vault.json"))
	if err != nil || bytes.Contains(raw, []byte("synthetic-command-test")) {
		t.Fatal("command did not select encrypted durable store")
	}
	err = vault.Bind(context.Background(), injector.Binding{Scope: injector.ClaimScope{SecretScope: scope, ClaimID: "claim-a"}, SecretID: "test-key", Version: 1, Host: "example.test", Header: "Authorization", ExpiresAt: expires})
	if !errors.Is(err, injector.ErrVaultDenied) {
		t.Fatalf("flags authorized a claim without signed authority: %v", err)
	}
}

func TestInjectorOwnerManagementRequiresConfiguredVault(t *testing.T) {
	fs := flag.NewFlagSet("injector", flag.ContinueOnError)
	options := registerVaultOptions(fs)
	if err := fs.Parse([]string{"-vault-admin-socket", "/private/owner/admin.sock"}); err != nil {
		t.Fatal(err)
	}
	if _, err := options.open(context.Background(), nil); !errors.Is(err, injector.ErrVaultConfig) {
		t.Fatalf("management without a configured vault: %v", err)
	}
}
