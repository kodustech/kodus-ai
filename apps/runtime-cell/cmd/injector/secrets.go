package main

import (
	"flag"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

// secretStoreOptions select the org secret store (OpenBao) the placeholder
// secrets read from. All empty: no store, and a host with a placeholder
// secret is refused. Partly set: the injector does not start.
type secretStoreOptions struct{ address, mount, caFile, roleIDFile, secretIDFile string }

func registerSecretStoreOptions(fs *flag.FlagSet) *secretStoreOptions {
	o := &secretStoreOptions{}
	fs.StringVar(&o.address, "openbao-addr", "", "OpenBao origin (https://host:8200) holding the org secrets")
	fs.StringVar(&o.mount, "openbao-mount", "runtime-kv", "KV v2 mount of the org secrets")
	fs.StringVar(&o.caFile, "openbao-ca", "", "CA that signs OpenBao's certificate; empty: the system roots")
	fs.StringVar(&o.roleIDFile, "openbao-role-id-file", "", "the injector's AppRole role id (0600)")
	fs.StringVar(&o.secretIDFile, "openbao-secret-id-file", "", "the injector's AppRole secret id (0600)")
	return o
}

func (o *secretStoreOptions) open() (injector.SecretStore, error) {
	if o.address == "" && o.roleIDFile == "" && o.secretIDFile == "" {
		return nil, nil //nolint:nilnil // no store configured is a valid mode: placeholder hosts are refused
	}
	if o.address == "" || o.roleIDFile == "" || o.secretIDFile == "" {
		return nil, injector.ErrVaultConfig
	}
	login := &injector.AppRoleToken{Address: o.address, RoleIDFile: o.roleIDFile, SecretIDFile: o.secretIDFile}
	if o.caFile != "" {
		roots, err := tlsutil.Pool(o.caFile)
		if err != nil {
			return nil, injector.ErrVaultConfig
		}
		login.Roots = roots
	}
	return injector.NewOpenBaoSecrets(injector.OpenBaoSecretsConfig{Address: o.address, Mount: o.mount, Roots: login.Roots, Token: login.Token})
}
