package main

import (
	"context"
	"flag"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
)

type vaultOptions struct{ directory, keyFile, cellID, adminSocket string }

func registerVaultOptions(fs *flag.FlagSet) *vaultOptions {
	options := &vaultOptions{}
	fs.StringVar(&options.directory, "vault-dir", "", "private encrypted owner-cell vault directory (0700)")
	fs.StringVar(&options.keyFile, "vault-key-file", "", "private raw 32-byte owner-cell key file (0600), outside the vault directory")
	fs.StringVar(&options.cellID, "vault-cell-id", "", "cell identity authenticated by the vault encryption")
	fs.StringVar(&options.adminSocket, "vault-admin-socket", "", "optional owner-local Unix management socket in an existing private 0700 directory")
	return options
}
func (options *vaultOptions) open(ctx context.Context, claims injector.ClaimAuthorizer) (injector.ManagedVault, error) {
	if options.adminSocket != "" && (options.directory == "" || options.keyFile == "" || options.cellID == "") {
		return nil, injector.ErrVaultConfig
	}
	// The verified policy store authorizes claim scope; owner provisioning is
	// a separate boundary. Flags never authorize a claim by themselves.
	return injector.OpenConfiguredVault(injector.VaultConfig{Directory: options.directory, KeyFile: options.keyFile, CellID: options.cellID, Context: ctx, Claims: claims})
}
