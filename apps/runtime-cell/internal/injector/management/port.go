package management

import (
	"context"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
)

// VaultAdmin is the owner-local management surface. The caller retains the
// vault's lifetime, credential reads and signed-policy removal authority.
type VaultAdmin interface {
	PutVersion(context.Context, injector.SecretVersion) error
	RegisterExternalVersion(context.Context, injector.ExternalSecretVersion) error
	Bind(context.Context, injector.Binding) error
	RevokeVersion(context.Context, injector.SecretScope, string, uint64) error
	RevokeClaim(context.Context, injector.ClaimScope) error
	ListVersions(context.Context, injector.SecretScope) ([]injector.SecretVersionInfo, error)
}
