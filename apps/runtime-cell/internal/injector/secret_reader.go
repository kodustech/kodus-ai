package injector

import "context"

// SecretVersionRef identifies a value, not permission to use it. Callers must
// independently authorize the claim and revalidate after a remote read.
type SecretVersionRef struct {
	Scope   SecretScope
	ID      string
	Version uint64
}

// SecretVersionReader is used only inside the injector. Implementations return
// the exact identity and expiry and must never select latest or cache values.
// This port deliberately does not implement Vault's claim authorization.
type SecretVersionReader interface {
	ReadVersion(context.Context, SecretVersionRef) (SecretVersion, error)
}
